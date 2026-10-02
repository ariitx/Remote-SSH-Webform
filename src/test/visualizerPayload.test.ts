import * as assert from 'assert/strict';
import { describe, test } from 'node:test';
import {
  classifyEvaluateResponse,
  friendlyTypeName,
  isMissingTypeError,
  kindOf,
  parseHelperPayload,
  parseJsonPayload,
  parseTypeInfo,
  tableFromDataTablePayload,
  tableFromListPayload,
  unescapeCSharpString,
} from '../visualizer/payload';

describe('unescapeCSharpString', () => {
  test('decodes the literals vsdbg returns', () => {
    // As seen from vsdbg for "Line\nbreak\tand \\ backslash".
    assert.equal(unescapeCSharpString('"Line\\nbreak\\tand \\\\ backslash"'), 'Line\nbreak\tand \\ backslash');
    assert.equal(unescapeCSharpString('"say \\"hi\\""'), 'say "hi"');
    assert.equal(unescapeCSharpString('""'), '');
    assert.equal(unescapeCSharpString('"ünïcødé 🎉"'), 'ünïcødé 🎉');
  });

  test('decodes every C# escape', () => {
    assert.equal(unescapeCSharpString('"\\0\\a\\b\\f\\v\\r\\e\\\'"'), "\0\x07\b\f\v\r\x1b'");
    assert.equal(unescapeCSharpString('"\\u00e9\\U0001F389\\x41\\x00e9"'), 'é🎉Aé');
  });

  test('null is null; verbatim strings work', () => {
    assert.equal(unescapeCSharpString('null'), null);
    assert.equal(unescapeCSharpString('@"C:\\path ""quoted"""'), 'C:\\path "quoted"');
  });

  test('returns undefined for anything that is not one complete literal', () => {
    assert.equal(unescapeCSharpString('"unterminated'), undefined);
    assert.equal(unescapeCSharpString('"ends in escape\\'), undefined);
    assert.equal(unescapeCSharpString('"two" "literals"'), undefined);
    assert.equal(unescapeCSharpString('"bad \\u12"'), undefined);
    assert.equal(unescapeCSharpString('The debugger is unable to evaluate this expression'), undefined);
    assert.equal(unescapeCSharpString('42'), undefined);
  });
});

describe('classifyEvaluateResponse', () => {
  test('values', () => {
    assert.deepEqual(classifyEvaluateResponse({ result: '"x"', type: 'string' }), { kind: 'value', value: '"x"', type: 'string' });
    assert.deepEqual(classifyEvaluateResponse({ result: 'null', type: 'System.Data.DataTable' }), { kind: 'value', value: 'null', type: 'System.Data.DataTable' });
  });

  test('compile errors come back as results without a type', () => {
    const result = "error CS0103: The name 'doesNotExist' does not exist in the current context";
    assert.deepEqual(classifyEvaluateResponse({ result }), { kind: 'compileError', message: result });
  });

  test('exceptions come back as results whose type names the exception', () => {
    const result = "'nobody.Count' threw an exception of type 'System.NullReferenceException'";
    assert.deepEqual(classifyEvaluateResponse({ result, type: 'int {System.NullReferenceException}' }), {
      kind: 'exception',
      exceptionType: 'System.NullReferenceException',
      message: result,
    });
  });

  test('a string value that merely mentions an exception is still a value', () => {
    const result = `"'x' threw an exception of type 'System.Foo'"`;
    assert.equal(classifyEvaluateResponse({ result, type: 'string' }).kind, 'value');
  });

  test('isMissingTypeError recognizes an assembly that is not loaded', () => {
    assert.ok(isMissingTypeError("error CS0400: The type or namespace name 'Newtonsoft' could not be found in the global namespace"));
    assert.ok(isMissingTypeError("error CS0234: The type or namespace name 'Json' does not exist in the namespace 'System.Text'"));
    assert.ok(!isMissingTypeError("error CS0103: The name 'x' does not exist in the current context"));
  });
});

describe('parseJsonPayload', () => {
  test('accepts raw control characters inside strings', () => {
    assert.deepEqual(parseJsonPayload('["a\nb\tc\u0001"]'), ['a\nb\tc\u0001']);
  });
});

describe('type information', () => {
  const info = (text: string) => parseTypeInfo(text);

  test('parses the type info expression result', () => {
    assert.deepEqual(info('System.Collections.Generic.List`1[[X]]|System.Object|||E|3'), {
      fullName: 'System.Collections.Generic.List`1[[X]]',
      baseTypes: ['System.Object'],
      enumerable: true,
      dictionary: false,
      count: 3,
    });
    assert.equal(info('X|System.Object|||E|-1').count, undefined);
    assert.throws(() => info('garbage'));
  });

  test('kindOf follows base types, so typed DataTables count', () => {
    assert.equal(kindOf(info('Shop+OrdersDataTable|System.Data.TypedTableBase`1[[Shop+OrdersRow]]|System.Data.DataTable|System.ComponentModel.MarshalByValueComponent|E|-1')), 'datatable');
    assert.equal(kindOf(info('System.Data.DataSet|System.ComponentModel.MarshalByValueComponent|System.Object||E|-1')), 'dataset');
    assert.equal(kindOf(info('System.Data.DataView|System.ComponentModel.MarshalByValueComponent|System.Object||E|2')), 'dataview');
    assert.equal(kindOf(info('System.Collections.Generic.Dictionary`2[[A],[B]]|System.Object|||ED|3')), 'dictionary');
    assert.equal(kindOf(info('System.Int32[]|System.Array|System.Object||E|8')), 'array');
    assert.equal(kindOf(info('System.Collections.Generic.List`1[[A]]|System.Object|||E|3')), 'list');
    assert.equal(kindOf(info('System.String|System.Object|||E|-1')), undefined);
    assert.equal(kindOf(info('Sample.Person|System.Object||||-1')), undefined);
  });
});

describe('tables', () => {
  test('a DataTable payload keeps column types, nulls and deleted rows', () => {
    const table = tableFromDataTablePayload({
      name: 'Orders',
      total: 5,
      columns: [{ name: 'Id', type: 'System.Int32' }, { name: 'Note', type: 'System.String' }],
      rows: [['1', null], 'deleted'],
    });
    assert.deepEqual(table, {
      name: 'Orders',
      columns: [{ name: 'Id', type: 'System.Int32' }, { name: 'Note', type: 'System.String' }],
      rows: [['1', null], 'deleted'],
      total: 5,
    });
  });

  test('an empty table still has its columns', () => {
    const table = tableFromDataTablePayload({ name: 'Empty', total: 0, columns: [{ name: 'Id', type: 'System.Int32' }], rows: [] });
    assert.equal(table.columns.length, 1);
    assert.equal(table.rows.length, 0);
  });

  test('objects become one column per member, in order of first appearance', () => {
    const table = tableFromListPayload(
      { element: 'P', members: { Id: 'System.Int32', Name: 'System.String' }, rows: [{ Id: 1, Name: 'a' }, { Id: 2, Extra: true }] },
      'List<P>',
      2,
    );
    assert.deepEqual(table.columns, [{ name: 'Id', type: 'System.Int32' }, { name: 'Name', type: 'System.String' }, { name: 'Extra', type: undefined }]);
    assert.deepEqual(table.rows, [[1, 'a', undefined], [2, undefined, true]]);
  });

  test('scalars go in a Value column typed by the element', () => {
    const table = tableFromListPayload({ element: 'System.Int32', members: {}, rows: [3, 1, 4] }, 'int[]', 3);
    assert.deepEqual(table.columns, [{ name: 'Value', type: 'System.Int32' }]);
    assert.deepEqual(table.rows, [[3], [1], [4]]);
  });

  test('scalars among objects get a Value column that avoids member names', () => {
    const table = tableFromListPayload({ element: null, members: {}, rows: [{ Value: 1 }, 'text'] }, 'List<object>', undefined);
    assert.deepEqual(table.columns.map(c => c.name), ['Value2', 'Value']);
    assert.deepEqual(table.rows, [[undefined, 1], ['text', undefined]]);
    assert.equal(table.total, undefined);
  });

  test('the helper payload', () => {
    assert.deepEqual(parseHelperPayload({ kind: 'null' }, friendlyTypeName), { kind: 'null' });
    assert.deepEqual(parseHelperPayload({ kind: 'unsupported', type: 'System.String' }, friendlyTypeName), { kind: 'unsupported', type: 'System.String' });
    assert.deepEqual(parseHelperPayload({ error: 'System.Exception: boom' }, friendlyTypeName), { kind: 'error', error: 'System.Exception: boom' });
    const list = parseHelperPayload(
      { kind: 'list', type: 'System.Collections.Generic.List`1[[System.Int32, mscorlib]]', tables: [{ name: '', total: null, columns: [{ name: 'Value', type: 'System.Int32' }], rows: [['1']] }] },
      friendlyTypeName,
    );
    assert.equal(list.kind, 'list');
    assert.ok(list.kind === 'list');
    assert.equal(list.tables[0].name, 'List<int>');
    assert.equal(list.tables[0].total, undefined);
    assert.throws(() => parseHelperPayload({ kind: 'mystery', tables: [] }, friendlyTypeName));
  });
});

describe('friendlyTypeName', () => {
  test('C# keywords, generics, nullables, arrays and nested types', () => {
    assert.equal(friendlyTypeName('System.Int32'), 'int');
    assert.equal(friendlyTypeName('System.Data.DataTable'), 'DataTable');
    assert.equal(
      friendlyTypeName('System.Collections.Generic.List`1[[System.Int32, mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089]]'),
      'List<int>',
    );
    assert.equal(
      friendlyTypeName('System.Collections.Generic.Dictionary`2[[System.String, mscorlib, Version=4.0.0.0],[Sample.Person, Sample, Version=1.0.0.0]]'),
      'Dictionary<string, Person>',
    );
    assert.equal(friendlyTypeName('System.Nullable`1[[System.DateTime, System.Private.CoreLib, Version=9.0.0.0]]'), 'DateTime?');
    assert.equal(friendlyTypeName('System.Int32[]'), 'int[]');
    assert.equal(friendlyTypeName('System.String[,]'), 'string[,]');
    assert.equal(friendlyTypeName('Shop+OrdersDataTable'), 'Shop.OrdersDataTable');
    assert.equal(
      friendlyTypeName('System.Collections.Generic.List`1[[System.Collections.Generic.List`1[[System.Int32, mscorlib]], mscorlib]][]'),
      'List<List<int>>[]',
    );
  });
});
