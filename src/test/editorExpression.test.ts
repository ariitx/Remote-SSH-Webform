import * as assert from 'assert/strict';
import { describe, test } from 'node:test';
import { SourceLanguage, expressionAt } from '../visualizer/editorExpression';

/** The expression with the cursor on the first occurrence of `at` (offset by `shift` characters). */
function at(line: string, word: string, language: SourceLanguage = 'csharp', shift = 0): string | undefined {
  const index = line.indexOf(word);
  assert.ok(index >= 0, `${word} not in ${line}`);
  return expressionAt(line, index + shift, language)?.expression;
}

describe('expressionAt', () => {
  test('a plain variable, with the cursor anywhere in it or just after it', () => {
    const line = '    var count = orders.Rows.Count;';
    assert.equal(at(line, 'orders'), 'orders');
    assert.equal(at(line, 'orders', 'csharp', 3), 'orders');
    assert.equal(at(line, 'orders', 'csharp', 6), 'orders');
  });

  test('member chains stop at the word under the cursor, as in the debug hover', () => {
    const line = 'Console.WriteLine(this.shop.Tables.Count);';
    assert.equal(at(line, 'Tables'), 'this.shop.Tables');
    assert.equal(at(line, 'shop'), 'this.shop');
    assert.equal(at(line, 'this'), 'this');
  });

  test('C# indexers and null-conditional access are kept', () => {
    const line = 'foreach (DataRow row in ds.Tables[0].Rows) { }';
    assert.equal(at(line, 'Rows'), 'ds.Tables[0].Rows');
    assert.equal(at(line, 'Tables'), 'ds.Tables[0]');
    assert.equal(at('var x = people?[i + 1]?.Tags;', 'Tags'), 'people?[i + 1]?.Tags');
    assert.equal(at('var t = grid[a[0]].Rows;', 'Rows'), 'grid[a[0]].Rows');
  });

  test('results of calls are not evaluated', () => {
    assert.equal(at('var r = GetTable().Rows;', 'Rows'), undefined);
    assert.equal(at('var r = GetTable().Rows;', 'GetTable'), 'GetTable');
  });

  test('keywords, numbers, strings and comments are not variables', () => {
    assert.equal(at('return new List<int>();', 'new'), undefined);
    assert.equal(at('var x = 42;', '42'), undefined);
    assert.equal(at('var s = "orders here";', 'orders'), undefined);
    assert.equal(at('var s = @"C:\\temp\\" + orders;', 'orders'), 'orders');
    assert.equal(at('var s = "a \\" b" + orders;', 'orders'), 'orders');
    assert.equal(at('x = 1; // orders', 'orders'), undefined);
    const interpolated = 'Console.WriteLine($"{people.Count} people, {orders.Rows.Count} orders, {{literal}} {f($"{inner}")}"); // x';
    assert.equal(at(interpolated, 'people.'), 'people');
    assert.equal(at(interpolated, 'Rows'), 'orders.Rows');
    assert.equal(at(interpolated, 'people,', 'csharp', 2), undefined);
    assert.equal(at(interpolated, 'literal'), undefined);
    assert.equal(at(interpolated, 'inner'), 'inner');
    assert.equal(at(interpolated, 'x'), undefined);
    assert.equal(at('Dim s = $"{items.Count} items"', 'items.', 'vb'), 'items');
    assert.equal(at('    ', ' '), undefined);
  });

  test('VB.NET: Me becomes this, quotes double, and apostrophes start comments', () => {
    assert.equal(at('Dim n = Me.stock.Rows.Count', 'Rows', 'vb'), 'this.stock.Rows');
    assert.equal(at('Dim n = MyBase.items', 'items', 'vb'), 'base.items');
    assert.equal(at('Dim s = "say ""hi"" " & items.Count', 'items', 'vb'), 'items');
    assert.equal(at("Dim n = 1 ' items", 'items', 'vb'), undefined);
    assert.equal(at('Dim x As New DataTable', 'Dim', 'vb'), undefined);
    assert.equal(at('Dim x As New DataTable', 'x', 'vb'), 'x');
  });

  test('the range covers the expression', () => {
    assert.deepEqual(expressionAt('a = ds.Tables[0];', 8, 'csharp'), { expression: 'ds.Tables[0]', start: 4, end: 16 });
  });
});
