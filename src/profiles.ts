import * as vscode from 'vscode';
import { isLaunchableWebProject } from './projects';
import { LaunchProfile, hasSlnLaunch, parseSlnLaunch, singleProjectProfile } from './slnLaunch';

const SEARCH_EXCLUDE = '{**/node_modules/**,**/bin/**,**/obj/**,**/.git/**,**/.vs/**,**/packages/**}';

export async function discoverSlnLaunchProfiles(): Promise<LaunchProfile[]> {
  const files = await vscode.workspace.findFiles('**/*.{slnLaunch,slnLaunch.user}', SEARCH_EXCLUDE, 50);
  // Visual Studio launches from the .user file when both exist, so prefer it.
  const preferred = new Map<string, string>();
  for (const { fsPath } of files) {
    const key = fsPath.replace(/\.user$/i, '').toLowerCase();
    if (!preferred.has(key) || /\.user$/i.test(fsPath)) preferred.set(key, fsPath);
  }
  return [...preferred.values()].sort().flatMap(parseSlnLaunch);
}

export async function discoverSolutions(): Promise<string[]> {
  const files = await vscode.workspace.findFiles('**/*.{sln,slnx}', SEARCH_EXCLUDE, 50);
  return files.map(f => f.fsPath).sort();
}

export async function discoverSolutionsWithoutSlnLaunch(): Promise<string[]> {
  return (await discoverSolutions()).filter(p => !hasSlnLaunch(p));
}

export async function discoverWebProjectProfiles(): Promise<LaunchProfile[]> {
  const files = await vscode.workspace.findFiles('**/*.{csproj,vbproj}', SEARCH_EXCLUDE, 1000);
  return files
    .map(f => f.fsPath)
    .filter(isLaunchableWebProject)
    .sort()
    .map(singleProjectProfile);
}
