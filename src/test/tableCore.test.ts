import * as assert from 'assert/strict';
import * as path from 'path';
import { describe, test } from 'node:test';

// The webview's table logic is plain JavaScript (media/visualizer/tableCore.js), loaded here as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require(path.join(__dirname, '..', '..', 'media', 'visualizer', 'tableCore.js'));

const table = {
  name: 'T',
  columns: [{ name: 'Id', type: 'System.Int32' }, { name: 'Name', type: 'System.String' }, { name: 'Note' }],
  rows: [['10', 'beta', null], ['9', 'Alpha', 'x'], 'deleted', ['100', 'gamma', { City: 'London' }], null, ['', 'delta', '2']],
};

describe('table core', () => {
  test('cellText', () => {
    assert.equal(core.cellText(null), '');
    assert.equal(core.cellText(undefined), '');
    assert.equal(core.cellText(true), 'true');
    assert.equal(core.cellText(1.5), '1.5');
    assert.equal(core.cellText({ $type: 'Sample.Person', $text: '(cycle) Person' }), '(cycle) Person');
    assert.equal(core.cellText({ City: 'London' }), '{"City":"London"}');
    assert.equal(core.cellText([1, 2]), '[1,2]');
  });

  test('nested values, stand-ins and previews', () => {
    assert.ok(core.isNested({ a: 1 }));
    assert.ok(core.isNested([1]));
    assert.ok(!core.isNested({ $type: 'T', $text: 't' }));
    assert.ok(core.isStandIn({ $type: 'T', $text: 't' }));
    assert.equal(core.nestedPreview([1, 2, 3]), '[3] [1,2,3]');
    assert.equal(core.nestedPreview({ s: 'x'.repeat(100) }, 20), '{"s":"xxxxxxxxxxxxx…');
  });

  test('numeric columns come from the CLR type, or from the values when there is none', () => {
    assert.ok(core.isNumericColumn(table.columns[0], table.rows, 0));
    assert.ok(!core.isNumericColumn(table.columns[1], table.rows, 1));
    assert.ok(!core.isNumericColumn(table.columns[2], table.rows, 2)); // has an object
    assert.ok(core.isNumericColumn({ name: 'n' }, [['1'], ['-2.5e3'], [null], [3]], 0));
  });

  test('original order, filtering and placeholder rows', () => {
    assert.deepEqual(core.visibleRows(table, '', -1, 1), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(core.visibleRows(table, 'ALPHA', -1, 1), [1]);
    assert.deepEqual(core.visibleRows(table, 'london', -1, 1), [3]);
    assert.deepEqual(core.visibleRows(table, 'deleted', -1, 1), []);
  });

  test('numeric sort, both ways, with empty values and placeholder rows last', () => {
    assert.deepEqual(core.visibleRows(table, '', 0, 1), [1, 0, 3, 5, 2, 4]);
    assert.deepEqual(core.visibleRows(table, '', 0, -1), [3, 0, 1, 5, 2, 4]);
  });

  test('text sort is case-insensitive', () => {
    assert.deepEqual(core.visibleRows(table, '', 1, 1), [1, 0, 5, 3, 2, 4]);
  });

  test('TSV for pasting into a spreadsheet', () => {
    assert.equal(core.toTsv(['A', 'B'], [['x\ty', null], [true, 'line\nbreak']]), 'A\tB\r\nx y\t\r\ntrue\tline break');
    assert.equal(core.toTsv(null, [['1', '2']]), '1\t2');
  });

  test('CSV quoting', () => {
    assert.equal(core.toCsv(['Name', 'Note'], [['a,b', 'say "hi"'], ['plain', null], [' padded', 'two\nlines']]), 'Name,Note\r\n"a,b","say ""hi"""\r\nplain,\r\n" padded","two\nlines"\r\n');
  });
});
