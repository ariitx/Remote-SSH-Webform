import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { after, describe, test } from 'node:test';
import { DesignerPlan, applyDesigner, planDesigner, renderDesigner, updateDesigner } from '../designer';
import { CSPROJ, cleanup, makeProject, needsFramework, page } from './helpers';

after(cleanup);

function plan(markupPath: string): DesignerPlan {
  const result = planDesigner(markupPath);
  if ('skipped' in result) assert.fail(`skipped: ${result.skipped}`);
  return result;
}

function fields(markupPath: string): string[] {
  return plan(markupPath).fields.map(f => `${f.name}:${f.type}`);
}

// A prefix registered without an assembly can't be checked against metadata, so its single candidate is used as is.
const MY = '<%@ Register TagPrefix="my" Namespace="Lib" %>';

describe('which controls get a field', () => {
  test('server controls in document order, skipping comments and asp:Content', { skip: needsFramework }, () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page(
        'Orders',
        [
          '<asp:Content ID="Content1" ContentPlaceHolderID="Main" runat="server">',
          '  <%-- <asp:Label ID="commentedOut" runat="server" /> --%>',
          '  <asp:TextBox ID="txtName" runat="server" />',
          '  <asp:Label ID="lblPlain" />',
          '  <asp:Button ID="btnSave" runat="server" />',
          '</asp:Content>',
        ].join('\n'),
        ' MasterPageFile="~/Site.master"',
      ),
    });
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), [
      'txtName:System.Web.UI.WebControls.TextBox',
      'btnSave:System.Web.UI.WebControls.Button',
    ]);
  });

  test('controls in multi-instance templates get no field; UpdatePanel ContentTemplate does', { skip: needsFramework }, () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page(
        'Orders',
        [
          '<asp:Repeater ID="rpt" runat="server">',
          '  <HeaderTemplate><asp:Label ID="lblHeader" runat="server" /></HeaderTemplate>',
          '  <ItemTemplate><p><asp:Label ID="lblRow" runat="server" /></ItemTemplate>',
          '</asp:Repeater>',
          '<asp:UpdatePanel ID="up" runat="server"><ContentTemplate>',
          '  <asp:Label ID="lblInPanel" runat="server" />',
          '</ContentTemplate></asp:UpdatePanel>',
          '<asp:Label ID="lblAfter" runat="server" />',
        ].join('\n'),
      ),
    });
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), [
      'rpt:System.Web.UI.WebControls.Repeater',
      'up:System.Web.UI.UpdatePanel',
      'lblInPanel:System.Web.UI.WebControls.Label',
      'lblAfter:System.Web.UI.WebControls.Label',
    ]);
  });

  test('ID\'d collection items get a field without runat; <Templates> children are templates', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page(
        'Orders',
        [
          MY,
          '<my:Grid ID="grid" runat="server">',
          '  <Columns><my:CommandColumn><CustomButtons><my:CustomButton ID="btnDelete" /></CustomButtons></my:CommandColumn></Columns>',
          '  <Templates><EditForm><my:Label ID="lblEdit" runat="server" /></EditForm></Templates>',
          '</my:Grid>',
          '<div><my:Label ID="lblLiteralContext" /></div>',
        ].join('\n'),
      ),
    });
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), ['grid:Lib.Grid', 'btnDelete:Lib.CustomButton']);
  });

  test('server tags inside a client <script> are parsed; a server <script> block is not', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page(
        'Orders',
        [
          MY,
          '<script>if (a<b && c>d) { html = \'<my:Label ID="lblInScript" runat="server" />\'; }</script>',
          '<script runat="server">void F() { var s = "<my:Label ID=\\"lblInCode\\" runat=\\"server\\" />"; }</script>',
          '<style>p > a { color: red }</style>',
          '<my:Label ID="lblAfter" runat="server" />',
        ].join('\n'),
      ),
    });
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), ['lblInScript:Lib.Label', 'lblAfter:Lib.Label']);
  });

  test('attribute values may contain <%# %> with the same quotes and ">"', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page(
        'Orders',
        [MY, '<my:Label ID="lblA" runat="server" Text="<%# Eval("A") > 1 ? "x" : "y" %>" />', '<my:Label ID="lblB" runat="server" />'].join('\n'),
      ),
    });
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), ['lblA:Lib.Label', 'lblB:Lib.Label']);
  });

  test('duplicate IDs get one field', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page('Orders', [MY, '<my:Label ID="lbl" runat="server" />', '<my:Label ID="LBL" runat="server" />'].join('\n')),
    });
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), ['lbl:Lib.Label']);
  });

  test('fields the code-behind declares are left out', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page('Orders', [MY, '<my:Label ID="lblMoved" runat="server" />', '<my:Label ID="lblProp" runat="server" />'].join('\n')),
      'Orders.aspx.cs': [
        'public partial class Orders {',
        '  protected global::Lib.Label lblMoved;',
        '  class Helper { public Lib.Label lblProp { get; set; } }',
        '}',
      ].join('\n'),
    });
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), ['lblProp:Lib.Label']);
  });
});

describe('HTML server controls', () => {
  test('map by tag and input type; head children are controls only under <head runat="server">', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page(
        'Orders',
        [
          '<html><head runat="server"><title id="pageTitle">x</title><link id="css" rel="stylesheet" /><meta id="desc" name="d" /></head>',
          '<body><form id="form1" runat="server">',
          '<input id="txt" runat="server" /><input id="chk" type="checkbox" runat="server" /><input id="mail" type="email" runat="server" />',
          '<a id="lnk" runat="server">x</a><div id="panel" runat="server"></div><iframe id="frame" runat="server"></iframe>',
          '<link id="bodyLink" runat="server" /><img id="pic" runat="server">',
          '<table id="tbl" runat="server"><tr id="row" runat="server"><td id="cell" runat="server"></td></tr></table>',
          '</form></body></html>',
        ].join('\n'),
      ),
    });
    const html = 'System.Web.UI.HtmlControls';
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), [
      `pageTitle:${html}.HtmlTitle`,
      `css:${html}.HtmlLink`,
      `desc:${html}.HtmlMeta`,
      `form1:${html}.HtmlForm`,
      `txt:${html}.HtmlInputText`,
      `chk:${html}.HtmlInputCheckBox`,
      `mail:${html}.HtmlInputGenericControl`,
      `lnk:${html}.HtmlAnchor`,
      `panel:${html}.HtmlGenericControl`,
      `frame:${html}.HtmlIframe`,
      `bodyLink:${html}.HtmlGenericControl`,
      `pic:${html}.HtmlImage`,
      `tbl:${html}.HtmlTable`,
      `row:${html}.HtmlTableRow`,
      `cell:${html}.HtmlTableCell`,
    ]);
  });
});

describe('type resolution', () => {
  test('asp: tags resolve against the framework assemblies, with the type\'s own casing', { skip: needsFramework }, () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page('Orders', '<asp:textbox ID="txt" runat="server" /><asp:ScriptManager ID="sm" runat="server" /><asp:Nope ID="bad" runat="server" />'),
    });
    const result = plan(path.join(root, 'Orders.aspx'));
    assert.deepEqual(
      result.fields.map(f => `${f.name}:${f.type}`),
      ['txt:System.Web.UI.WebControls.TextBox', 'sm:System.Web.UI.ScriptManager'],
    );
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /asp:Nope "bad"/);
  });

  test('a prefix registered for several namespaces picks the assembly that defines the type', { skip: needsFramework }, () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page(
        'Orders',
        [
          '<%@ Register TagPrefix="x" Namespace="System.Web.UI" Assembly="System.Web.Extensions, Version=4.0.0.0" %>',
          '<%@ Register TagPrefix="x" Namespace="System.Web.UI.WebControls" Assembly="System.Web" %>',
          '<x:TextBox ID="txt" runat="server" /><x:UpdatePanel ID="up" runat="server" />',
        ].join('\n'),
      ),
    });
    assert.deepEqual(fields(path.join(root, 'Orders.aspx')), ['txt:System.Web.UI.WebControls.TextBox', 'up:System.Web.UI.UpdatePanel']);
  });

  test('user controls resolve to their Inherits, from @Register and from web.config', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Web.config': '<configuration><system.web><pages><controls><!-- <add tagPrefix="uc" tagName="Old" src="~/Old.ascx" /> -->\n<add tagPrefix="uc" tagName="Footer" src="~/Controls/Footer.ascx" /></controls></pages></system.web></configuration>',
      'Controls/Header.ascx': '<%@ Control Language="C#" CodeBehind="Header.ascx.cs" Inherits="Web.Controls.Header" %>',
      'Controls/Footer.ascx': '<%@ Control Language="C#" Inherits="Web.Controls.Footer" %>',
      'Pages/Orders.aspx': page(
        'Orders',
        [
          '<%@ Register Src="../Controls/Header.ascx" TagName="Header" TagPrefix="uc" %>',
          '<%@ Register Src="~/Controls/Missing.ascx" TagName="Missing" TagPrefix="uc" %>',
          '<uc:Header ID="header" runat="server" /><uc:Footer ID="footer" runat="server" /><uc:Missing ID="missing" runat="server" /><uc:Old ID="old" runat="server" />',
        ].join('\n'),
      ),
    });
    const result = plan(path.join(root, 'Pages', 'Orders.aspx'));
    assert.deepEqual(
      result.fields.map(f => `${f.name}:${f.type}`),
      ['header:Web.Controls.Header', 'footer:Web.Controls.Footer'],
    );
    assert.ok(result.warnings.some(w => w.includes('Missing.ascx') && w.includes('file not found')));
    assert.ok(result.warnings.some(w => w.includes('uc:Old "old"')));
  });

  test('an unresolved control keeps its existing field when the type name matches the tag', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page('Orders', '<zz:Gauge ID="gauge" runat="server" /><zz:Dial ID="dial" runat="server" />'),
      'Orders.aspx.designer.cs': renderDesigner('Web.Orders', [
        { name: 'gauge', type: 'Vendor.Gauges.Gauge' },
        { name: 'dial', type: 'Vendor.Other' },
      ], 'cs', undefined),
    });
    const result = plan(path.join(root, 'Orders.aspx'));
    assert.deepEqual(result.fields, [{ name: 'gauge', type: 'Vendor.Gauges.Gauge' }]);
    assert.equal(result.warnings.length, 1);
  });
});

describe('skipped markup', () => {
  test('CodeFile, missing Inherits, and no CodeBehind without a designer', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Site.aspx': '<%@ Page Language="C#" CodeFile="Site.aspx.cs" Inherits="Site" %>',
      'Inline.aspx': '<%@ Page Language="C#" %>',
      'NoCodeBehind.aspx': '<%@ Page Language="C#" Inherits="Web.NoCodeBehind" %>',
    });
    for (const [file, reason] of [['Site.aspx', /CodeFile/], ['Inline.aspx', /Inherits/], ['NoCodeBehind.aspx', /CodeBehind/]] as const) {
      const result = planDesigner(path.join(root, file));
      assert.ok('skipped' in result, file);
      assert.match(result.skipped, reason);
    }
  });
});

describe('writing designer files', () => {
  const FIELD_BLOCK = (name: string, type: string, indent = '        ') =>
    [
      `${indent}/// <summary>`,
      `${indent}/// ${name} control.`,
      `${indent}/// </summary>`,
      `${indent}/// <remarks>`,
      `${indent}/// Auto-generated field.`,
      `${indent}/// To modify move field declaration from designer file to code-behind file.`,
      `${indent}/// </remarks>`,
      `${indent}protected global::${type} ${name};`,
    ];

  test('a new C# file uses Visual Studio 2022\'s format', () => {
    const content = renderDesigner('Web.Pages.Orders', [{ name: 'lbl', type: 'Lib.Label' }], 'cs', undefined);
    assert.equal(
      content,
      [
        '//------------------------------------------------------------------------------',
        '// <auto-generated>',
        '//     This code was generated by a tool.',
        '//',
        '//     Changes to this file may cause incorrect behavior and will be lost if',
        '//     the code is regenerated. ',
        '// </auto-generated>',
        '//------------------------------------------------------------------------------',
        '',
        'namespace Web.Pages',
        '{',
        '',
        '',
        '    public partial class Orders',
        '    {',
        '',
        ...FIELD_BLOCK('lbl', 'Lib.Label'),
        '    }',
        '}',
        '',
      ].join('\r\n'),
    );
  });

  test('a new VB file drops the root namespace', () => {
    const root = makeProject({ 'Web.vbproj': CSPROJ });
    const content = renderDesigner('Web.Admin.Users', [{ name: 'gv', type: 'System.Web.UI.WebControls.GridView' }], 'vb', path.join(root, 'Web.vbproj'));
    const lines = content.split('\r\n');
    assert.ok(lines.includes('Namespace Admin'));
    assert.ok(lines.includes('    Partial Public Class Users'));
    assert.ok(lines.includes("        '''gv control."));
    assert.ok(lines.includes('        Protected WithEvents gv As Global.System.Web.UI.WebControls.GridView'));
    assert.deepEqual(lines.slice(-3), ['    End Class', 'End Namespace', '']);
  });

  test('VB markup gets a .designer.vb', () => {
    const root = makeProject({
      'Web.vbproj': CSPROJ,
      'Admin/Users.aspx': '<%@ Page Language="vb" CodeBehind="Users.aspx.vb" Inherits="Web.Admin.Users" %>\n<form id="form1" runat="server"></form>',
      'Admin/Users.aspx.vb': 'Namespace Admin\nPartial Public Class Users\n    Protected WithEvents form1 As HtmlForm\nEnd Class\nEnd Namespace\n',
    });
    const result = plan(path.join(root, 'Admin', 'Users.aspx'));
    assert.ok(result.designerPath.endsWith('Users.aspx.designer.vb'));
    assert.deepEqual(result.fields, []); // declared in the code-behind
  });

  test('an existing file keeps its header, BOM, line endings, blank-line style and field order', () => {
    const legacy = [
      '﻿// custom header from an old Visual Studio',
      '',
      'namespace Web {',
      '    ',
      '    ',
      '    public partial class Orders {',
      '        ',
      ...FIELD_BLOCK('lblB', 'Lib.Label'),
      '        ',
      ...FIELD_BLOCK('lblA', 'Lib.Label'),
      '        ',
      ...FIELD_BLOCK('lblGone', 'Lib.Label'),
      '    }',
      '}',
      '',
    ].join('\n');
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page('Orders', [MY, '<my:Label ID="lblA" runat="server" /><my:Button ID="btnNew" runat="server" /><my:Label ID="lblB" runat="server" />'].join('\n')),
      'Orders.aspx.designer.cs': legacy,
    });
    const result = plan(path.join(root, 'Orders.aspx'));
    assert.equal(
      result.content,
      [
        '﻿// custom header from an old Visual Studio',
        '',
        'namespace Web {',
        '    ',
        '    ',
        '    public partial class Orders {',
        '        ',
        ...FIELD_BLOCK('lblB', 'Lib.Label'),
        '        ',
        ...FIELD_BLOCK('lblA', 'Lib.Label'),
        '        ',
        ...FIELD_BLOCK('btnNew', 'Lib.Button'),
        '    }',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('members other than generated fields are kept', () => {
    const existing = [
      'namespace Web',
      '{',
      '    public partial class Orders',
      '    {',
      '',
      ...FIELD_BLOCK('lblOld', 'Lib.Label'),
      '',
      '        /// <summary>',
      '        /// Master property.',
      '        /// </summary>',
      '        public new Web.SiteMaster Master {',
      '            get {',
      '                return ((Web.SiteMaster)(base.Master));',
      '            }',
      '        }',
      '    }',
      '}',
      '',
    ].join('\r\n');
    const updated = updateDesigner(existing, [{ name: 'lblNew', type: 'Lib.Label' }], 'cs');
    assert.ok(updated);
    assert.ok(!updated.includes('lblOld'));
    assert.ok(updated.indexOf('lblNew;') < updated.indexOf('Master property.'));
    assert.ok(updated.includes('                return ((Web.SiteMaster)(base.Master));\r\n'));
  });

  test('an unrecognized layout returns undefined', () => {
    assert.equal(updateDesigner('// nothing here\n', [], 'cs'), undefined);
  });

  test('nothing is written when the fields already match', () => {
    const root = makeProject({
      'Web.csproj': CSPROJ,
      'Orders.aspx': page('Orders', [MY, '<my:Label ID="lbl" runat="server" />'].join('\n')),
    });
    const markup = path.join(root, 'Orders.aspx');
    const first = plan(markup);
    assert.equal(first.created, true);
    applyDesigner(first);
    const second = plan(markup);
    assert.equal(second.created, false);
    assert.equal(second.content, undefined);
    assert.deepEqual(applyDesigner(second), []);
  });
});

describe('project file', () => {
  const projectWith = (items: string) =>
    ['<?xml version="1.0" encoding="utf-8"?>', '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">', items, '</Project>', ''].join('\r\n');

  function createDesigner(project: string): { root: string; notes: string[]; project: string } {
    const root = makeProject({
      'Web.csproj': project,
      'Pages/Orders.aspx': '<%@ Page Language="C#" CodeBehind="Orders.aspx.cs" Inherits="Web.Pages.Orders" %>',
    });
    const notes = applyDesigner(plan(path.join(root, 'Pages', 'Orders.aspx')));
    return { root, notes, project: fs.readFileSync(path.join(root, 'Web.csproj'), 'utf8') };
  }

  test('a new designer file is added in alphabetical position, after its code-behind', () => {
    const { notes, project } = createDesigner(
      projectWith(
        [
          '  <ItemGroup>',
          '    <Compile Include="Pages\\Orders.aspx.cs">',
          '      <DependentUpon>Orders.aspx</DependentUpon>',
          '      <SubType>ASPXCodeBehind</SubType>',
          '    </Compile>',
          '    <Compile Include="Properties\\AssemblyInfo.cs" />',
          '  </ItemGroup>',
        ].join('\r\n'),
      ),
    );
    assert.deepEqual(notes, ['Added Pages\\Orders.aspx.designer.cs to Web.csproj.']);
    assert.equal(
      project,
      projectWith(
        [
          '  <ItemGroup>',
          '    <Compile Include="Pages\\Orders.aspx.cs">',
          '      <DependentUpon>Orders.aspx</DependentUpon>',
          '      <SubType>ASPXCodeBehind</SubType>',
          '    </Compile>',
          '    <Compile Include="Pages\\Orders.aspx.designer.cs">',
          '      <DependentUpon>Orders.aspx</DependentUpon>',
          '    </Compile>',
          '    <Compile Include="Properties\\AssemblyInfo.cs" />',
          '  </ItemGroup>',
        ].join('\r\n'),
      ),
    );
  });

  test('a project without Compile items gets a new ItemGroup', () => {
    const { project } = createDesigner(projectWith('  <PropertyGroup />'));
    assert.match(project, /<ItemGroup>\r\n {4}<Compile Include="Pages\\Orders\.aspx\.designer\.cs">\r\n {6}<DependentUpon>Orders\.aspx<\/DependentUpon>\r\n {4}<\/Compile>\r\n {2}<\/ItemGroup>\r\n<\/Project>/);
  });

  test('an entry that already exists, or an SDK-style project, is left alone', () => {
    const listed = projectWith('  <ItemGroup>\r\n    <Compile Include="pages\\orders.aspx.designer.cs" />\r\n  </ItemGroup>');
    const sdk = '<Project Sdk="Microsoft.NET.Sdk.Web">\r\n</Project>\r\n';
    for (const original of [listed, sdk]) {
      const { root, notes, project } = createDesigner(original);
      assert.deepEqual(notes, []);
      assert.equal(project, original);
      assert.ok(fs.existsSync(path.join(root, 'Pages', 'Orders.aspx.designer.cs')));
    }
  });
});
