import './vscodeHook';
import * as assert from 'assert/strict';
import * as path from 'path';
import { after, afterEach, describe, test } from 'node:test';
import { buildProjects, buildSolution, findMsBuild } from '../msbuild';
import { Settings } from '../settings';
import { run } from '../util';
import { cleanup, makeProject } from './helpers';
import { Task, stub } from './vscodeStub';

after(cleanup);
afterEach(() => {
  stub.executed = [];
  stub.runTask = async () => 0;
});

const onWindows = process.platform === 'win32' ? false : 'needs Windows PowerShell';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    configuration: 'Debug',
    platform: 'AnyCPU',
    solutionPlatform: 'Any CPU',
    restoreBeforeSolutionBuild: true,
    debugType: 'portable',
    buildProjectReferences: false,
    buildChangedReferences: true,
    buildBeforeRun: true,
    additionalMsbuildArgs: [],
    // Any existing file will do as "MSBuild" unless the task is actually run.
    msbuildPath: process.execPath,
    iisExpressPath: '',
    applicationPool: 'Clr4IntegratedAppPool',
    bindAllHostnames: true,
    justMyCode: true,
    stopSitesWhenDebuggingStops: true,
    startupTimeoutSeconds: 60,
    generateDesignerOnSave: true,
    tableVisualizerMaxRows: 1000,
    ...overrides,
  };
}

/** The PowerShell script a build task runs, decoded from its -EncodedCommand. */
function script(task: Task): string {
  const args = task.execution.args;
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
}

describe('findMsBuild', () => {
  test('uses remoteSshWebForm.msbuildPath when set, and reports it when missing', async () => {
    assert.equal(await findMsBuild(settings()), process.execPath);
    await assert.rejects(findMsBuild(settings({ msbuildPath: 'C:\\nowhere\\MSBuild.exe' })), /msbuildPath does not exist: C:\\nowhere\\MSBuild\.exe/);
  });
});

describe('build tasks', () => {
  test('buildProjects runs one MSBuild per distinct project in a single $msCompile task', async () => {
    const ok = await buildProjects(['C:\\src\\Web\\Web.csproj', 'C:\\src\\Api\\Api.csproj', 'C:\\src\\Web\\Web.csproj'], 'C:\\src', settings({ additionalMsbuildArgs: ['/p:Extra=1'] }));
    assert.equal(ok, true);
    assert.equal(stub.executed.length, 1);
    const [task] = stub.executed;
    assert.equal(task.name, 'Build');
    assert.equal(task.problemMatchers, '$msCompile');
    assert.equal(task.execution.process, 'powershell.exe');

    const lines = script(task).split('\n');
    const msbuild = `& '${process.execPath}'`;
    const common = "'/t:Build' '/p:Configuration=Debug' '/p:Platform=AnyCPU' '/p:DebugType=portable' '/p:SolutionDir=C:\\src\\' '/p:BuildProjectReferences=false' '/m' '/nologo' '/v:minimal' '/p:Extra=1'";
    assert.deepEqual(lines, [
      "$ProgressPreference = 'SilentlyContinue'",
      'Remove-Item Env:\\NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue',
      '$failed = 0',
      "Write-Host '==> Web.csproj'",
      `${msbuild} 'C:\\src\\Web\\Web.csproj' ${common}`,
      'if ($LASTEXITCODE -ne 0) { $failed = $LASTEXITCODE }',
      "Write-Host '==> Api.csproj'",
      `${msbuild} 'C:\\src\\Api\\Api.csproj' ${common}`,
      'if ($LASTEXITCODE -ne 0) { $failed = $LASTEXITCODE }',
      'exit $failed',
    ]);
  });

  test('references build first, without their own references, and stop the build when one fails', async () => {
    await buildProjects(['C:\\src\\Web\\Web.csproj'], 'C:\\src', settings({ buildProjectReferences: true }), ['C:\\src\\Core\\Core.csproj', 'C:\\src\\Data\\Data.csproj']);
    const lines = script(stub.executed[0]).split('\n').slice(3, -1);
    assert.deepEqual(lines.filter(l => l.startsWith('Write-Host')), ["Write-Host '==> Core.csproj'", "Write-Host '==> Data.csproj'", "Write-Host '==> Web.csproj'"]);
    const [core, data, web] = lines.filter(l => l.startsWith('& '));
    assert.ok(core.includes("'/p:BuildProjectReferences=false'") && data.includes("'/p:BuildProjectReferences=false'"));
    assert.ok(web.includes("'/p:BuildProjectReferences=true'"));
    assert.deepEqual(lines.filter(l => l.startsWith('if ')), [
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      'if ($LASTEXITCODE -ne 0) { $failed = $LASTEXITCODE }',
    ]);
  });

  test('a non-zero exit code means the build failed', async () => {
    stub.runTask = async () => 1;
    assert.equal(await buildProjects(['C:\\src\\Web\\Web.csproj'], 'C:\\src', settings()), false);
    stub.runTask = async () => undefined;
    assert.equal(await buildProjects(['C:\\src\\Web\\Web.csproj'], 'C:\\src', settings()), false);
  });

  test('buildSolution uses the solution platform and restores packages.config projects when enabled', async () => {
    await buildSolution('C:\\src\\App.sln', settings());
    await buildSolution('C:\\src\\App.sln', settings({ restoreBeforeSolutionBuild: false, configuration: 'Release' }));
    const [withRestore, withoutRestore] = stub.executed.map(t => script(t).split('\n').find(l => l.startsWith('& '))!);
    assert.equal(stub.executed[0].name, 'Build Solution');
    assert.ok(withRestore.endsWith("'C:\\src\\App.sln' '/t:Build' '/p:Configuration=Debug' '/p:Platform=Any CPU' '/p:DebugType=portable' '/m' '/nologo' '/v:minimal' '/restore' '/p:RestorePackagesConfig=true'"));
    assert.ok(withoutRestore.endsWith("'/p:Configuration=Release' '/p:Platform=Any CPU' '/p:DebugType=portable' '/m' '/nologo' '/v:minimal'"));
  });

  test('a missing MSBuild fails before any task starts', async () => {
    await assert.rejects(buildProjects(['C:\\src\\Web\\Web.csproj'], 'C:\\src', settings({ msbuildPath: 'C:\\nowhere\\MSBuild.exe' })));
    assert.equal(stub.executed.length, 0);
  });
});

describe('running the generated script', () => {
  // "MSBuild" is node.exe and each "project" is a script that prints the arguments it received, so these tests
  // see exactly what MSBuild would get after PowerShell 5.1 quotes the native command line.
  function project(root: string, name: string): string {
    return path.join(root, name);
  }

  /** Makes executed tasks really run; the returned object receives the last task's output. */
  function runForReal(): { stdout: string } {
    const output = { stdout: '' };
    stub.runTask = async task => {
      const result = await run(task.execution.process, task.execution.args);
      output.stdout = result.stdout;
      return result.code;
    };
    return output;
  }

  const received = (stdout: string) => stdout.split(/\r?\n/).filter(l => l.startsWith('[')).map(l => JSON.parse(l) as string[]);

  test('SolutionDir arrives with exactly one trailing backslash, with or without spaces', { skip: onWindows }, async () => {
    const root = makeProject({ 'echo.js': 'console.log(JSON.stringify(process.argv.slice(2)))' });
    const output = runForReal();
    for (const solutionDir of ['C:\\src', 'C:\\My Projects\\App\\']) {
      assert.equal(await buildProjects([project(root, 'echo.js')], solutionDir, settings()), true);
      const [args] = received(output.stdout);
      assert.equal(args.find(a => a.startsWith('/p:SolutionDir=')), `/p:SolutionDir=${solutionDir.replace(/\\?$/, '\\')}`);
      assert.ok(args.includes('/p:Configuration=Debug'));
    }
  });

  test('every project builds even after one fails, and the failure is reported', { skip: onWindows }, async () => {
    const root = makeProject({
      'fail.js': 'console.log(JSON.stringify(["fail"])); process.exit(5)',
      'pass.js': 'console.log(JSON.stringify(["pass", process.env.NoDefaultCurrentDirectoryInExePath ?? "unset"]))',
    });
    const output = runForReal();
    const previous = process.env.NoDefaultCurrentDirectoryInExePath;
    process.env.NoDefaultCurrentDirectoryInExePath = '1';
    try {
      assert.equal(await buildProjects([project(root, 'fail.js'), project(root, 'pass.js')], root, settings()), false);
    } finally {
      if (previous === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
      else process.env.NoDefaultCurrentDirectoryInExePath = previous;
    }
    assert.deepEqual(received(output.stdout), [['fail'], ['pass', 'unset']]);
  });

  test('a failed reference skips everything after it', { skip: onWindows }, async () => {
    const root = makeProject({
      'fail.js': 'console.log(JSON.stringify(["fail"])); process.exit(5)',
      'pass.js': 'console.log(JSON.stringify(["pass"]))',
    });
    const output = runForReal();
    assert.equal(await buildProjects([project(root, 'pass.js')], root, settings(), [project(root, 'fail.js'), project(root, 'pass.js')]), false);
    assert.deepEqual(received(output.stdout), [['fail']]);
  });
});
