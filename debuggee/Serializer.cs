using System;
using System.Collections;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;

namespace RemoteSshWebForm.TableVisualizer
{
    /// <summary>
    /// Reads a value of the debugged program into JSON for VS Code's "Visualize as Table". The extension loads this
    /// assembly into the debuggee and calls <see cref="Serialize"/> through reflection from a single debugger
    /// evaluation. Doing the work here, as compiled code, is much faster than in expressions the debugger compiles,
    /// sidesteps the .NET Framework evaluator's trouble with lambdas, and lets each cell catch its own exceptions.
    /// </summary>
    public static class Serializer
    {
        /// <returns>
        /// {"kind", "type", "tables": [{"name", "total", "columns": [{"name", "type"}], "rows": [...]}]}, where a row is
        /// an array of cells, null (a null item) or "deleted" (a deleted DataRow), and total is null when a sequence
        /// without a Count has more than maxRows items. Otherwise {"kind": "null"}, {"kind": "unsupported", "type"} or
        /// {"error"}. Scalars are strings (numbers in invariant format), booleans and nulls; nested objects are JSON
        /// objects and arrays; {"$type", "$text"} stands in for what isn't expanded (cycles, depth, exceptions).
        /// </returns>
        public static string Serialize(object value, int maxRows)
        {
            var json = new StringBuilder();
            try
            {
                new Writer(json, Math.Max(0, maxRows)).WriteRoot(value);
            }
            catch (Exception e)
            {
                json.Length = 0;
                json.Append("{\"error\":");
                Writer.WriteString(json, e.GetType().FullName + ": " + e.Message);
                json.Append('}');
            }
            return json.ToString();
        }
    }

    internal sealed class Writer
    {
        /// <summary>Nesting levels expanded inside a cell.</summary>
        private const int MaxDepth = 3;

        /// <summary>Items written of a collection inside a cell.</summary>
        private const int MaxNestedItems = 50;

        /// <summary>Characters kept of a long string.</summary>
        private const int MaxStringLength = 10000;

        private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

        private readonly StringBuilder json;
        private readonly int maxRows;
        private readonly Dictionary<Type, Member[]> membersByType = new Dictionary<Type, Member[]>();

        /// <summary>The objects being written, to stop at reference cycles.</summary>
        private readonly List<object> path = new List<object>();

        public Writer(StringBuilder json, int maxRows)
        {
            this.json = json;
            this.maxRows = maxRows;
        }

        public int MaxRows
        {
            get { return maxRows; }
        }

        public void WriteRoot(object value)
        {
            if (value == null)
            {
                json.Append("{\"kind\":\"null\"}");
                return;
            }
            var type = value.GetType();
            string kind;
            if (DerivesFrom(type, "System.Data.DataTable")) kind = "datatable";
            else if (DerivesFrom(type, "System.Data.DataSet")) kind = "dataset";
            else if (DerivesFrom(type, "System.Data.DataView")) kind = "dataview";
            else if (value is string || !(value is IEnumerable)) kind = null;
            else if (IsDictionary(type)) kind = "dictionary";
            else if (type.IsArray) kind = "array";
            else kind = "list";

            json.Append("{\"kind\":");
            WriteString(json, kind ?? "unsupported");
            json.Append(",\"type\":");
            WriteString(json, type.FullName ?? type.Name);
            if (kind != null)
            {
                json.Append(",\"tables\":[");
                if (kind == "datatable") DataWriter.WriteTable(this, value);
                else if (kind == "dataset") DataWriter.WriteDataSet(this, value);
                else if (kind == "dataview") DataWriter.WriteView(this, value);
                else WriteSequence((IEnumerable)value);
                json.Append(']');
            }
            json.Append('}');
        }

        private void WriteSequence(IEnumerable sequence)
        {
            var items = new List<object>();
            int? total = sequence is ICollection ? ((ICollection)sequence).Count : (int?)null;
            var enumerator = sequence.GetEnumerator();
            try
            {
                while (items.Count < maxRows && enumerator.MoveNext()) items.Add(enumerator.Current);
                if (total == null) total = items.Count < maxRows || !enumerator.MoveNext() ? items.Count : (int?)null;
            }
            finally
            {
                var disposable = enumerator as IDisposable;
                if (disposable != null) disposable.Dispose();
            }

            object first = items.Find(item => item != null);
            if (first != null && DerivesFrom(first.GetType(), "System.Data.DataRow") && items.TrueForAll(item => item == null || DerivesFrom(item.GetType(), "System.Data.DataRow")))
            {
                // e.g. the result of DataTable.Select(): show the rows' columns rather than DataRow's properties.
                DataWriter.WriteRows(this, items, total);
                return;
            }

            // Objects get a column per member, in order of first appearance; scalars go in a "Value" column.
            var columns = new List<Member>();
            var columnIndex = new Dictionary<string, int>();
            bool anyScalar = false, anyObject = false;
            foreach (var item in items)
            {
                if (item == null) continue;
                if (IsScalar(item))
                {
                    anyScalar = true;
                    continue;
                }
                anyObject = true;
                foreach (var member in MembersOf(item.GetType()))
                {
                    if (columnIndex.ContainsKey(member.Name)) continue;
                    columnIndex[member.Name] = columns.Count;
                    columns.Add(member);
                }
            }
            bool valueColumn = anyScalar || !anyObject;
            string valueName = "Value";
            for (int n = 2; columnIndex.ContainsKey(valueName); n++) valueName = "Value" + n;

            json.Append("{\"name\":\"\",\"total\":");
            json.Append(total.HasValue ? total.Value.ToString(Invariant) : "null");
            json.Append(",\"columns\":[");
            bool comma = false;
            if (valueColumn)
            {
                WriteColumn(valueName, anyObject || first == null ? null : first.GetType());
                comma = true;
            }
            foreach (var column in columns)
            {
                if (comma) json.Append(',');
                WriteColumn(column.Name, column.Type);
                comma = true;
            }
            json.Append("],\"rows\":[");
            for (int i = 0; i < items.Count; i++)
            {
                if (i > 0) json.Append(',');
                var item = items[i];
                if (item == null && anyObject)
                {
                    json.Append("null");
                    continue;
                }
                json.Append('[');
                bool scalar = item == null || IsScalar(item);
                if (valueColumn)
                {
                    if (scalar) WriteValue(item, 0);
                    else json.Append("null");
                }
                Member[] members = scalar ? null : MembersOf(item.GetType());
                for (int c = 0; c < columns.Count; c++)
                {
                    if (valueColumn || c > 0) json.Append(',');
                    Member member = members == null ? null : Array.Find(members, m => m.Name == columns[c].Name);
                    if (member == null) json.Append("null");
                    else WriteMember(item, member, 0);
                }
                json.Append(']');
            }
            json.Append("]}");
        }

        public void WriteColumn(string name, Type type)
        {
            json.Append("{\"name\":");
            WriteString(json, name);
            if (type != null)
            {
                json.Append(",\"type\":");
                WriteString(json, type.FullName ?? type.Name);
            }
            json.Append('}');
        }

        public void Raw(string text)
        {
            json.Append(text);
        }

        public void String(string text)
        {
            WriteString(json, text);
        }

        /// <summary>Writes a cell or nested value.</summary>
        public void WriteValue(object value, int depth)
        {
            if (value == null || value is DBNull)
            {
                json.Append("null");
                return;
            }
            if (value is bool)
            {
                json.Append((bool)value ? "true" : "false");
                return;
            }
            var type = value.GetType();
            if (IsScalar(value))
            {
                string text;
                try
                {
                    text = ScalarText(value);
                }
                catch (Exception e)
                {
                    WriteThrew(e, "ToString");
                    return;
                }
                if (text == null) json.Append("null");
                else WriteString(json, text);
                return;
            }
            if (value is byte[])
            {
                WriteStandIn(type, "byte[" + ((byte[])value).Length.ToString(Invariant) + "]");
                return;
            }
            if (path.Exists(o => ReferenceEquals(o, value)))
            {
                WriteStandIn(type, "(cycle) " + ShortName(type));
                return;
            }
            if (depth >= MaxDepth || IsDataType(type))
            {
                WriteStandIn(type, Summary(value));
                return;
            }

            path.Add(value);
            try
            {
                if (value is IDictionary) WriteDictionary((IDictionary)value, depth);
                else if (value is IEnumerable) WriteArray((IEnumerable)value, depth);
                else WriteObject(value, depth);
            }
            finally
            {
                path.RemoveAt(path.Count - 1);
            }
        }

        private void WriteObject(object value, int depth)
        {
            json.Append('{');
            bool comma = false;
            foreach (var member in MembersOf(value.GetType()))
            {
                if (comma) json.Append(',');
                WriteString(json, member.Name);
                json.Append(':');
                WriteMember(value, member, depth + 1);
                comma = true;
            }
            json.Append('}');
        }

        private void WriteMember(object owner, Member member, int depth)
        {
            object value;
            try
            {
                value = member.Get(owner);
            }
            catch (Exception e)
            {
                WriteThrew(e, member.Name);
                return;
            }
            WriteValue(value, depth);
        }

        private void WriteDictionary(IDictionary dictionary, int depth)
        {
            json.Append('[');
            int count = 0;
            var enumerator = dictionary.GetEnumerator();
            try
            {
                while (enumerator.MoveNext())
                {
                    if (count > 0) json.Append(',');
                    if (count == MaxNestedItems)
                    {
                        WriteMore(dictionary.Count - count);
                        break;
                    }
                    json.Append("{\"Key\":");
                    WriteValue(enumerator.Key, depth + 1);
                    json.Append(",\"Value\":");
                    WriteValue(enumerator.Value, depth + 1);
                    json.Append('}');
                    count++;
                }
            }
            catch (Exception e)
            {
                if (count > 0) json.Append(',');
                WriteThrew(e, "enumerating");
            }
            json.Append(']');
        }

        private void WriteArray(IEnumerable sequence, int depth)
        {
            json.Append('[');
            int count = 0;
            var enumerator = sequence.GetEnumerator();
            try
            {
                while (enumerator.MoveNext())
                {
                    if (count > 0) json.Append(',');
                    if (count == MaxNestedItems)
                    {
                        WriteMore(sequence is ICollection ? ((ICollection)sequence).Count - count : -1);
                        break;
                    }
                    WriteValue(enumerator.Current, depth + 1);
                    count++;
                }
            }
            catch (Exception e)
            {
                if (count > 0) json.Append(',');
                WriteThrew(e, "enumerating");
            }
            finally
            {
                var disposable = enumerator as IDisposable;
                if (disposable != null) disposable.Dispose();
            }
            json.Append(']');
        }

        private void WriteMore(int remaining)
        {
            WriteString(json, remaining > 0 ? "… " + remaining.ToString(Invariant) + " more" : "… more");
        }

        private void WriteThrew(Exception e, string what)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            WriteStandIn(inner.GetType(), "(" + what + " threw " + inner.GetType().Name + ": " + inner.Message + ")");
        }

        private void WriteStandIn(Type type, string text)
        {
            json.Append("{\"$type\":");
            WriteString(json, type.FullName ?? type.Name);
            json.Append(",\"$text\":");
            WriteString(json, text);
            json.Append('}');
        }

        private static string Summary(object value)
        {
            var type = value.GetType();
            if (DerivesFrom(type, "System.Data.DataTable") || DerivesFrom(type, "System.Data.DataView") || DerivesFrom(type, "System.Data.DataSet"))
            {
                return DataWriter.Summary(value);
            }
            return value is ICollection ? ShortName(type) + " (Count = " + ((ICollection)value).Count.ToString(Invariant) + ")" : ShortName(type);
        }

        private static string ShortName(Type type)
        {
            var name = type.Name;
            int tick = name.IndexOf('`');
            return tick > 0 ? name.Substring(0, tick) : name;
        }

        private Member[] MembersOf(Type type)
        {
            Member[] members;
            if (membersByType.TryGetValue(type, out members)) return members;
            var list = new List<Member>();
            var names = new HashSet<string>();
            foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                // A property hidden with "new" appears once per declaring type; the first is the most derived.
                if (property.CanRead && property.GetIndexParameters().Length == 0 && property.GetGetMethod() != null && names.Add(property.Name))
                {
                    list.Add(new Member(property));
                }
            }
            foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                if (names.Add(field.Name)) list.Add(new Member(field));
            }
            members = list.ToArray();
            membersByType[type] = members;
            return members;
        }

        private static bool IsScalar(object value)
        {
            return value is string || value is IConvertible || value is IFormattable || value is Type || value is Version || value is Uri;
        }

        private static string ScalarText(object value)
        {
            var text = value as string;
            if (text != null) return text.Length > MaxStringLength ? text.Substring(0, MaxStringLength) + "… (" + text.Length.ToString(Invariant) + " characters)" : text;
            if (value is DateTime) return ((DateTime)value).ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", Invariant);
            if (value is DateTimeOffset) return ((DateTimeOffset)value).ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF zzz", Invariant);
            if (value is double) return ((double)value).ToString("R", Invariant);
            if (value is float) return ((float)value).ToString("R", Invariant);
            if (value is Enum) return value.ToString();
            if (value is IConvertible) return ((IConvertible)value).ToString(Invariant);
            if (value is IFormattable) return ((IFormattable)value).ToString(null, Invariant);
            if (value is Type) return ((Type)value).FullName ?? ((Type)value).Name;
            return value.ToString();
        }

        private static bool IsDictionary(Type type)
        {
            if (typeof(IDictionary).IsAssignableFrom(type)) return true;
            foreach (var i in type.GetInterfaces())
            {
                if (!i.IsGenericType) continue;
                var name = i.GetGenericTypeDefinition().FullName;
                if (name == "System.Collections.Generic.IDictionary`2" || name == "System.Collections.Generic.IReadOnlyDictionary`2") return true;
            }
            return false;
        }

        private static bool IsDataType(Type type)
        {
            return DerivesFrom(type, "System.Data.DataTable") || DerivesFrom(type, "System.Data.DataSet") || DerivesFrom(type, "System.Data.DataView");
        }

        /// <summary>Compares by name, so checking for System.Data types doesn't load System.Data.</summary>
        internal static bool DerivesFrom(Type type, string fullName)
        {
            for (var t = type; t != null; t = t.BaseType)
            {
                if (t.FullName == fullName) return true;
            }
            return false;
        }

        internal static void WriteString(StringBuilder json, string text)
        {
            json.Append('"');
            foreach (char c in text)
            {
                switch (c)
                {
                    case '"': json.Append("\\\""); break;
                    case '\\': json.Append("\\\\"); break;
                    case '\n': json.Append("\\n"); break;
                    case '\r': json.Append("\\r"); break;
                    case '\t': json.Append("\\t"); break;
                    default:
                        if (c < ' ' || c == (char)0x2028 || c == (char)0x2029) json.Append("\\u").Append(((int)c).ToString("x4", Invariant));
                        else json.Append(c);
                        break;
                }
            }
            json.Append('"');
        }
    }

    internal sealed class Member
    {
        private readonly PropertyInfo property;
        private readonly FieldInfo field;

        public Member(PropertyInfo property)
        {
            this.property = property;
        }

        public Member(FieldInfo field)
        {
            this.field = field;
        }

        public string Name
        {
            get { return property != null ? property.Name : field.Name; }
        }

        public Type Type
        {
            get { return property != null ? property.PropertyType : field.FieldType; }
        }

        public object Get(object owner)
        {
            return property != null ? property.GetValue(owner, null) : field.GetValue(owner);
        }
    }

    /// <summary>
    /// The System.Data parts. Kept apart, and not inlined, so System.Data is loaded only when the value really is a
    /// DataTable, DataSet, DataView or DataRow.
    /// </summary>
    internal static class DataWriter
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static void WriteTable(Writer w, object value)
        {
            var table = (DataTable)value;
            WriteTableStart(w, table.TableName, table.Rows.Count, table.Columns);
            int count = Math.Min(table.Rows.Count, w.MaxRows);
            for (int i = 0; i < count; i++)
            {
                if (i > 0) w.Raw(",");
                WriteRow(w, table.Rows[i], table.Columns.Count);
            }
            w.Raw("]}");
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        public static void WriteDataSet(Writer w, object value)
        {
            var dataSet = (DataSet)value;
            for (int t = 0; t < dataSet.Tables.Count; t++)
            {
                if (t > 0) w.Raw(",");
                WriteTable(w, dataSet.Tables[t]);
            }
        }

        /// <summary>A DataView shows its rows after RowFilter and Sort, in its row version.</summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static void WriteView(Writer w, object value)
        {
            var view = (DataView)value;
            var table = view.Table;
            if (table == null)
            {
                w.Raw("{\"name\":\"\",\"total\":0,\"columns\":[],\"rows\":[]}");
                return;
            }
            WriteTableStart(w, table.TableName, view.Count, table.Columns);
            int count = Math.Min(view.Count, w.MaxRows);
            for (int i = 0; i < count; i++)
            {
                if (i > 0) w.Raw(",");
                var row = view[i];
                w.Raw("[");
                for (int c = 0; c < table.Columns.Count; c++)
                {
                    if (c > 0) w.Raw(",");
                    w.WriteValue(row[c], 0);
                }
                w.Raw("]");
            }
            w.Raw("]}");
        }

        /// <summary>A sequence of DataRows, such as DataTable.Select()'s result, laid out by the first row's table.</summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static void WriteRows(Writer w, List<object> items, int? total)
        {
            var first = (DataRow)items.Find(item => item != null);
            var columns = first.Table.Columns;
            WriteTableStart(w, first.Table.TableName, total, columns);
            for (int i = 0; i < items.Count; i++)
            {
                if (i > 0) w.Raw(",");
                var row = (DataRow)items[i];
                if (row == null) w.Raw("null");
                else WriteRow(w, row, columns.Count);
            }
            w.Raw("]}");
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        public static string Summary(object value)
        {
            var table = value as DataTable;
            if (table != null) return "DataTable " + table.TableName + " (" + table.Rows.Count.ToString(CultureInfo.InvariantCulture) + " rows)";
            var view = value as DataView;
            if (view != null) return "DataView (" + view.Count.ToString(CultureInfo.InvariantCulture) + " rows)";
            var dataSet = (DataSet)value;
            return "DataSet " + dataSet.DataSetName + " (" + dataSet.Tables.Count.ToString(CultureInfo.InvariantCulture) + " tables)";
        }

        private static void WriteTableStart(Writer w, string name, int? total, DataColumnCollection columns)
        {
            w.Raw("{\"name\":");
            w.String(name ?? "");
            w.Raw(",\"total\":" + (total.HasValue ? total.Value.ToString(CultureInfo.InvariantCulture) : "null") + ",\"columns\":[");
            for (int c = 0; c < columns.Count; c++)
            {
                if (c > 0) w.Raw(",");
                w.WriteColumn(columns[c].ColumnName, columns[c].DataType);
            }
            w.Raw("],\"rows\":[");
        }

        private static void WriteRow(Writer w, DataRow row, int columnCount)
        {
            if (row.RowState == DataRowState.Deleted)
            {
                w.Raw("\"deleted\"");
                return;
            }
            w.Raw("[");
            for (int c = 0; c < columnCount; c++)
            {
                if (c > 0) w.Raw(",");
                w.WriteValue(row[c], 0);
            }
            w.Raw("]");
        }
    }
}
