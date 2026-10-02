// Builds the C# expressions the table visualizer has the debugger evaluate. Probing vsdbg showed:
// - it evaluates C# in every frame, VB.NET frames included (it ships only the C# expression evaluator);
// - lambdas work, but extension-method syntax depends on the stopped file's `using`s, so every LINQ call here is a
//   fully qualified static call, and every type is `global::`-qualified;
// - only assemblies already loaded in the debuggee resolve. System.Text.RegularExpressions, System.Text.Json and
//   Newtonsoft.Json often aren't, so the built-in serializer uses nothing beyond mscorlib, System.Core and, for data
//   tables, System.Data;
// - lambdas in evaluated expressions are slow (about 5 s for 1,000 objects), and on .NET Framework larger ones with
//   string literals come back garbled or fail from the second evaluation on.
// So the first choice is helperExpression: one lambda-free call into a helper assembly loaded into the debuggee. The
// other expressions are the fallback when it can't be loaded, e.g. when the debuggee runs on another machine.
// Each expression yields one string: JSON text, which the extension unescapes from the C# literal and parses. Raw
// control characters inside its strings are left for the extension to escape (see parseJsonPayload).

export type ListSerializer = 'System.Text.Json' | 'Newtonsoft.Json' | 'built-in';

const LINQ = 'global::System.Linq.Enumerable';
const INVARIANT = 'global::System.Globalization.CultureInfo.InvariantCulture';
const PUBLIC_INSTANCE = 'global::System.Reflection.BindingFlags.Public | global::System.Reflection.BindingFlags.Instance';
// Lambda parameters must not collide with the frame's locals, so they all carry this prefix.
const P = '__tv';

/** A C# regular string literal for `value`. */
export function csString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/** Evaluates `source` once, binding it to `param` (typed object) for `body`, which must produce a string. */
function bind(source: string, param: string, body: string, paramType = 'object'): string {
  return `((global::System.Func<${paramType}, string>)(${param} => ${body}))((${paramType})(${source}))`;
}

/** A JSON string literal built from a non-null C# string expression. */
function jsonString(text: string): string {
  return `${csString('"')} + (${text}).Replace(${csString('\\')}, ${csString('\\\\')}).Replace(${csString('"')}, ${csString('\\"')}) + ${csString('"')}`;
}

/** Whether the value in `v` (an object) is shown as a single cell rather than expanded into columns. */
function isScalar(v: string): string {
  return `(${v} == null || ${v} is global::System.IConvertible || ${v} is global::System.IFormattable || ${v} is byte[])`;
}

/** JSON for a scalar value: null for null/DBNull, booleans as JSON booleans, everything else as invariant text. */
function scalarJson(v: string): string {
  const text = `(${v} is global::System.DateTime ? ((global::System.DateTime)${v}).ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", ${INVARIANT}) : global::System.Convert.ToString(${v}, ${INVARIANT}) ?? "")`;
  return (
    `(${v} == null || ${v} is global::System.DBNull ? "null" : ` +
    `${v} is bool ? ((bool)${v} ? "true" : "false") : ` +
    `${v} is byte[] ? ${jsonString(`"byte[" + ((byte[])${v}).Length + "]"`)} : ` +
    `${jsonString(text)})`
  );
}

/**
 * JSON for a member value inside a row. Nested objects aren't walked (a property getter that throws would fail the
 * whole evaluation); they become {"$type": ..., "$text": ...} with their type name, or their count for collections.
 * (Calling their ToString() from an evaluated lambda fails in vsdbg.)
 */
function memberJson(valueExpr: string): string {
  const v = `${P}_m`;
  const text = `(${v} is global::System.Collections.ICollection ? ${v}.GetType().Name + " (Count = " + ((global::System.Collections.ICollection)${v}).Count + ")" : ${v}.GetType().Name)`;
  const nested = `"{\\"$type\\":" + ${jsonString(`${v}.GetType().FullName ?? ${v}.GetType().Name`)} + ",\\"$text\\":" + ${jsonString(text)} + "}"`;
  return bind(valueExpr, v, `${isScalar(v)} ? ${scalarJson(v)} : ${nested}`);
}

/** JSON object of a row's public instance properties (non-indexed) and fields. */
function objectJson(e: string): string {
  const p = `${P}_p`;
  const f = `${P}_f`;
  const props = `${LINQ}.Select(${LINQ}.Where(${e}.GetType().GetProperties(${PUBLIC_INSTANCE}), ${p} => ${p}.CanRead && ${p}.GetIndexParameters().Length == 0), ${p} => ${jsonString(`${p}.Name`)} + ":" + ${memberJson(`${p}.GetValue(${e}, null)`)})`;
  const fields = `${LINQ}.Select(${e}.GetType().GetFields(${PUBLIC_INSTANCE}), ${f} => ${jsonString(`${f}.Name`)} + ":" + ${memberJson(`${f}.GetValue(${e})`)})`;
  return `"{" + string.Join(",", ${LINQ}.Concat(${props}, ${fields})) + "}"`;
}

/** {"name", "total", "columns": [{name, type}], "rows": [[cell, ...] | "deleted"]} for a DataTable expression. */
function dataTableJson(t: string, maxRows: number): string {
  const c = `${P}_c`;
  const r = `${P}_r`;
  const v = `${P}_v`;
  const columns = `${LINQ}.Select(${LINQ}.Cast<global::System.Data.DataColumn>(${t}.Columns), ${c} => "{\\"name\\":" + ${jsonString(`${c}.ColumnName`)} + ",\\"type\\":" + ${jsonString(`${c}.DataType.FullName`)} + "}")`;
  const cells = `${LINQ}.Select(${r}.ItemArray, ${v} => ${scalarJson(v)})`;
  const rows = `${LINQ}.Select(${LINQ}.Take(${LINQ}.Cast<global::System.Data.DataRow>(${t}.Rows), ${maxRows}), ${r} => ${r}.RowState == global::System.Data.DataRowState.Deleted ? "\\"deleted\\"" : "[" + string.Join(",", ${cells}) + "]")`;
  return (
    `"{\\"name\\":" + ${jsonString(`${t}.TableName`)} + ",\\"total\\":" + ${t}.Rows.Count + ` +
    `",\\"columns\\":[" + string.Join(",", ${columns}) + "],\\"rows\\":[" + string.Join(",", ${rows}) + "]}"`
  );
}

export const HELPER_TYPE = 'RemoteSshWebForm.TableVisualizer.Serializer';

/**
 * Loads the helper assembly (debuggee/Serializer.cs) from `assemblyPath` into the debuggee, if it isn't loaded yet,
 * and returns Serializer.Serialize(value, maxRows): one evaluation, no lambdas.
 */
export function helperExpression(assemblyPath: string, expression: string, maxRows: number): string {
  return (
    `(string)global::System.Reflection.Assembly.LoadFrom(${csString(assemblyPath)}).GetType(${csString(HELPER_TYPE)}).GetMethod("Serialize")` +
    `.Invoke(null, new object[] { (object)(${expression}), ${maxRows} })`
  );
}

const OBJ = `${P}_o`;

/**
 * Describes the value: null, or "<full type name>|<base>|<base of base>|<its base>|<flags>|<count>", where flags hold
 * E (IEnumerable) and D (IDictionary), and count is ICollection.Count or -1.
 */
export function typeInfoExpression(expression: string): string {
  const t = `${OBJ}.GetType()`;
  const body =
    `${OBJ} == null ? null : ${t}.FullName + "|" + ${t}.BaseType?.FullName + "|" + ${t}.BaseType?.BaseType?.FullName + "|" + ${t}.BaseType?.BaseType?.BaseType?.FullName + "|" + ` +
    `(${OBJ} is global::System.Collections.IEnumerable ? "E" : "") + (${OBJ} is global::System.Collections.IDictionary ? "D" : "") + "|" + ` +
    `(${OBJ} is global::System.Collections.ICollection ? ((global::System.Collections.ICollection)${OBJ}).Count : -1)`;
  return bind(expression, OBJ, body);
}

/** How many items a sequence without a Count has, enumerating at most `limit`. */
export function countExpression(expression: string, limit: number): string {
  return bind(expression, OBJ, `${LINQ}.Count(${LINQ}.Take(${LINQ}.Cast<object>((global::System.Collections.IEnumerable)${OBJ}), ${limit})).ToString()`);
}

export function dataTableExpression(expression: string, maxRows: number): string {
  return bind(expression, `${P}_t`, dataTableJson(`${P}_t`, maxRows), 'global::System.Data.DataTable');
}

/** A DataView is shown as the table its ToTable() returns: its rows after RowFilter and Sort. */
export function dataViewExpression(expression: string, maxRows: number): string {
  return dataTableExpression(`((global::System.Data.DataView)(${expression})).ToTable()`, maxRows);
}

/** {"name", "tables": [DataTable JSON, ...]} */
export function dataSetExpression(expression: string, maxRows: number): string {
  const ds = `${P}_ds`;
  const dt = `${P}_dt`;
  const tables = `${LINQ}.Select(${LINQ}.Cast<global::System.Data.DataTable>(${ds}.Tables), ${dt} => ${dataTableJson(dt, maxRows)})`;
  return bind(expression, ds, `"{\\"name\\":" + ${jsonString(`${ds}.DataSetName`)} + ",\\"tables\\":[" + string.Join(",", ${tables}) + "]}"`, 'global::System.Data.DataSet');
}

/** The first `maxRows` items of any IEnumerable (lists, arrays, dictionaries, LINQ queries), as a List<object>. */
function firstItems(expression: string, maxRows: number): string {
  return `${LINQ}.ToList(${LINQ}.Take(${LINQ}.Cast<object>((global::System.Collections.IEnumerable)(${expression})), ${maxRows}))`;
}

/**
 * JSON for the first `maxRows` items of any IEnumerable. With System.Text.Json or Newtonsoft.Json it is the library's
 * JSON array, from one lambda-free call: inside an evaluated lambda vsdbg refuses System.Text.Json's cycle handling
 * ("evaluation of native methods in this context is not supported") and Newtonsoft's error-handler delegate. With
 * built-in it is {"element": <runtime type of the first non-null item>, "members": {name: type}, "rows": [...]}.
 */
export function listExpression(expression: string, maxRows: number, serializer: ListSerializer): string {
  if (serializer === 'System.Text.Json') {
    return (
      `global::System.Text.Json.JsonSerializer.Serialize(${firstItems(expression, maxRows)}, new global::System.Text.Json.JsonSerializerOptions { ` +
      'ReferenceHandler = global::System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles, IncludeFields = true, MaxDepth = 32, ' +
      'NumberHandling = global::System.Text.Json.Serialization.JsonNumberHandling.AllowNamedFloatingPointLiterals })'
    );
  }
  if (serializer === 'Newtonsoft.Json') {
    return (
      `global::Newtonsoft.Json.JsonConvert.SerializeObject(${firstItems(expression, maxRows)}, new global::Newtonsoft.Json.JsonSerializerSettings { ` +
      'ReferenceLoopHandling = global::Newtonsoft.Json.ReferenceLoopHandling.Ignore })'
    );
  }
  const list = `${P}_l`;
  const first = `${P}_e`;
  const p = `${P}_p`;
  const x = `${P}_x`;
  const members = `"{" + string.Join(",", ${LINQ}.Concat(${LINQ}.Select(${LINQ}.Where(${first}.GetType().GetProperties(${PUBLIC_INSTANCE}), ${p} => ${p}.CanRead && ${p}.GetIndexParameters().Length == 0), ${p} => ${jsonString(`${p}.Name`)} + ":" + ${jsonString(`${p}.PropertyType.FullName ?? ${p}.PropertyType.Name`)}), ${LINQ}.Select(${first}.GetType().GetFields(${PUBLIC_INSTANCE}), ${p} => ${jsonString(`${p}.Name`)} + ":" + ${jsonString(`${p}.FieldType.FullName ?? ${p}.FieldType.Name`)}))) + "}"`;
  const schema = bind(
    `${LINQ}.FirstOrDefault(${list}, ${x} => ${x} != null)`,
    first,
    `${first} == null ? "\\"element\\":null,\\"members\\":{}" : "\\"element\\":" + ${jsonString(`${first}.GetType().FullName ?? ${first}.GetType().Name`)} + ",\\"members\\":" + (${isScalar(first)} ? "{}" : ${members})`,
  );
  const e = `${P}_i`;
  const rows = `"[" + string.Join(",", ${LINQ}.Select(${list}, ${e} => ${isScalar(e)} ? ${scalarJson(e)} : ${objectJson(e)})) + "]"`;
  return bind(firstItems(expression, maxRows), list, `"{" + ${schema} + ",\\"rows\\":" + ${rows} + "}"`, 'global::System.Collections.Generic.List<object>');
}
