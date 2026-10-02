// Table logic with no DOM: cell text, sorting, filtering, TSV/CSV. Loaded by the webview (as window.TableCore) and by
// the unit tests (as a CommonJS module).
(function (root) {
  'use strict';

  var NUMERIC_TYPES = /^System\.(S?Byte|U?Int(16|32|64)|Single|Double|Decimal)$/;
  var NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

  /** True for a nested object/array (as opposed to a scalar or a built-in serializer's {$type, $text} stand-in). */
  function isNested(value) {
    return typeof value === 'object' && value !== null && !isStandIn(value);
  }

  /** The built-in serializer shows nested objects as {"$type": ..., "$text": ...}. */
  function isStandIn(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 2 && '$type' in value && '$text' in value;
  }

  /** Plain text of a cell, for copying, filtering and sorting. null and missing members are empty. */
  function cellText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (isStandIn(value)) return String(value.$text);
    return JSON.stringify(value);
  }

  /** A short one-line preview of a nested value, e.g. "[3] [1,2,3]" or "{…} {"City":"London"}". */
  function nestedPreview(value, maxLength) {
    var json = JSON.stringify(value);
    var prefix = Array.isArray(value) ? '[' + value.length + '] ' : '';
    var limit = maxLength || 80;
    return prefix + (json.length > limit ? json.slice(0, limit - 1) + '…' : json);
  }

  /** Whether a column sorts and aligns as numbers: by its CLR type, or, without one, when every value is a number. */
  function isNumericColumn(column, rows, index) {
    if (column.type) return NUMERIC_TYPES.test(column.type);
    var any = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!Array.isArray(row)) continue;
      var v = row[index];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number' || (typeof v === 'string' && NUMBER_TEXT.test(v.trim()))) any = true;
      else return false;
    }
    return any;
  }

  var collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

  /** Compares two cells; empty values sort last in either direction (handled by the caller via `direction`). */
  function compareCells(a, b, numeric) {
    var ae = a === null || a === undefined || a === '';
    var be = b === null || b === undefined || b === '';
    if (ae || be) return ae === be ? 0 : ae ? 1 : -1;
    if (numeric) {
      var an = Number(a), bn = Number(b);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
    }
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
    var at = cellText(a), bt = cellText(b);
    return collator ? collator.compare(at, bt) : at < bt ? -1 : at > bt ? 1 : 0;
  }

  /**
   * Indices of `rows` to show: those matching `filter` (case-insensitive, any cell), sorted by column `sortIndex`
   * (-1 = original order) in `direction` (1 or -1). Rows that aren't arrays (a null item, a deleted DataRow) only
   * match an empty filter, and sort last.
   */
  function visibleRows(table, filter, sortIndex, direction) {
    var rows = table.rows;
    var needle = (filter || '').trim().toLowerCase();
    var indices = [];
    for (var i = 0; i < rows.length; i++) {
      if (!needle) indices.push(i);
      else if (Array.isArray(rows[i]) && rows[i].some(function (cell) { return cellText(cell).toLowerCase().indexOf(needle) >= 0; })) indices.push(i);
    }
    if (sortIndex >= 0 && sortIndex < table.columns.length) {
      var numeric = isNumericColumn(table.columns[sortIndex], rows, sortIndex);
      indices.sort(function (x, y) {
        var rx = rows[x], ry = rows[y];
        var ax = Array.isArray(rx), ay = Array.isArray(ry);
        if (!ax || !ay) return ax === ay ? x - y : ax ? -1 : 1;
        var a = rx[sortIndex], b = ry[sortIndex];
        var ae = a === null || a === undefined || a === '', be = b === null || b === undefined || b === '';
        // Empty values stay at the bottom whichever way the column is sorted.
        if (ae || be) return ae === be ? x - y : ae ? 1 : -1;
        return compareCells(a, b, numeric) * direction || x - y;
      });
    }
    return indices;
  }

  /** Tab-separated text: tabs and line breaks inside cells become spaces, so it pastes cleanly into a spreadsheet. */
  function toTsv(header, rows) {
    var line = function (cells) {
      return cells.map(function (c) { return cellText(c).replace(/[\t\r\n]+/g, ' '); }).join('\t');
    };
    return (header ? [line(header)] : []).concat(rows.map(line)).join('\r\n');
  }

  /** RFC 4180 CSV. */
  function toCsv(header, rows) {
    var field = function (c) {
      var t = cellText(c);
      return /[",\r\n]/.test(t) || /^\s|\s$/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    var line = function (cells) { return cells.map(field).join(','); };
    return [line(header)].concat(rows.map(line)).join('\r\n') + '\r\n';
  }

  var api = {
    isNested: isNested,
    isStandIn: isStandIn,
    cellText: cellText,
    nestedPreview: nestedPreview,
    isNumericColumn: isNumericColumn,
    compareCells: compareCells,
    visibleRows: visibleRows,
    toTsv: toTsv,
    toCsv: toCsv,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TableCore = api;
})(this);
