import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Settings } from './settings';
import { powerShellArgs, psQuote, run } from './util';

const TASK_TYPE = 'remoteSshWebForm';

export async function findMsBuild(settings: Settings): Promise<string> {
  if (settings.msbuildPath) {
    if (!fs.existsSync(settings.msbuildPath)) throw new Error(`remoteSshWebForm.msbuildPath does not exist: ${settings.msbuildPath}`);
    return settings.msbuildPath;
  }
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) {
    throw new Error('vswhere.exe not found. Install Visual Studio or Build Tools for Visual Studio 2022, or set remoteSshWebForm.msbuildPath.');
  }
  const { stdout } = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe']);
  const found = stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean);
  if (!found) throw new Error('MSBuild.exe not found via vswhere. Install the MSBuild component, or set remoteSshWebForm.msbuildPath.');
  return found;
}

export async function buildProjects(projectPaths: string[], solutionDir: string, settings: Settings): Promise<boolean> {
  const invocations = [...new Set(projectPaths)].map(projectPath => [
    projectPath,
    '/t:Build',
    `/p:Configuration=${settings.configuration}`,
    `/p:Platform=${settings.platform}`,
    `/p:DebugType=${settings.debugType}`,
    solutionDirProperty(solutionDir),
    `/p:BuildProjectReferences=${settings.buildProjectReferences}`,
    '/m',
    '/nologo',
    '/v:minimal',
    ...settings.additionalMsbuildArgs,
  ]);
  return runMsBuild('Build', invocations, settings);
}

/** Builds every project in the solution, restoring NuGet packages first (including packages.config projects). */
export async function buildSolution(solutionPath: string, settings: Settings): Promise<boolean> {
  const args = [
    solutionPath,
    '/t:Build',
    `/p:Configuration=${settings.configuration}`,
    `/p:Platform=${settings.solutionPlatform}`,
    `/p:DebugType=${settings.debugType}`,
    '/m',
    '/nologo',
    '/v:minimal',
    ...settings.additionalMsbuildArgs,
  ];
  if (settings.restoreBeforeSolutionBuild) args.push('/restore', '/p:RestorePackagesConfig=true');
  return runMsBuild('Build Solution', [args], settings);
}

/** Runs the MSBuild invocations in order inside one VS Code task, so output lands in one terminal and $msCompile fills the Problems panel. */
async function runMsBuild(taskName: string, invocations: string[][], settings: Settings): Promise<boolean> {
  const msbuild = await findMsBuild(settings);
  const lines = [
    "$ProgressPreference = 'SilentlyContinue'",
    // Pre/post-build events that call batch files by bare name fail with MSB3073 / exit 9009 when this is set.
    'Remove-Item Env:\\NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue',
    '$failed = 0',
  ];
  for (const args of invocations) {
    lines.push(`Write-Host ${psQuote(`==> ${path.basename(args[0])}`)}`);
    lines.push(`& ${psQuote(msbuild)} ${args.map(psQuote).join(' ')}`);
    lines.push('if ($LASTEXITCODE -ne 0) { $failed = $LASTEXITCODE }');
  }
  lines.push('exit $failed');

  const definition = { type: TASK_TYPE, action: 'build', id: randomUUID() };
  const task = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,
    taskName,
    'Remote SSH WebForm',
    new vscode.ProcessExecution('powershell.exe', powerShellArgs(lines.join('\n'))),
    '$msCompile',
  );
  task.group = vscode.TaskGroup.Build;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  return (await runTask(task, definition.id)) === 0;
}

function solutionDirProperty(dir: string): string {
  let value = dir.endsWith('\\') ? dir : `${dir}\\`;
  // PowerShell 5.1 quotes native args containing spaces without escaping a trailing backslash,
  // which would otherwise swallow the closing quote.
  if (/\s/.test(value)) value += '\\';
  return `/p:SolutionDir=${value}`;
}

function runTask(task: vscode.Task, id: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const subscription = vscode.tasks.onDidEndTaskProcess(e => {
      if (e.execution.task.definition.id !== id) return;
      subscription.dispose();
      resolve(e.exitCode);
    });
    vscode.tasks.executeTask(task).then(undefined, error => {
      subscription.dispose();
      reject(error);
    });
  });
}
