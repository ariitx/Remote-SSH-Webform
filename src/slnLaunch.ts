import * as fs from 'fs';
import * as path from 'path';
import { isLaunchableWebProject } from './projects';

export type ProjectAction = 'Start' | 'StartWithoutDebugging';

export interface ProfileProject {
  projectPath: string;
  action: ProjectAction;
}

export interface LaunchProfile {
  id: string;
  name: string;
  /** The .slnLaunch file, or the project file for a single-project profile. */
  source: string;
  solutionDir: string;
  projects: ProfileProject[];
}

export function parseSlnLaunch(file: string): LaunchProfile[] {
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];

  const solutionDir = path.dirname(file);
  const profiles: LaunchProfile[] = [];
  for (const entry of entries) {
    if (typeof entry?.Name !== 'string' || !Array.isArray(entry.Projects)) continue;
    const projects: ProfileProject[] = [];
    for (const project of entry.Projects) {
      if (typeof project?.Path !== 'string') continue;
      if (project.Action !== 'Start' && project.Action !== 'StartWithoutDebugging') continue;
      projects.push({ projectPath: path.resolve(solutionDir, project.Path), action: project.Action });
    }
    profiles.push({ id: `sln|${file}|${entry.Name}`, name: entry.Name, source: file, solutionDir, projects });
  }
  return profiles;
}

interface SlnLaunchEntry {
  Name: string;
  Projects: { Path: string; Action: ProjectAction }[];
}

/** Visual Studio looks for "<solution name>.slnLaunch" next to the solution file. */
export function slnLaunchPathFor(solutionPath: string): string {
  return path.join(path.dirname(solutionPath), `${path.parse(solutionPath).name}.slnLaunch`);
}

export function hasSlnLaunch(solutionPath: string): boolean {
  const file = slnLaunchPathFor(solutionPath);
  return fs.existsSync(file) || fs.existsSync(`${file}.user`);
}

/** Absolute paths of the C# / VB.NET projects listed in a .sln or .slnx, in solution order. */
export function listSolutionProjects(solutionPath: string): string[] {
  const text = fs.readFileSync(solutionPath, 'utf8');
  const pattern = /\.slnx$/i.test(solutionPath)
    ? /<Project\s+Path="([^"]+\.(?:cs|vb)proj)"/gi
    : /^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+\.(?:cs|vb)proj)"/gim;
  const dir = path.dirname(solutionPath);
  const projects: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const full = path.resolve(dir, match[1]);
    if (fs.existsSync(full)) projects.push(full);
  }
  return projects;
}

/**
 * Builds .slnLaunch content for a solution: one profile per IIS Express web project, plus an
 * "All web projects" profile when there are several. Returns no entries if the solution has no web project.
 */
export function generateSlnLaunch(solutionPath: string): { file: string; entries: SlnLaunchEntry[] } {
  const dir = path.dirname(solutionPath);
  const webProjects = listSolutionProjects(solutionPath).filter(isLaunchableWebProject);
  const entry = (name: string, projects: string[]): SlnLaunchEntry => ({
    Name: name,
    Projects: projects.map(p => ({ Path: path.relative(dir, p), Action: 'Start' })),
  });
  const entries = webProjects.map(p => entry(path.parse(p).name, [p]));
  if (webProjects.length > 1) entries.push(entry('All web projects', webProjects));
  return { file: slnLaunchPathFor(solutionPath), entries };
}

export function singleProjectProfile(projectPath: string): LaunchProfile {
  return {
    id: `proj|${projectPath}`,
    name: path.parse(projectPath).name,
    source: projectPath,
    solutionDir: findSolutionDir(path.dirname(projectPath)),
    projects: [{ projectPath, action: 'Start' }],
  };
}

/** The .sln/.slnx a profile belongs to: the only one in its solution folder, or the one named like its .slnLaunch. */
export function findSolutionFile(profile: LaunchProfile): string | undefined {
  let solutions: string[];
  try {
    solutions = fs.readdirSync(profile.solutionDir).filter(n => /\.slnx?$/i.test(n));
  } catch {
    return undefined;
  }
  const launchBase = path.basename(profile.source).replace(/\.slnLaunch(\.user)?$/i, '').toLowerCase();
  const match = solutions.length === 1 ? solutions[0] : solutions.find(n => path.parse(n).name.toLowerCase() === launchBase);
  return match ? path.join(profile.solutionDir, match) : undefined;
}

export function resolveProfileById(id: string): LaunchProfile | undefined {
  const [kind, file, ...rest] = id.split('|');
  if (!file || !fs.existsSync(file)) return undefined;
  if (kind === 'proj') return singleProjectProfile(file);
  if (kind === 'sln') return parseSlnLaunch(file).find(p => p.name === rest.join('|'));
  return undefined;
}

export function profileLabelFromId(id: string): string {
  const [kind, file, ...rest] = id.split('|');
  return kind === 'proj' ? path.parse(file ?? '').name : rest.join('|');
}

function findSolutionDir(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    try {
      if (fs.readdirSync(dir).some(n => /\.slnx?$/i.test(n))) return dir;
    } catch {
      // unreadable directory: keep walking up
    }
    if (path.dirname(dir) === dir) return start;
  }
}
