import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { after, describe, test } from 'node:test';
import { BuildContext, builtAtKey, findChangedReferences, readProjectFacts } from '../references';
import { cleanup, makeProject, webProject } from './helpers';

after(cleanup);

/** An old-style library project with Debug/Release output folders and the given project references. */
function library(references: string[] = [], extra = ''): string {
  return [
    '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>',
    '    <Configuration Condition=" \'$(Configuration)\' == \'\' ">Debug</Configuration>',
    '    <OutputType>Library</OutputType>',
    '  </PropertyGroup>',
    '  <PropertyGroup Condition=" \'$(Configuration)|$(Platform)\' == \'Debug|AnyCPU\' ">',
    '    <OutputPath>bin\\Debug\\</OutputPath>',
    '  </PropertyGroup>',
    '  <PropertyGroup Condition=" \'$(Configuration)|$(Platform)\' == \'Release|AnyCPU\' ">',
    '    <OutputPath>bin\\Release\\</OutputPath>',
    '  </PropertyGroup>',
    extra,
    '  <ItemGroup>',
    ...references.map(r => `    <ProjectReference Include="${r}"><Name>x</Name></ProjectReference>`),
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\r\n');
}

/** A web project referencing the given projects. */
function web(references: string[]): string {
  return webProject('http://localhost:5000/').replace('</Project>', `<ItemGroup>${references.map(r => `<ProjectReference Include="${r}" />`).join('')}</ItemGroup></Project>`);
}

const HOUR = 3600 * 1000;
const base = Date.now() - 10 * HOUR;

/** Sets a file's modification time to `hours` after the base time. */
function touch(root: string, relative: string, hours: number): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  const time = new Date(base + hours * HOUR);
  fs.utimesSync(file, time, time);
}

function context(root: string, configuration = 'Debug'): BuildContext {
  return { configuration, platform: 'AnyCPU', solutionDir: root };
}

/** Web -> Data -> Core, Web -> Core, with every output built after its sources. */
function solution(): string {
  const root = makeProject({
    'Web/Web.csproj': web(['..\\Data\\Data.csproj', '..\\Core\\Core.csproj']),
    'Data/Data.csproj': library(['..\\Core\\Core.csproj']),
    'Data/Repository.cs': '',
    'Core/Core.csproj': library(),
    'Core/Model.cs': '',
  });
  for (const file of ['Web/Web.csproj', 'Data/Data.csproj', 'Data/Repository.cs', 'Core/Core.csproj', 'Core/Model.cs']) touch(root, file, 0);
  touch(root, 'Core/bin/Debug/Core.dll', 1);
  touch(root, 'Data/bin/Debug/Data.dll', 2);
  return root;
}

async function changed(root: string, builtAt?: Record<string, number>): Promise<string[]> {
  const result = await findChangedReferences([path.join(root, 'Web/Web.csproj')], context(root), builtAt);
  return result.toBuild.map(p => path.basename(p));
}

describe('findChangedReferences', () => {
  test('nothing to build when every output is newer than its inputs; references come dependencies first', async () => {
    const root = solution();
    const result = await findChangedReferences([path.join(root, 'Web/Web.csproj')], context(root));
    assert.deepEqual(result.toBuild, []);
    assert.deepEqual(result.checked, [path.join(root, 'Core/Core.csproj'), path.join(root, 'Data/Data.csproj')]);
    assert.deepEqual(result.notes, []);
  });

  test('a changed source builds that project and every project depending on it', async () => {
    const root = solution();
    touch(root, 'Core/Model.cs', 3);
    const result = await findChangedReferences([path.join(root, 'Web/Web.csproj')], context(root));
    assert.deepEqual(result.toBuild.map(p => path.basename(p)), ['Core.csproj', 'Data.csproj']);
    assert.deepEqual(result.notes, ['Core.csproj: Model.cs changed.', 'Data.csproj: Core.csproj changed.']);
  });

  test('a change high in the chain builds only that project', async () => {
    const root = solution();
    touch(root, 'Data/Sub/Query.cs', 3);
    assert.deepEqual(await changed(root), ['Data.csproj']);
  });

  test('a changed project file, a missing output, or a reference built more recently also count', async () => {
    let root = solution();
    touch(root, 'Data/Data.csproj', 3);
    assert.deepEqual(await changed(root), ['Data.csproj']);

    root = solution();
    fs.rmSync(path.join(root, 'Core/bin'), { recursive: true });
    assert.deepEqual(await changed(root), ['Core.csproj', 'Data.csproj']);

    root = solution();
    touch(root, 'Core/bin/Debug/Core.dll', 5);
    assert.deepEqual(await changed(root), ['Data.csproj']);
  });

  test('ignores output, obj, .user files and nested projects', async () => {
    const root = solution();
    for (const file of ['Core/obj/Debug/Core.dll', 'Core/bin/Release/Core.dll', 'Core/Core.csproj.user', 'Core/Tests/Tests.csproj', 'Core/Tests/Test.cs']) touch(root, file, 5);
    assert.deepEqual(await changed(root), []);
  });

  test('a build recorded after the change counts as up to date', async () => {
    const root = solution();
    touch(root, 'Core/readme.txt', 3);
    assert.deepEqual(await changed(root), ['Core.csproj', 'Data.csproj']);
    const builtAt = { [builtAtKey(path.join(root, 'Core/Core.csproj'), context(root))]: base + 4 * HOUR };
    assert.deepEqual(await changed(root, builtAt), []);
    assert.deepEqual(
      (await findChangedReferences([path.join(root, 'Web/Web.csproj')], context(root, 'Release'), builtAt)).notes,
      ['Core.csproj: not built yet.', 'Data.csproj: not built yet.'],
    );
  });

  test('profile projects are never listed; missing references and cycles are tolerated', async () => {
    const root = makeProject({
      'Web/Web.csproj': web(['..\\Api\\Api.csproj', '..\\A\\A.csproj', '..\\Gone\\Gone.csproj']),
      'Api/Api.csproj': web([]),
      'A/A.csproj': library(['..\\B\\B.csproj']),
      'B/B.csproj': library(['..\\A\\A.csproj']),
    });
    const result = await findChangedReferences([path.join(root, 'Web/Web.csproj'), path.join(root, 'Api/Api.csproj')], context(root));
    assert.deepEqual(result.checked.map(p => path.basename(p)), ['B.csproj', 'A.csproj']);
    assert.ok(result.notes.includes('Gone.csproj: referenced project not found; skipped.'));
  });
});

describe('readProjectFacts', () => {
  test('output for the configuration, AssemblyName, exe output types, $(SolutionDir) references and linked files', () => {
    const root = makeProject({
      'Tool/Tool.csproj': library(
        ['$(SolutionDir)Core\\Core.csproj', '..\\Data\\Data.csproj'],
        [
          '  <PropertyGroup><AssemblyName>My.Tool</AssemblyName><OutputType>WinExe</OutputType></PropertyGroup>',
          '  <ItemGroup><Compile Include="..\\Shared\\Version.cs"><Link>Version.cs</Link></Compile><Compile Include="Program.cs" /><Compile Include="..\\Shared\\*.cs" /></ItemGroup>',
        ].join('\r\n'),
      ),
    });
    const project = path.join(root, 'Tool/Tool.csproj');
    const debug = readProjectFacts(project, context(root));
    assert.equal(debug.outputFile, path.join(root, 'Tool/bin/Debug/My.Tool.exe'));
    assert.deepEqual(debug.references, [path.join(root, 'Core/Core.csproj'), path.join(root, 'Data/Data.csproj')]);
    assert.deepEqual(debug.linkedInputs, [path.join(root, 'Shared/Version.cs')]);
    assert.equal(readProjectFacts(project, context(root, 'Release')).outputFile, path.join(root, 'Tool/bin/Release/My.Tool.exe'));
    assert.equal(readProjectFacts(project, { ...context(root), platform: 'x64' }).outputFile, undefined);
  });

  test('SDK-style projects default to bin\\<Configuration>\\<TargetFramework>', () => {
    const root = makeProject({
      'Sdk/Sdk.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>',
      'Multi/Multi.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net48;net8.0</TargetFrameworks></PropertyGroup></Project>',
    });
    assert.equal(readProjectFacts(path.join(root, 'Sdk/Sdk.csproj'), context(root)).outputFile, path.join(root, 'Sdk/bin/Debug/net48/Sdk.dll'));
    assert.equal(readProjectFacts(path.join(root, 'Multi/Multi.csproj'), context(root)).outputFile, undefined);
  });
});
