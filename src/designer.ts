import * as fs from 'fs';
import * as path from 'path';
import { publicTypeNames } from './clrMetadata';

// Regenerates the <markup>.designer.cs/.vb of a Web Forms page, user control or master page, as Visual Studio's
// designer does on save: one field per server control with an ID, except controls inside templates that ASP.NET
// instantiates more than once. Visual Studio resolves types through the page parser; this resolves them from the
// @Register directives, web.config <pages><controls>, the referenced user controls' Inherits and the referenced
// assemblies' metadata.

export interface DesignerField {
  name: string;
  type: string;
}

export interface DesignerPlan {
  markupPath: string;
  designerPath: string;
  projectPath?: string;
  /** Full new designer content, or undefined when the existing file already declares the same fields. */
  content?: string;
  created: boolean;
  fields: DesignerField[];
  warnings: string[];
}

export type DesignerResult = DesignerPlan | { skipped: string };

type Language = 'cs' | 'vb';

interface Registration {
  prefix: string;
  namespace?: string;
  assembly?: string;
  tagName?: string;
  src?: string;
  /** Directory relative `src` paths resolve against. */
  baseDir: string;
}

interface Element {
  name: string;
  prefix?: string;
  local: string;
  runat: boolean;
  parent?: Element;
}

// The asp: prefix as registered by ASP.NET itself and by the framework's root web.config, in lookup order.
const ASP_REGISTRATIONS: { namespace: string; assembly: string }[] = [
  { namespace: 'System.Web.UI.WebControls', assembly: 'System.Web' },
  { namespace: 'System.Web.UI.WebControls.WebParts', assembly: 'System.Web' },
  { namespace: 'System.Web.UI', assembly: 'System.Web.Extensions' },
  { namespace: 'System.Web.UI.WebControls', assembly: 'System.Web.Extensions' },
  { namespace: 'System.Web.UI.WebControls.Expressions', assembly: 'System.Web.Extensions' },
  { namespace: 'System.Web.DynamicData', assembly: 'System.Web.DynamicData' },
  { namespace: 'System.Web.UI.WebControls', assembly: 'System.Web.Entity' },
];

const HTML_CONTROLS: Record<string, string> = {
  a: 'HtmlAnchor',
  area: 'HtmlArea',
  audio: 'HtmlAudio',
  button: 'HtmlButton',
  embed: 'HtmlEmbed',
  form: 'HtmlForm',
  head: 'HtmlHead',
  html: 'HtmlElement',
  iframe: 'HtmlIframe',
  img: 'HtmlImage',
  select: 'HtmlSelect',
  source: 'HtmlSource',
  table: 'HtmlTable',
  td: 'HtmlTableCell',
  th: 'HtmlTableCell',
  textarea: 'HtmlTextArea',
  tr: 'HtmlTableRow',
  track: 'HtmlTrack',
  video: 'HtmlVideo',
};

const HTML_INPUTS: Record<string, string> = {
  button: 'HtmlInputButton',
  checkbox: 'HtmlInputCheckBox',
  file: 'HtmlInputFile',
  hidden: 'HtmlInputHidden',
  image: 'HtmlInputImage',
  password: 'HtmlInputPassword',
  radio: 'HtmlInputRadioButton',
  reset: 'HtmlInputReset',
  submit: 'HtmlInputSubmit',
  text: 'HtmlInputText',
};

// Only as children of <head runat="server">; elsewhere they are HtmlGenericControls.
const HEAD_CHILDREN = new Map([
  ['link', 'HtmlLink'],
  ['meta', 'HtmlMeta'],
  ['title', 'HtmlTitle'],
]);

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export function isDesignerMarkup(file: string): boolean {
  return /\.(aspx|ascx|master)$/i.test(file);
}

export function planDesigner(markupPath: string): DesignerResult {
  const markup = readText(markupPath);
  if (markup === undefined) return { skipped: `cannot read ${markupPath}` };
  const parsed = parseMarkup(markup);
  const main = parsed.directives.find(d => /^(page|control|master)$/i.test(d.name)) ?? parsed.directives.find(d => d.name === '');
  const inherits = main?.attrs.inherits;
  if (!main || !inherits) return { skipped: 'no Inherits attribute in the @Page/@Control/@Master directive' };
  if (main.attrs.codefile) return { skipped: 'uses CodeFile (Web Site model), which needs no designer file' };

  const projectPath = findProjectFile(path.dirname(markupPath));
  const language: Language =
    /\.vb$/i.test(main.attrs.codebehind ?? '') || /^(vb|visualbasic)$/i.test(main.attrs.language ?? '') || /\.vbproj$/i.test(projectPath ?? '')
      ? 'vb'
      : 'cs';
  const designerPath = `${markupPath}.designer.${language}`;
  const existing = readText(designerPath);
  if (existing === undefined && !main.attrs.codebehind) return { skipped: 'no CodeBehind attribute and no existing designer file' };

  const warnings: string[] = [];
  const resolver = new TypeResolver(markupPath, projectPath, parsed.registrations, warnings);
  const oldFields = existing === undefined ? [] : parseDesignerFields(existing, language);
  const oldTypes = new Map(oldFields.map(f => [f.name.toLowerCase(), f.type]));
  const codeBehind = readText(path.join(path.dirname(markupPath), main.attrs.codebehind ?? `${path.basename(markupPath)}.${language}`)) ?? '';

  const fields: DesignerField[] = [];
  const seen = new Set<string>();
  for (const control of parsed.controls) {
    const key = control.id.toLowerCase();
    if (seen.has(key)) continue;
    let type = resolver.resolve(control.element, control.inputType);
    if (!type) {
      const old = oldTypes.get(key);
      if (old && shortName(old).toLowerCase() === control.element.local.toLowerCase()) {
        type = old;
      } else {
        warnings.push(`${control.element.name} "${control.id}": type not found, so no field was generated.`);
        continue;
      }
    }
    if (type === 'System.Web.UI.WebControls.Content') continue;
    seen.add(key);
    if (declaredInCodeBehind(codeBehind, control.id, language)) continue;
    fields.push({ name: control.id, type });
  }

  // Like Visual Studio, keep surviving fields where they are and append new ones, so the file's diff stays small.
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const oldNames = new Set(oldFields.map(f => f.name.toLowerCase()));
  const ordered = [
    ...oldFields.filter(f => byName.has(f.name.toLowerCase())).map(f => byName.get(f.name.toLowerCase())!),
    ...fields.filter(f => !oldNames.has(f.name.toLowerCase())),
  ];

  let content: string | undefined;
  if (existing === undefined) {
    content = renderDesigner(inherits, ordered, language, projectPath);
  } else {
    const same = oldFields.length === ordered.length && oldFields.every((f, i) => f.name === ordered[i].name && f.type === ordered[i].type);
    if (!same) content = updateDesigner(existing, ordered, language) ?? renderDesigner(inherits, ordered, language, projectPath, existing);
  }
  return { markupPath, designerPath, projectPath, content, created: existing === undefined, fields: ordered, warnings };
}

/** Writes the planned designer file; for a new one, also adds it to the project file. Returns the notes to report. */
export function applyDesigner(plan: DesignerPlan): string[] {
  const notes: string[] = [];
  if (plan.content === undefined) return notes;
  fs.writeFileSync(plan.designerPath, plan.content, 'utf8');
  if (plan.created && plan.projectPath) {
    const note = addToProject(plan.projectPath, plan.designerPath, plan.markupPath);
    if (note) notes.push(note);
  }
  return notes;
}

// ---- markup parsing ----

interface ParsedMarkup {
  directives: { name: string; attrs: Record<string, string> }[];
  registrations: Registration[];
  controls: { id: string; element: Element; inputType?: string }[];
}

function parseMarkup(text: string): ParsedMarkup {
  const result: ParsedMarkup = { directives: [], registrations: [], controls: [] };
  const stack: Element[] = [];
  let rawText: string | undefined;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<%--', i)) {
      i = skipPast(text, '--%>', i + 4);
    } else if (text.startsWith('<%@', i)) {
      const end = text.indexOf('%>', i + 3);
      const body = text.slice(i + 3, end < 0 ? n : end);
      i = end < 0 ? n : end + 2;
      const nameMatch = /^\s*([A-Za-z]+)(?=\s|$)(?!\s*=)/.exec(body);
      const attrs = parseAttributes(nameMatch ? body.slice(nameMatch[0].length) : body);
      result.directives.push({ name: nameMatch ? nameMatch[1] : '', attrs });
      if (nameMatch && /^register$/i.test(nameMatch[1]) && attrs.tagprefix) {
        result.registrations.push({ prefix: attrs.tagprefix, namespace: attrs.namespace, assembly: attrs.assembly, tagName: attrs.tagname, src: attrs.src, baseDir: '' });
      }
    } else if (text.startsWith('<%', i)) {
      i = skipPast(text, '%>', i + 2);
    } else if (text.startsWith('</', i)) {
      const m = /^<\/\s*([A-Za-z][\w:.-]*)\s*>?/.exec(text.slice(i, i + 200));
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      const name = m[1].toLowerCase();
      if (rawText) {
        if (name === rawText) rawText = undefined;
        if (!name.includes(':')) continue;
      }
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name.toLowerCase() === name) {
          stack.length = k;
          break;
        }
      }
    } else if (/[A-Za-z]/.test(text[i + 1] ?? '')) {
      // Inside <script>/<style>, ASP.NET still parses server tags (they are prefixed), but nothing else is markup.
      if (rawText && !/^<[\w.-]+:/.test(text.slice(i, i + 200))) {
        i += 1;
        continue;
      }
      const tag = readTag(text, i);
      i = tag.end;
      const colon = tag.name.indexOf(':');
      const parent = stack[stack.length - 1];
      const element: Element = {
        name: tag.name,
        prefix: colon > 0 ? tag.name.slice(0, colon) : undefined,
        local: colon > 0 ? tag.name.slice(colon + 1) : tag.name,
        runat: (tag.attrs.runat ?? '').toLowerCase() === 'server',
        parent,
      };
      const lower = tag.name.toLowerCase();
      if (lower === 'script' || lower === 'style') {
        // A runat="server" script block holds code-behind-style code, not markup.
        if (!tag.selfClosing) {
          if (element.runat) i = skipPastClosingTag(text, lower, i);
          else rawText = lower;
        }
        continue;
      }
      // <head runat="server"> turns its <title>, <link> and <meta> children into controls without runat="server".
      if (isServerHead(parent) && HEAD_CHILDREN.has(lower)) element.runat = true;
      // Collection items such as DevExpress custom buttons are parsed as objects and get a field from their ID alone.
      const isCollectionItem = !element.runat && element.prefix !== undefined && parent !== undefined && !parent.runat && hasServerAncestor(element);
      if ((element.runat || isCollectionItem) && tag.attrs.id && !insideMultiInstanceTemplate(element)) {
        result.controls.push({ id: tag.attrs.id, element, inputType: tag.attrs.type });
      }
      if (!tag.selfClosing && !(element.prefix === undefined && VOID_ELEMENTS.has(lower))) stack.push(element);
    } else {
      i += 1;
    }
  }
  return result;
}

function readTag(text: string, start: number): { name: string; attrs: Record<string, string>; selfClosing: boolean; end: number } {
  const nameMatch = /^<([A-Za-z][\w:.-]*)/.exec(text.slice(start, start + 200))!;
  const attrs: Record<string, string> = {};
  let i = start + nameMatch[0].length;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '>') {
      return { name: nameMatch[1], attrs, selfClosing: false, end: i + 1 };
    } else if (text.startsWith('/>', i)) {
      return { name: nameMatch[1], attrs, selfClosing: true, end: i + 2 };
    } else if (text.startsWith('<%', i)) {
      i = skipPast(text, '%>', i + 2);
    } else {
      const attrMatch = /^[^\s=>\/]+/.exec(text.slice(i, i + 200));
      if (!attrMatch) {
        i++;
        continue;
      }
      const attrName = attrMatch[0].toLowerCase();
      i += attrMatch[0].length;
      while (i < n && /\s/.test(text[i])) i++;
      let value = '';
      if (text[i] === '=') {
        i++;
        while (i < n && /\s/.test(text[i])) i++;
        const quote = text[i];
        if (quote === '"' || quote === "'") {
          const valueStart = ++i;
          // <%# Eval("x") %> may sit inside a value delimited by the same quote character.
          while (i < n && text[i] !== quote) i = text.startsWith('<%', i) ? skipPast(text, '%>', i + 2) : i + 1;
          value = text.slice(valueStart, i);
          i++;
        } else {
          const unquoted = /^[^\s>]*/.exec(text.slice(i))![0];
          value = unquoted.endsWith('/') && text[i + unquoted.length] === '>' ? unquoted.slice(0, -1) : unquoted;
          i += value.length;
        }
      }
      if (!(attrName in attrs)) attrs[attrName] = value;
    }
  }
  return { name: nameMatch[1], attrs, selfClosing: false, end: n };
}

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

function skipPast(text: string, token: string, from: number): number {
  const end = text.indexOf(token, from);
  return end < 0 ? text.length : end + token.length;
}

function skipPastClosingTag(text: string, name: string, from: number): number {
  const re = new RegExp(`</\\s*${name}\\s*>`, 'ig');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index + m[0].length : text.length;
}

function isServerHead(e: Element | undefined): boolean {
  return e !== undefined && e.runat && e.prefix === undefined && e.local.toLowerCase() === 'head';
}

function isPropertyElement(e: Element): boolean {
  return !e.runat && e.prefix === undefined;
}

function hasServerAncestor(e: Element): boolean {
  for (let a = e.parent; a; a = a.parent) if (a.runat || a.prefix !== undefined) return true;
  return false;
}

/**
 * ASP.NET declares fields only for controls it instantiates once per page. Template contents (ITemplate properties
 * such as ItemTemplate, or DevExpress's <Templates> children) are instantiated per row/item, so their controls
 * get no field; UpdatePanel's ContentTemplate is marked TemplateInstance.Single, so its controls do.
 */
function insideMultiInstanceTemplate(element: Element): boolean {
  for (let a = element.parent; a; a = a.parent) {
    if (!isPropertyElement(a) || !hasServerAncestor(a)) continue;
    const local = a.local.toLowerCase();
    const isTemplate = local.endsWith('template') || (a.parent !== undefined && isPropertyElement(a.parent) && a.parent.local.toLowerCase() === 'templates');
    if (!isTemplate) continue;
    if (local === 'contenttemplate' && a.parent?.prefix?.toLowerCase() === 'asp' && a.parent.local.toLowerCase() === 'updatepanel') continue;
    return true;
  }
  return false;
}

// ---- type resolution ----

class TypeResolver {
  private readonly registrations: Registration[];
  private readonly projectDir: string;
  private readonly hintPaths = new Map<string, string>();

  constructor(
    private readonly markupPath: string,
    projectPath: string | undefined,
    pageRegistrations: Registration[],
    private readonly warnings: string[],
  ) {
    this.projectDir = projectPath ? path.dirname(projectPath) : path.dirname(markupPath);
    const markupDir = path.dirname(markupPath);
    this.registrations = [
      ...ASP_REGISTRATIONS.map(r => ({ prefix: 'asp', ...r, baseDir: this.projectDir })),
      ...webConfigRegistrations(this.projectDir, markupDir),
      ...pageRegistrations.map(r => ({ ...r, baseDir: markupDir })),
    ];
    const projectText = projectPath ? readText(projectPath) ?? '' : '';
    const referenceRe = /<Reference\s+Include="([^",]+)[^"]*"\s*>([\s\S]*?)<\/Reference>/gi;
    for (let m = referenceRe.exec(projectText); m; m = referenceRe.exec(projectText)) {
      const hint = /<HintPath>\s*([^<]+?)\s*<\/HintPath>/i.exec(m[2]);
      if (hint) this.hintPaths.set(m[1].trim().toLowerCase(), path.resolve(this.projectDir, hint[1]));
    }
  }

  resolve(element: Element, inputType: string | undefined): string | undefined {
    if (element.prefix === undefined) return htmlControlType(element, inputType);
    const prefix = element.prefix.toLowerCase();
    const tag = element.local.toLowerCase();

    const userControl = this.registrations.find(r => r.src && r.tagName?.toLowerCase() === tag && r.prefix.toLowerCase() === prefix);
    if (userControl) return this.userControlType(userControl);

    const unverified: string[] = [];
    for (const r of this.registrations) {
      if (!r.namespace || r.prefix.toLowerCase() !== prefix) continue;
      const candidate = `${r.namespace}.${element.local}`;
      const assemblyPath = r.assembly ? this.findAssembly(r.assembly) : undefined;
      if (!assemblyPath) {
        if (!unverified.includes(candidate)) unverified.push(candidate);
        continue;
      }
      const lower = candidate.toLowerCase();
      for (const type of publicTypeNames(assemblyPath)) if (type.toLowerCase() === lower) return type;
    }
    return unverified.length === 1 ? unverified[0] : undefined;
  }

  private userControlType(r: Registration): string | undefined {
    const src = r.src!;
    const file = src.startsWith('~/') || src.startsWith('/') ? path.join(this.projectDir, src.replace(/^~?\//, '')) : path.resolve(r.baseDir, src);
    const text = readText(file);
    const directive = text && /<%@\s*(?:Control|Master)\b([\s\S]*?)%>/i.exec(text);
    const inherits = directive ? parseAttributes(directive[1]).inherits : undefined;
    if (!inherits) this.warnings.push(`${src}: ${text === undefined ? 'file not found' : 'no Inherits attribute'} (registered as ${r.prefix}:${r.tagName}).`);
    return inherits;
  }

  private findAssembly(assembly: string): string | undefined {
    const [name, ...parts] = assembly.split(',').map(s => s.trim());
    const version = parts.find(p => /^version=/i.test(p))?.split('=')[1];
    const windir = process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows';
    const candidates = [this.hintPaths.get(name.toLowerCase()), path.join(this.projectDir, 'bin', `${name}.dll`)];
    if (/^system(\.|$)/i.test(name)) {
      for (const fx of ['Framework64', 'Framework', 'FrameworkArm64']) candidates.push(path.join(windir, 'Microsoft.NET', fx, 'v4.0.30319', `${name}.dll`));
    }
    for (const gac of [path.join(windir, 'Microsoft.NET', 'assembly'), path.join(windir, 'assembly')]) {
      for (const arch of ['GAC_MSIL', 'GAC_64', 'GAC_32']) {
        const dir = path.join(gac, arch, name);
        let versions: string[];
        try {
          versions = fs.readdirSync(dir);
        } catch {
          continue;
        }
        const exact = version ? versions.filter(v => v.replace(/^v4\.0_/, '').startsWith(`${version}_`)) : [];
        for (const v of exact.length > 0 ? exact : versions.sort().reverse()) candidates.push(path.join(dir, v, `${name}.dll`));
      }
    }
    return candidates.find(c => c !== undefined && fs.existsSync(c));
  }
}

function webConfigRegistrations(projectDir: string, markupDir: string): Registration[] {
  const dirs: string[] = [];
  for (let dir = markupDir; ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (path.relative(projectDir, dir) === '' || path.dirname(dir) === dir || path.relative(projectDir, dir).startsWith('..')) break;
  }
  const registrations: Registration[] = [];
  for (const dir of dirs) {
    const config = readText(path.join(dir, 'Web.config'));
    if (!config) continue;
    const stripped = config.replace(/<!--[\s\S]*?-->/g, '');
    const controlsRe = /<controls>([\s\S]*?)<\/controls>/gi;
    for (let block = controlsRe.exec(stripped); block; block = controlsRe.exec(stripped)) {
      for (const add of block[1].match(/<add\b[^>]*>/gi) ?? []) {
        const a = parseAttributes(add);
        if (a.tagprefix) registrations.push({ prefix: a.tagprefix, namespace: a.namespace, assembly: a.assembly, tagName: a.tagname, src: a.src, baseDir: dir });
      }
    }
  }
  return registrations;
}

function htmlControlType(element: Element, inputType: string | undefined): string {
  const lower = element.local.toLowerCase();
  let name: string;
  if (lower === 'input') name = HTML_INPUTS[(inputType || 'text').toLowerCase()] ?? 'HtmlInputGenericControl';
  else name = (isServerHead(element.parent) ? HEAD_CHILDREN.get(lower) : undefined) ?? HTML_CONTROLS[lower] ?? 'HtmlGenericControl';
  return `System.Web.UI.HtmlControls.${name}`;
}

/** Visual Studio leaves out a field the code-behind already declares ("move field declaration ... to code-behind"). */
function declaredInCodeBehind(code: string, name: string, language: Language): boolean {
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Fields only: a same-named property is more often on a nested helper class than on the page itself.
  const re =
    language === 'cs'
      ? new RegExp(`\\b(?:public|protected|private|internal)\\b[^;{}()=\\n]*[\\s.>]${id}\\s*[;=]`)
      : new RegExp(`^\\s*(?:(?:Public|Protected|Private|Friend|Shared|Shadows|ReadOnly|WithEvents|Dim)\\s+)+${id}\\s+As\\b`, 'im');
  return re.test(code);
}

// ---- designer file rendering ----

export function parseDesignerFields(text: string, language: Language): DesignerField[] {
  const fields: DesignerField[] = [];
  const re =
    language === 'cs'
      ? /^[ \t]*(?:protected|public|private|internal)\s+(?:global::)?([\w.]+)\s+(\w+)\s*;/gm
      : /^[ \t]*(?:Protected|Public|Private|Friend)\s+WithEvents\s+(\w+)\s+As\s+(?:Global\.)?([\w.]+)/gim;
  for (let m = re.exec(text); m; m = re.exec(text)) fields.push(language === 'cs' ? { name: m[2], type: m[1] } : { name: m[1], type: m[2] });
  return fields;
}

/**
 * Replaces only the field declarations inside the class, keeping the header, namespace and any other members as
 * they are: their exact text varies between Visual Studio versions. Returns undefined if the layout isn't recognized.
 */
export function updateDesigner(existing: string, fields: DesignerField[], language: Language): string | undefined {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const classIndex = lines.findIndex(l => (language === 'cs' ? /\bpartial\s+class\s+\w+/ : /^\s*Partial\s+(?:\w+\s+)*Class\s+\w+/i).test(l));
  if (classIndex < 0) return undefined;
  const indent = /^\s*/.exec(lines[classIndex])![0].replace('\ufeff', '');
  let bodyStart = classIndex + 1;
  if (language === 'cs' && !lines[classIndex].includes('{')) {
    if (lines[bodyStart]?.trim() !== '{') return undefined;
    bodyStart++;
  }
  const end = lines.findIndex((l, i) => i >= bodyStart && (language === 'cs' ? l.trimEnd() === `${indent}}` : /^\s*End\s+Class\b/i.test(l)));
  if (end < 0) return undefined;

  const body = lines.slice(bodyStart, end);
  const memberIndent = `${indent}    `;
  const blank = body.find(l => l.trim() === '') ?? (language === 'cs' && lines[classIndex].includes('{') ? memberIndent : '');

  // Members other than generated fields (e.g. a Master property) are kept after the fields.
  const kept: string[][] = [];
  let block: string[] = [];
  const fieldRe = language === 'cs' ? /^\s*(?:protected|public|private|internal)\s+(?:global::)?[\w.]+\s+\w+\s*;/ : /^\s*(?:Protected|Public|Private|Friend)\s+WithEvents\s+\w+\s+As\s/i;
  for (const line of body) {
    if (line.trim() === '') {
      if (block.length > 0) kept.push(block);
      block = [];
    } else if (fieldRe.test(line)) {
      block = [];
    } else {
      block.push(line);
    }
  }
  if (block.length > 0) kept.push(block);
  const keptMembers = kept.filter(b => !b.every(l => /^\s*(\/\/\/|''')/.test(l)));

  const newBody: string[] = [];
  for (const field of fields) newBody.push(blank, ...renderField(field, language, memberIndent));
  for (const member of keptMembers) newBody.push(blank, ...member);
  return [...lines.slice(0, bodyStart), ...newBody, ...lines.slice(end)].join(eol);
}

function renderField(field: DesignerField, language: Language, indent: string): string[] {
  const docs = FIELD_DOC.map(doc => `${indent}${language === 'cs' ? doc : doc.replace('/// ', "'''")}`.replace('{name}', field.name));
  return [...docs, language === 'cs' ? `${indent}protected global::${field.type} ${field.name};` : `${indent}Protected WithEvents ${field.name} As Global.${field.type}`];
}

/** A complete designer file in the current Visual Studio's format; used for new files and unrecognized layouts. */
export function renderDesigner(inherits: string, fields: DesignerField[], language: Language, projectPath: string | undefined, existing?: string): string {
  const bom = existing !== undefined && existing.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const eol = existing !== undefined && !existing.includes('\r\n') && existing.includes('\n') ? '\n' : '\r\n';
  const dot = inherits.lastIndexOf('.');
  let namespace = dot > 0 ? inherits.slice(0, dot) : '';
  const className = inherits.slice(dot + 1);
  const c = language === 'cs' ? '//' : "'";
  const lines = [
    `${c}------------------------------------------------------------------------------`,
    `${c} <auto-generated>`,
    `${c}     This code was generated by a tool.`,
    c,
    `${c}     Changes to this file may cause incorrect behavior and will be lost if`,
    `${c}     the code is regenerated. `,
    `${c} </auto-generated>`,
    `${c}------------------------------------------------------------------------------`,
    '',
  ];
  const ind = namespace ? '    ' : '';
  if (language === 'cs') {
    if (namespace) lines.push(`namespace ${namespace}`, '{', '', '');
    lines.push(`${ind}public partial class ${className}`, `${ind}{`);
    for (const field of fields) lines.push('', ...renderField(field, language, `${ind}    `));
    lines.push(`${ind}}`);
    if (namespace) lines.push('}');
  } else {
    // VB designer files sit in the project's root namespace implicitly.
    const root = (projectPath && /<RootNamespace>\s*([^<\s]+)\s*<\/RootNamespace>/i.exec(readText(projectPath) ?? '')?.[1]) || '';
    if (root && (namespace === root || namespace.startsWith(`${root}.`))) namespace = namespace.slice(root.length + 1);
    const vbInd = namespace ? '    ' : '';
    lines.push('Option Strict On', 'Option Explicit On', '', '');
    if (namespace) lines.push(`Namespace ${namespace}`);
    lines.push('', `${vbInd}Partial Public Class ${className}`);
    for (const field of fields) lines.push('', ...renderField(field, language, `${vbInd}    `));
    lines.push(`${vbInd}End Class`);
    if (namespace) lines.push('End Namespace');
  }
  return bom + lines.join(eol) + eol;
}

const FIELD_DOC = ['/// <summary>', '/// {name} control.', '/// </summary>', '/// <remarks>', '/// Auto-generated field.', '/// To modify move field declaration from designer file to code-behind file.', '/// </remarks>'];

// ---- project file ----

function addToProject(projectPath: string, designerPath: string, markupPath: string): string | undefined {
  const text = readText(projectPath);
  if (text === undefined || /<Project\s[^>]*\bSdk=/i.test(text)) return undefined;
  const projectDir = path.dirname(projectPath);
  const include = path.relative(projectDir, designerPath).replace(/\//g, '\\');
  const escaped = include.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`Include="${escaped}"`, 'i').test(text)) return undefined;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const compileRe = /^([ \t]*)<Compile\s+Include="([^"]+)"\s*(?:\/>|>[\s\S]*?<\/Compile>)[ \t]*\r?\n/gm;
  let insertAt = -1;
  let indent = '    ';
  for (let m = compileRe.exec(text); m; m = compileRe.exec(text)) {
    indent = m[1];
    // Keep Visual Studio's alphabetical order, so Foo.aspx.designer.cs lands right after Foo.aspx.cs.
    if (m[2].toLowerCase() > include.toLowerCase()) {
      insertAt = m.index;
      break;
    }
    insertAt = m.index + m[0].length;
  }
  const entry = [`${indent}<Compile Include="${include}">`, `${indent}  <DependentUpon>${path.basename(markupPath)}</DependentUpon>`, `${indent}</Compile>`].join(eol) + eol;
  const updated =
    insertAt >= 0 ? text.slice(0, insertAt) + entry + text.slice(insertAt) : text.replace(/<\/Project>\s*$/, `  <ItemGroup>${eol}${entry}  </ItemGroup>${eol}</Project>${eol}`);
  fs.writeFileSync(projectPath, updated, 'utf8');
  return `Added ${include} to ${path.basename(projectPath)}.`;
}

// ---- helpers ----

function findProjectFile(startDir: string): string | undefined {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // unreadable directory: keep walking up
    }
    const project = entries.find(e => /\.(cs|vb)proj$/i.test(e));
    if (project) return path.join(dir, project);
    if (path.dirname(dir) === dir) return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function shortName(type: string): string {
  return type.slice(type.lastIndexOf('.') + 1);
}
