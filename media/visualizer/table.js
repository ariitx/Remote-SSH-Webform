// The table visualizer page. The extension posts 'loading', 'data', 'error' and 'status' messages; the page asks for
// 'refresh', 'copy' and 'exportCsv'.
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var core = window.TableCore;

  var state = {
    data: null, // ViewData from the extension
    time: '',
    loading: false,
    message: null, // { text, detail, severity }
    status: '',
    tab: 0,
    filter: '',
    sorts: {}, // table name -> { column: name, direction: 1 | -1 }
    selected: null, // { row: index into table.rows, col: column index }
    expanded: {}, // "row:col" -> true for expanded nested values
  };
  var shown = []; // indices into the current table's rows, in display order

  document.getElementById('app').innerHTML =
    '<header class="toolbar">' +
    '<div class="heading"><span class="expr"></span><span class="badge type"></span><span class="meta"></span></div>' +
    '<div class="actions">' +
    '<input class="filter" type="search" placeholder="Filter rows" aria-label="Filter rows" spellcheck="false">' +
    '<button type="button" data-action="refresh" title="Read the value again from the debugger">Refresh</button>' +
    '<button type="button" class="secondary" data-action="copyTable" title="Copy the shown rows, with headers, as tab-separated text">Copy</button>' +
    '<button type="button" class="secondary" data-action="exportCsv" title="Save the shown rows as a CSV file">Export CSV</button>' +
    '</div></header>' +
    '<div class="banner" hidden></div>' +
    '<nav class="tabs" role="tablist" hidden></nav>' +
    '<div class="notice" hidden></div>' +
    '<div class="grid" tabindex="0"><table><thead></thead><tbody></tbody></table></div>' +
    '<div class="menu" role="menu" hidden>' +
    '<button type="button" role="menuitem" data-copy="cell">Copy Cell</button>' +
    '<button type="button" role="menuitem" data-copy="row">Copy Row</button>' +
    '<button type="button" role="menuitem" data-copy="column">Copy Column</button>' +
    '<button type="button" role="menuitem" data-copy="table">Copy Table</button>' +
    '</div>';

  var el = function (selector) { return document.querySelector(selector); };
  var exprEl = el('.expr'), typeEl = el('.type'), metaEl = el('.meta'), bannerEl = el('.banner'), tabsEl = el('.tabs');
  var noticeEl = el('.notice'), gridEl = el('.grid'), theadEl = el('thead'), tbodyEl = el('tbody'), menuEl = el('.menu');
  var filterEl = el('.filter'), refreshEl = el('[data-action="refresh"]');
  var copyEl = el('[data-action="copyTable"]'), exportEl = el('[data-action="exportCsv"]');

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function format(n) {
    return n.toLocaleString();
  }

  function currentTable() {
    var tables = state.data ? state.data.tables : [];
    return tables[Math.min(state.tab, tables.length - 1)] || null;
  }

  function sortOf(table) {
    var sort = state.sorts[table.name];
    if (!sort) return { index: -1, direction: 1 };
    var index = table.columns.findIndex(function (c) { return c.name === sort.column; });
    return { index: index, direction: sort.direction };
  }

  // ---- rendering ----

  function render() {
    renderHeading();
    renderBanner();
    renderTabs();
    renderTable();
  }

  function renderHeading() {
    var data = state.data;
    exprEl.textContent = data ? data.expression : '';
    typeEl.textContent = data ? data.typeName : '';
    typeEl.title = data ? data.fullTypeName : '';
    typeEl.hidden = !data;
    var parts = [];
    if (state.loading) parts.push('Reading…');
    else if (data) parts.push('read with ' + data.serializer + ' at ' + state.time);
    metaEl.textContent = parts.join(' ');
    refreshEl.disabled = state.loading;
    copyEl.disabled = exportEl.disabled = !currentTable();
  }

  function renderBanner() {
    var m = state.message;
    if (!m && !state.status) {
      bannerEl.hidden = true;
      return;
    }
    bannerEl.hidden = false;
    bannerEl.className = 'banner ' + (m ? m.severity : 'warning');
    var html = '<div class="banner-text">' + escapeHtml(m ? m.text : state.status) + '</div>';
    if (m && state.data) html += '<div class="banner-sub">The table shows the values from the last successful read.</div>';
    if (m && m.detail) html += '<details><summary>Details</summary><pre>' + escapeHtml(m.detail) + '</pre></details>';
    bannerEl.innerHTML = html;
  }

  function renderTabs() {
    var tables = state.data ? state.data.tables : [];
    if (tables.length < 2) {
      tabsEl.hidden = true;
      return;
    }
    tabsEl.hidden = false;
    tabsEl.innerHTML = tables
      .map(function (t, i) {
        var count = t.total === undefined || t.total === null ? '' : ' <span class="count">' + format(t.total) + '</span>';
        return '<button type="button" role="tab" data-tab="' + i + '" aria-selected="' + (i === state.tab) + '">' + escapeHtml(t.name || 'Table ' + (i + 1)) + count + '</button>';
      })
      .join('');
  }

  function renderTable() {
    var table = currentTable();
    gridEl.classList.toggle('stale', !!(state.message && state.data) || !!state.status);
    if (!table) {
      theadEl.innerHTML = tbodyEl.innerHTML = '';
      gridEl.hidden = true;
      noticeEl.hidden = !(state.data && state.data.tables.length === 0);
      noticeEl.textContent = state.data ? 'The DataSet has no tables.' : '';
      return;
    }
    gridEl.hidden = false;
    var sort = sortOf(table);
    shown = core.visibleRows(table, state.filter, sort.index, sort.direction);
    var numeric = table.columns.map(function (c, i) { return core.isNumericColumn(c, table.rows, i); });

    theadEl.innerHTML =
      '<tr><th class="index" title="Item index">#</th>' +
      table.columns
        .map(function (c, i) {
          var arrow = sort.index === i ? (sort.direction > 0 ? ' ▲' : ' ▼') : '';
          var tip = c.name + (c.type ? ': ' + c.type : '') + '\nClick to sort';
          return '<th data-col="' + i + '" class="' + (numeric[i] ? 'num' : '') + '" title="' + escapeHtml(tip) + '" aria-sort="' + (sort.index === i ? (sort.direction > 0 ? 'ascending' : 'descending') : 'none') + '">' + escapeHtml(c.name) + '<span class="arrow">' + arrow + '</span></th>';
        })
        .join('') +
      '</tr>';

    var html = [];
    var width = table.columns.length;
    for (var k = 0; k < shown.length; k++) {
      var r = shown[k];
      var row = table.rows[r];
      var selectedRow = state.selected && state.selected.row === r;
      if (!Array.isArray(row)) {
        var label = row === 'deleted' ? '(deleted row)' : '(null)';
        html.push('<tr data-row="' + r + '" class="placeholder"><td class="index">' + r + '</td><td colspan="' + Math.max(width, 1) + '">' + label + '</td></tr>');
        continue;
      }
      var cells = '';
      for (var c = 0; c < width; c++) cells += cellHtml(row[c], r, c, numeric[c], selectedRow && state.selected.col === c);
      html.push('<tr data-row="' + r + '"' + (selectedRow ? ' class="selected"' : '') + '><td class="index">' + r + '</td>' + cells + '</tr>');
    }
    tbodyEl.innerHTML = html.join('');
    renderNotice(table);
  }

  function cellHtml(value, r, c, numeric, selected) {
    var classes = [];
    var content;
    var title = '';
    if (value === undefined) {
      classes.push('missing');
      content = '';
    } else if (value === null) {
      classes.push('null');
      content = 'null';
    } else if (typeof value === 'boolean') {
      classes.push('bool');
      content = String(value);
    } else if (core.isStandIn(value)) {
      classes.push('standin');
      content = escapeHtml(value.$text);
      title = value.$type;
    } else if (core.isNested(value)) {
      classes.push('nested');
      if (state.expanded[r + ':' + c]) {
        classes.push('expanded');
        content = '<span class="toggle" title="Collapse">▾</span><pre>' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre>';
      } else {
        content = '<span class="toggle" title="Expand">▸</span>' + escapeHtml(core.nestedPreview(value));
      }
    } else {
      var text = String(value);
      if (typeof value === 'number' || numeric) classes.push('num');
      else classes.push('str');
      if (text.length > 60 || /[\r\n]/.test(text)) title = text;
      content = escapeHtml(text.replace(/\r\n|\r|\n/g, '↵'));
    }
    if (selected) classes.push('selected');
    return '<td data-col="' + c + '" class="' + classes.join(' ') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + content + '</td>';
  }

  function renderNotice(table) {
    var parts = [];
    var count = table.rows.length;
    if (table.total === undefined || table.total === null) {
      parts.push('Showing the first ' + format(count) + ' items; there are more. Raise remoteSshWebForm.tableVisualizer.maxRows to read more.');
    } else if (table.total > count) {
      parts.push('Showing the first ' + format(count) + ' of ' + format(table.total) + ' rows (remoteSshWebForm.tableVisualizer.maxRows).');
    } else if (count === 0) {
      parts.push(state.data && /^data(table|view|set)$/.test(state.data.kind) ? 'The table has no rows.' : 'The collection is empty.');
    } else {
      parts.push(format(count) + (count === 1 ? ' row.' : ' rows.'));
    }
    if (state.filter.trim()) parts.push(format(shown.length) + ' match the filter.');
    noticeEl.hidden = false;
    noticeEl.textContent = parts.join(' ');
    noticeEl.classList.toggle('truncated', table.total === undefined || table.total === null || table.total > count);
  }

  // ---- copying and exporting ----

  function headerNames(table) {
    return table.columns.map(function (c) { return c.name; });
  }

  function shownRows(table) {
    return shown.map(function (r) { return table.rows[r]; }).filter(Array.isArray);
  }

  function copy(what) {
    var table = currentTable();
    if (!table) return;
    var sel = state.selected;
    var text;
    if (what === 'table') text = core.toTsv(headerNames(table), shownRows(table));
    else if (!sel || !Array.isArray(table.rows[sel.row])) return;
    else if (what === 'cell') text = core.cellText(table.rows[sel.row][sel.col]);
    else if (what === 'row') text = core.toTsv(null, [table.rows[sel.row]]);
    else if (what === 'column') {
      text = core.toTsv([table.columns[sel.col].name], shownRows(table).map(function (row) { return [row[sel.col]]; }));
    }
    vscode.postMessage({ type: 'copy', text: text });
  }

  function exportCsv() {
    var table = currentTable();
    if (!table) return;
    var name = state.data.tables.length > 1 ? state.data.expression + '-' + table.name : state.data.expression;
    vscode.postMessage({ type: 'exportCsv', csv: core.toCsv(headerNames(table), shownRows(table)), name: name });
  }

  // ---- events ----

  var filterTimer;
  filterEl.addEventListener('input', function () {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(function () {
      state.filter = filterEl.value;
      renderTable();
    }, 120);
  });

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!menuEl.hidden && !menuEl.contains(target)) hideMenu();
    var action = target.closest('[data-action]');
    if (action) {
      if (action.dataset.action === 'refresh') vscode.postMessage({ type: 'refresh' });
      else if (action.dataset.action === 'copyTable') copy('table');
      else if (action.dataset.action === 'exportCsv') exportCsv();
      return;
    }
    var copyItem = target.closest('[data-copy]');
    if (copyItem) {
      copy(copyItem.dataset.copy);
      hideMenu();
      return;
    }
    var tab = target.closest('[data-tab]');
    if (tab) {
      state.tab = Number(tab.dataset.tab);
      state.selected = null;
      state.expanded = {};
      renderTabs();
      renderTable();
      gridEl.scrollTop = 0;
      return;
    }
    var th = target.closest('th[data-col]');
    if (th) {
      toggleSort(Number(th.dataset.col));
      return;
    }
    var td = target.closest('td');
    if (td && gridEl.contains(td)) {
      var tr = td.closest('tr[data-row]');
      if (!tr || td.dataset.col === undefined) return;
      var r = Number(tr.dataset.row), c = Number(td.dataset.col);
      if (target.closest('.toggle')) {
        var key = r + ':' + c;
        if (state.expanded[key]) delete state.expanded[key];
        else state.expanded[key] = true;
      }
      select(r, c);
    }
  });

  document.addEventListener('contextmenu', function (e) {
    var td = e.target.closest('td[data-col]');
    if (!td || !gridEl.contains(td)) return;
    e.preventDefault();
    select(Number(td.closest('tr').dataset.row), Number(td.dataset.col));
    menuEl.hidden = false;
    var x = Math.min(e.clientX, window.innerWidth - menuEl.offsetWidth - 4);
    var y = Math.min(e.clientY, window.innerHeight - menuEl.offsetHeight - 4);
    menuEl.style.left = Math.max(0, x) + 'px';
    menuEl.style.top = Math.max(0, y) + 'px';
    menuEl.querySelector('button').focus();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menuEl.hidden) {
      hideMenu();
      return;
    }
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c' && state.selected && document.activeElement !== filterEl) {
      var selection = window.getSelection();
      if (selection && selection.toString()) return; // copy the selected text as usual
      e.preventDefault();
      copy('cell');
    } else if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      filterEl.focus();
      filterEl.select();
    }
  });

  window.addEventListener('blur', hideMenu);

  function hideMenu() {
    menuEl.hidden = true;
  }

  function toggleSort(index) {
    var table = currentTable();
    var name = table.columns[index].name;
    var sort = state.sorts[table.name];
    if (!sort || sort.column !== name) state.sorts[table.name] = { column: name, direction: 1 };
    else if (sort.direction === 1) sort.direction = -1;
    else delete state.sorts[table.name];
    renderTable();
  }

  function select(r, c) {
    state.selected = { row: r, col: c };
    renderTable();
  }

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (m.type === 'loading') {
      state.loading = true;
      renderHeading();
    } else if (m.type === 'data') {
      var previous = currentTable();
      var tables = m.data.tables;
      // Keep the user's place across refreshes: same tab (by name), sort and filter; selection if it still exists.
      var tab = previous ? tables.findIndex(function (t) { return t.name === previous.name; }) : -1;
      state.tab = tab >= 0 ? tab : Math.min(state.tab, Math.max(0, tables.length - 1));
      var table = tables[state.tab];
      if (state.selected && (!table || state.selected.row >= table.rows.length || state.selected.col >= table.columns.length)) state.selected = null;
      if (state.data && state.data.expression !== m.data.expression) state.sorts = {};
      state.expanded = {};
      state.data = m.data;
      state.time = m.time;
      state.loading = false;
      state.message = null;
      state.status = '';
      render();
    } else if (m.type === 'error') {
      state.loading = false;
      state.message = { text: m.message, detail: m.detail, severity: m.severity };
      state.status = '';
      render();
    } else if (m.type === 'status') {
      state.status = m.text;
      renderBanner();
      renderTable();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
