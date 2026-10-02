// Turns the debugger's evaluate results into table data. Nothing here touches the 'vscode' API, so it's unit-tested.

export interface Column {
  name: string;
  /** CLR type name, when known. */
  type?: string;
}

export interface TableData {
  name: string;
  columns: Column[];
  /** Positional cells; null for a null item among objects, "deleted" for a deleted DataRow. */
  rows: Row[];
  /** The item count in the debuggee, or undefined when the sequence has no Count and has more than `rows`. */
  total: number | undefined;
}

export type Row = unknown[] | null | 'deleted';

export type ValueKind = 'datatable' | 'dataset' | 'dataview' | 'dictionary' | 'array' | 'list';

export interface TypeInfo {
  fullName: string;
  baseTypes: string[];
  enumerable: boolean;
  dictionary: boolean;
  /** ICollection.Count, or undefined when it isn't an ICollection. */
  count: number | undefined;
}

/** What the debug adapter returned for an evaluate request. */
export interface EvaluateResponse {
  result: string;
  type?: string;
  variablesReference?: number;
}

export type Evaluated =
  | { kind: 'value'; value: string; type: string | undefined }
  | { kind: 'compileError'; message: string }
  | { kind: 'exception'; exceptionType: string; message: string };

/**
 * vsdbg reports failures as successful responses: compile errors as "error CS0103: ..." with no type, exceptions as
 * "'expr' threw an exception of type 'System.X'" with type "T {System.X}".
 */
export function classifyEvaluateResponse(response: EvaluateResponse): Evaluated {
  const result = response.result ?? '';
  if (/^error CS\d+:/.test(result) || (!response.type && /^error\b/i.test(result))) return { kind: 'compileError', message: result };
  const thrown = /threw an exception of type '([^']+)'/.exec(result);
  if (thrown && (response.type === undefined || response.type.includes(`{${thrown[1]}}`))) {
    return { kind: 'exception', exceptionType: thrown[1], message: result };
  }
  return { kind: 'value', value: result, type: response.type };
}

/** Whether a compile error means a type or assembly isn't loaded in the debuggee (so a serializer can't be used). */
export function isMissingTypeError(message: string): boolean {
  return /error CS(0234|0246|0400|0012):/.test(message);
}

/**
 * Decodes a string value as the debugger displays it: `null`, or a C# literal in double quotes with escapes. Returns
 * undefined when the text isn't a complete literal (e.g. the debugger truncated it).
 */
export function unescapeCSharpString(display: string): string | null | undefined {
  const text = display.trim();
  if (text === 'null') return null;
  let start = 0;
  if (text.startsWith('@"')) {
    if (!text.endsWith('"') || text.length < 3) return undefined;
    return text.slice(2, -1).replace(/""/g, '"');
  }
  if (text[start] !== '"' || text.length < 2) return undefined;
  start++;
  let out = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') return i === text.length - 1 ? out : undefined;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[++i];
    switch (next) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case '0': out += '\0'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case 'e': out += '\x1b'; break;
      case 'u': {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      case 'U': {
        const hex = text.slice(i + 1, i + 9);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) return undefined;
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 8;
        break;
      }
      case 'x': {
        const hex = /^[0-9a-fA-F]{1,4}/.exec(text.slice(i + 1))?.[0];
        if (!hex) return undefined;
        out += String.fromCharCode(parseInt(hex, 16));
        i += hex.length;
        break;
      }
      case undefined:
        return undefined;
      default:
        // \" \\ \' and anything unknown stand for the character itself.
        out += next;
    }
  }
  return undefined;
}

/** Parses the JSON the serializer expressions build. Their strings may hold raw control characters, which JSON forbids. */
export function parseJsonPayload(text: string): unknown {
  return JSON.parse(text.replace(/[\u0000-\u001f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

export function parseTypeInfo(text: string): TypeInfo {
  const parts = text.split('|');
  if (parts.length < 6) throw new Error(`Unexpected type information from the debugger: ${text}`);
  const count = Number(parts[5]);
  return {
    fullName: parts[0],
    baseTypes: parts.slice(1, 4).filter(Boolean),
    enumerable: parts[4].includes('E'),
    dictionary: parts[4].includes('D'),
    count: Number.isInteger(count) && count >= 0 ? count : undefined,
  };
}

/** How to show a value, or undefined when it isn't something a table can show. */
export function kindOf(info: TypeInfo): ValueKind | undefined {
  const names = [info.fullName, ...info.baseTypes];
  if (names.includes('System.Data.DataTable')) return 'datatable';
  if (names.includes('System.Data.DataSet')) return 'dataset';
  if (names.includes('System.Data.DataView')) return 'dataview';
  if (info.fullName === 'System.String' || !info.enumerable) return undefined;
  if (info.dictionary || /^System\.Collections\.Generic\.(IReadOnly)?Dictionary`2|KeyValuePair`2/.test(info.fullName)) return 'dictionary';
  if (info.fullName.endsWith(']') && info.baseTypes.includes('System.Array')) return 'array';
  return 'list';
}

interface TablePayload {
  name: string;
  total: number | null;
  columns: { name: string; type?: string }[];
  rows: Row[];
}

export function tableFromDataTablePayload(payload: unknown, defaultName = 'Table'): TableData {
  const p = payload as TablePayload;
  if (!p || !Array.isArray(p.columns) || !Array.isArray(p.rows)) throw new Error('Unexpected table data from the debugger.');
  return {
    name: p.name || defaultName,
    columns: p.columns.map(c => (c.type ? { name: c.name, type: c.type } : { name: c.name })),
    rows: p.rows,
    total: typeof p.total === 'number' ? p.total : undefined,
  };
}

export type HelperResult =
  | { kind: ValueKind; type: string; tables: TableData[] }
  | { kind: 'null' }
  | { kind: 'unsupported'; type: string }
  | { kind: 'error'; error: string };

/** Reads the helper assembly's JSON (see debuggee/Serializer.cs). Sequences' tables are named after `typeName(type)`. */
export function parseHelperPayload(payload: unknown, typeName: (fullName: string) => string): HelperResult {
  const p = payload as { kind?: string; type?: string; tables?: unknown[]; error?: string };
  if (!p || typeof p !== 'object') throw new Error('Unexpected data from the helper assembly.');
  if (typeof p.error === 'string') return { kind: 'error', error: p.error };
  if (p.kind === 'null') return { kind: 'null' };
  if (p.kind === 'unsupported') return { kind: 'unsupported', type: p.type ?? '' };
  const kinds: ValueKind[] = ['datatable', 'dataset', 'dataview', 'dictionary', 'array', 'list'];
  if (!kinds.includes(p.kind as ValueKind) || !Array.isArray(p.tables)) throw new Error('Unexpected data from the helper assembly.');
  const type = p.type ?? '';
  return { kind: p.kind as ValueKind, type, tables: p.tables.map(t => tableFromDataTablePayload(t, typeName(type))) };
}

export function tablesFromDataSetPayload(payload: unknown): { name: string; tables: TableData[] } {
  const p = payload as { name: string; tables: unknown[] };
  if (!p || !Array.isArray(p.tables)) throw new Error('Unexpected DataSet data from the debugger.');
  return { name: p.name, tables: p.tables.map(t => tableFromDataTablePayload(t)) };
}

interface ListPayload {
  element: string | null;
  members: Record<string, string>;
  rows: unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lays a sequence out as a table. Objects become one column per member (in order of first appearance); scalars and
 * arrays go in a "Value" column. `total` is the debuggee's count, if known.
 */
export function tableFromListPayload(payload: unknown, name: string, total: number | undefined): TableData {
  const p = payload as ListPayload;
  if (!p || !Array.isArray(p.rows)) throw new Error('Unexpected collection data from the debugger.');
  const members = p.members ?? {};
  const names: string[] = [];
  const seen = new Set<string>();
  let hasScalars = false;
  for (const row of p.rows) {
    if (!isPlainObject(row)) {
      hasScalars = true;
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  const valueColumn = hasScalars ? uniqueName('Value', seen) : undefined;
  const columns: Column[] = names.map(n => ({ name: n, type: members[n] }));
  if (valueColumn) columns.unshift({ name: valueColumn, type: names.length === 0 && p.element ? p.element : undefined });
  const rows = p.rows.map(row => {
    const cells = names.map(n => (isPlainObject(row) && n in row ? row[n] : undefined));
    if (valueColumn) cells.unshift(isPlainObject(row) ? undefined : row);
    return cells;
  });
  return { name, columns, rows, total };
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  return name;
}

const KEYWORDS: Record<string, string> = {
  'System.Boolean': 'bool',
  'System.Byte': 'byte',
  'System.SByte': 'sbyte',
  'System.Char': 'char',
  'System.Decimal': 'decimal',
  'System.Double': 'double',
  'System.Single': 'float',
  'System.Int16': 'short',
  'System.Int32': 'int',
  'System.Int64': 'long',
  'System.UInt16': 'ushort',
  'System.UInt32': 'uint',
  'System.UInt64': 'ulong',
  'System.Object': 'object',
  'System.String': 'string',
};

/**
 * A readable C# name for a reflection full name, e.g.
 * "System.Collections.Generic.List`1[[System.Int32, mscorlib, ...]]" -> "List<int>".
 * Namespaces are dropped, except that nested types keep their declaring type (Outer.Inner).
 */
export function friendlyTypeName(fullName: string): string {
  let pos = 0;
  const parseType = (): string => {
    let name = '';
    while (pos < fullName.length && !'[],'.includes(fullName[pos])) name += fullName[pos++];
    name = name.trim();
    const args: string[] = [];
    // Generic arguments: [[Arg, Assembly...],[Arg, ...]]
    if (fullName[pos] === '[' && fullName[pos + 1] === '[') {
      pos++;
      while (fullName[pos] === '[') {
        pos++;
        args.push(parseType());
        // Skip the assembly-qualification up to the closing bracket of this argument.
        let depth = 0;
        while (pos < fullName.length && !(fullName[pos] === ']' && depth === 0)) {
          if (fullName[pos] === '[') depth++;
          else if (fullName[pos] === ']') depth--;
          pos++;
        }
        pos++;
        if (fullName[pos] === ',') pos++;
      }
      pos++;
    }
    let suffix = '';
    while (fullName[pos] === '[') {
      const end = fullName.indexOf(']', pos);
      if (end < 0) break;
      suffix += fullName.slice(pos, end + 1);
      pos = end + 1;
    }
    return format(name, args) + suffix;
  };
  return parseType();
}

function format(name: string, args: string[]): string {
  if (KEYWORDS[name]) return KEYWORDS[name];
  if (name === 'System.Nullable`1' && args.length === 1) return `${args[0]}?`;
  const simple = name.slice(name.lastIndexOf('.') + 1).replace(/\+/g, '.').replace(/`\d+/g, '');
  return args.length > 0 ? `${simple}<${args.join(', ')}>` : simple;
}
