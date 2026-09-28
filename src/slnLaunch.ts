import * as fs from 'fs';
import * as path from 'path';

export type ProjectAction = 'Start' | 'StartWithoutDebugging';

export interface ProfileProject {
  csprojPath: string;
  action: ProjectAction;
}

export interface LaunchProfile {
  id: string;
  name: string;
  /** The .slnLaunch file, or the .csproj for a single-project profile. */
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
      projects.push({ csprojPath: path.resolve(solutionDir, project.Path), action: project.Action });
    }
    profiles.push({ id: `sln|${file}|${entry.Name}`, name: entry.Name, source: file, solutionDir, projects });
  }
  return profiles;
}

export function singleProjectProfile(csprojPath: string): LaunchProfile {
  return {
    id: `proj|${csprojPath}`,
    name: path.basename(csprojPath, '.csproj'),
    source: csprojPath,
    solutionDir: findSolutionDir(path.dirname(csprojPath)),
    projects: [{ csprojPath, action: 'Start' }],
  };
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
  return kind === 'proj' ? path.basename(file ?? '', '.csproj') : rest.join('|');
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
