import * as fs from 'fs';
import * as path from 'path';

/** Folders that hold build output, packages or tooling state rather than project inputs. */
const IGNORED_DIRS = new Set(['bin', 'obj', '.vs', '.git', 'node_modules', 'packages', 'testresults']);
const IGNORED_FILE = /\.(user|suo)$/i;
const PROJECT_FILE = /\.(cs|vb)proj$/i;
const EXE_TYPES = new Set(['exe', 'winexe', 'appcontainerexe']);

export interface BuildContext {
  configuration: string;
  platform: string;
  solutionDir: string;
}

export interface ProjectFacts {
  projectPath: string;
  references: string[];
  /** The built assembly, or undefined when the project's output path couldn't be worked out. */
  outputFile?: string;
  /** Files outside the project folder that the project includes, e.g. linked source files. */
  linkedInputs: string[];
}

export interface ChangedReferences {
  /** Referenced projects to build, dependencies first. */
  toBuild: string[];
  /** Every referenced project found, dependencies first. */
  checked: string[];
  notes: string[];
}

/** Key under which the time a project was last built by this extension is kept. */
export function builtAtKey(projectPath: string, context: BuildContext): string {
  return `${context.configuration}|${context.platform}|${path.resolve(projectPath).toLowerCase()}`;
}

/**
 * Finds the projects the roots reference, directly or indirectly, that need building: the output is missing, a file
 * in the project changed after the output (and after `builtAt`), or a project it references needs building or was
 * built after it. Like Visual Studio's up-to-date check, this only looks at timestamps; MSBuild still decides what
 * to recompile.
 */
export async function findChangedReferences(roots: string[], context: BuildContext, builtAt: Record<string, number> = {}): Promise<ChangedReferences> {
  const rootKeys = new Set(roots.map(key));
  const facts = new Map<string, ProjectFacts>();
  const order: string[] = [];
  const notes: string[] = [];
  const visiting = new Set<string>();

  const visit = (projectPath: string): void => {
    const k = key(projectPath);
    if (facts.has(k) || visiting.has(k)) return;
    if (!fs.existsSync(projectPath)) {
      notes.push(`${path.basename(projectPath)}: referenced project not found; skipped.`);
      return;
    }
    visiting.add(k);
    const project = readProjectFacts(projectPath, context);
    for (const reference of project.references) visit(reference);
    visiting.delete(k);
    facts.set(k, project);
    if (!rootKeys.has(k)) order.push(projectPath);
  };
  for (const root of roots) visit(root);

  const stale = new Set<string>();
  const outputTimes = new Map<string, number | undefined>();
  for (const projectPath of order) {
    const project = facts.get(key(projectPath))!;
    const outputTime = project.outputFile ? mtime(project.outputFile) : undefined;
    outputTimes.set(key(projectPath), outputTime);
    const name = path.basename(projectPath);

    let reason: string | undefined;
    if (!project.outputFile) reason = 'output path unknown';
    else if (outputTime === undefined) reason = 'not built yet';
    else {
      const referenceChanged = project.references.find(r => {
        const k = key(r);
        return stale.has(k) || (outputTimes.get(k) ?? 0) > outputTime;
      });
      if (referenceChanged) reason = `${path.basename(referenceChanged)} changed`;
      else {
        const since = Math.max(outputTime, builtAt[builtAtKey(projectPath, context)] ?? 0);
        const changed = await newerInput(project, since);
        if (changed) reason = `${path.relative(path.dirname(projectPath), changed)} changed`;
      }
    }
    if (reason) {
      stale.add(key(projectPath));
      notes.push(`${name}: ${reason}.`);
    }
  }
  return { toBuild: order.filter(p => stale.has(key(p))), checked: order, notes };
}

/** Reads a project's references, output assembly and linked inputs for the given configuration and platform. */
export function readProjectFacts(projectPath: string, context: BuildContext): ProjectFacts {
  const text = fs.readFileSync(projectPath, 'utf8');
  const dir = path.dirname(projectPath);
  const props = evaluateProperties(text, projectPath, context);
  const expand = (value: string) => expandProperties(value, props);

  const references = [...text.matchAll(/<ProjectReference\s+Include\s*=\s*"([^"]+)"/gi)].map(m => path.resolve(dir, expand(decodeXml(m[1]))));

  const linkedInputs: string[] = [];
  for (const m of text.matchAll(/<(?:Compile|Content|EmbeddedResource|None|Resource)\s+Include\s*=\s*"([^"]+)"/gi)) {
    const include = expand(decodeXml(m[1]));
    if (/[*?;]/.test(include)) continue;
    const file = path.resolve(dir, include);
    if (!isInside(file, dir)) linkedInputs.push(file);
  }

  return { projectPath, references: [...new Set(references)], outputFile: outputFile(text, projectPath, props), linkedInputs };
}

function outputFile(text: string, projectPath: string, props: Map<string, string>): string | undefined {
  let outputPath = props.get('outdir') ?? props.get('outputpath');
  if (outputPath === undefined && /<Project\s[^>]*\bSdk\s*=/i.test(text)) {
    // SDK-style defaults: bin\[Platform\]Configuration\[TargetFramework\]
    const platform = props.get('platform') ?? 'AnyCPU';
    const framework = props.get('targetframework');
    if (!framework && props.has('targetframeworks')) return undefined;
    outputPath = path.join('bin', /^any\s?cpu$/i.test(platform) ? '' : platform, props.get('configuration') ?? 'Debug');
    if (framework && props.get('appendtargetframeworktooutputpath')?.toLowerCase() !== 'false') outputPath = path.join(outputPath, framework);
  }
  if (outputPath === undefined) return undefined;
  const assemblyName = props.get('assemblyname') || path.parse(projectPath).name;
  const extension = EXE_TYPES.has((props.get('outputtype') ?? '').toLowerCase()) ? '.exe' : '.dll';
  return path.resolve(path.dirname(projectPath), outputPath, assemblyName + extension);
}

/**
 * A small subset of MSBuild property evaluation: the project's own <PropertyGroup>s in order, honouring simple
 * `'a' == 'b'` / `'a' != 'b'` conditions joined by `and` / `or`. Imports aren't followed; anything the subset
 * can't evaluate is treated as false.
 */
export function evaluateProperties(text: string, projectPath: string, context: BuildContext): Map<string, string> {
  const globals = new Map<string, string>([
    ['configuration', context.configuration],
    ['platform', context.platform],
  ]);
  const solutionDir = context.solutionDir.endsWith('\\') || context.solutionDir.endsWith('/') ? context.solutionDir : `${context.solutionDir}\\`;
  const props = new Map<string, string>([
    ...globals,
    ['solutiondir', solutionDir],
    ['msbuildprojectdirectory', path.dirname(projectPath)],
    ['msbuildthisfiledirectory', `${path.dirname(projectPath)}\\`],
    ['msbuildprojectname', path.parse(projectPath).name],
  ]);
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const group of body.matchAll(/<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi)) {
    if (!conditionHolds(attribute(group[1], 'Condition'), props)) continue;
    for (const prop of group[2].matchAll(/<([\w.]+)\b([^>]*)>([^<]*)<\/\1>/g)) {
      const name = prop[1].toLowerCase();
      // Configuration and Platform are passed on the command line, so the project can't change them.
      if (globals.has(name) || !conditionHolds(attribute(prop[2], 'Condition'), props)) continue;
      props.set(name, expandProperties(decodeXml(prop[3].trim()), props));
    }
  }
  return props;
}

function conditionHolds(condition: string | undefined, props: Map<string, string>): boolean {
  if (condition === undefined || condition.trim() === '') return true;
  const expanded = expandProperties(decodeXml(condition), props);
  return expanded.split(/\s+or\s+/i).some(clause =>
    clause.split(/\s+and\s+/i).every(term => {
      const m = /^\s*'([^']*)'\s*(==|!=)\s*'([^']*)'\s*$/.exec(term);
      if (!m) return false;
      const equal = m[1].trim().toLowerCase() === m[3].trim().toLowerCase();
      return m[2] === '==' ? equal : !equal;
    }),
  );
}

function expandProperties(value: string, props: Map<string, string>): string {
  return value.replace(/\$\(([\w.]+)\)/g, (_, name: string) => props.get(name.toLowerCase()) ?? '');
}

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1];
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** The first project input modified after `since`, if any: the project file, its folder (minus output and nested projects) and linked files. */
async function newerInput(project: ProjectFacts, since: number): Promise<string | undefined> {
  const isNewer = (file: string) => (mtime(file) ?? 0) > since;
  if (isNewer(project.projectPath)) return project.projectPath;
  const linked = project.linkedInputs.find(isNewer);
  if (linked) return linked;

  const outputDir = project.outputFile && path.dirname(project.outputFile).toLowerCase();
  const pending = [path.dirname(project.projectPath)];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // A nested folder with its own project file belongs to that project.
    if (dir !== path.dirname(project.projectPath) && entries.some(e => e.isFile() && PROJECT_FILE.test(e.name))) continue;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name.toLowerCase()) && full.toLowerCase() !== outputDir) pending.push(full);
      } else if (entry.isFile() && !IGNORED_FILE.test(entry.name) && isNewer(full)) {
        return full;
      }
    }
  }
  return undefined;
}

function mtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function key(projectPath: string): string {
  return path.resolve(projectPath).toLowerCase();
}
