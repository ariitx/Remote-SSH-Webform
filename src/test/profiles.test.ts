import './vscodeHook';
import * as assert from 'assert/strict';
import * as path from 'path';
import { after, afterEach, describe, test } from 'node:test';
import { discoverSlnLaunchProfiles, discoverSolutionsWithoutSlnLaunch, discoverWebProjectProfiles } from '../profiles';
import { LIBRARY_PROJECT, cleanup, makeProject, webProject } from './helpers';
import { stub } from './vscodeStub';

after(cleanup);
afterEach(() => (stub.files = {}));

const SLN_LAUNCH_GLOB = '**/*.{slnLaunch,slnLaunch.user}';
const SOLUTION_GLOB = '**/*.{sln,slnx}';
const PROJECT_GLOB = '**/*.{csproj,vbproj}';

const launch = (...names: string[]) => JSON.stringify(names.map(Name => ({ Name, Projects: [] })));

describe('profile discovery', () => {
  test('a .slnLaunch.user replaces its .slnLaunch, as in Visual Studio; files are listed in path order', async () => {
    const root = makeProject({
      'B/B.slnLaunch': launch('B1'),
      'A/A.slnLaunch': launch('A shared'),
      'A/A.slnLaunch.user': launch('A mine', 'A mine too'),
    });
    stub.files[SLN_LAUNCH_GLOB] = ['B/B.slnLaunch', 'A/A.slnLaunch.user', 'A/A.slnLaunch'].map(f => path.join(root, f));
    const profiles = await discoverSlnLaunchProfiles();
    assert.deepEqual(profiles.map(p => p.name), ['A mine', 'A mine too', 'B1']);
    assert.equal(profiles[0].source, path.join(root, 'A', 'A.slnLaunch.user'));
  });

  test('solutions are offered for .slnLaunch creation only when they have none', async () => {
    const root = makeProject({ 'A.sln': '', 'B.slnx': '', 'B.slnLaunch': '[]', 'C.sln': '', 'C.slnLaunch.user': '[]' });
    stub.files[SOLUTION_GLOB] = ['C.sln', 'B.slnx', 'A.sln'].map(f => path.join(root, f));
    assert.deepEqual(await discoverSolutionsWithoutSlnLaunch(), [path.join(root, 'A.sln')]);
  });

  test('only web projects with an <IISUrl> become single-project profiles', async () => {
    const root = makeProject({
      'App.sln': '',
      'Web/Web.csproj': webProject('http://localhost:5000/'),
      'Legacy/Legacy.vbproj': webProject('http://localhost:5001/'),
      'NoUrl/NoUrl.csproj': webProject(),
      'Lib/Lib.csproj': LIBRARY_PROJECT,
    });
    stub.files[PROJECT_GLOB] = ['Web/Web.csproj', 'NoUrl/NoUrl.csproj', 'Lib/Lib.csproj', 'Legacy/Legacy.vbproj'].map(f => path.join(root, f));
    const profiles = await discoverWebProjectProfiles();
    assert.deepEqual(profiles.map(p => p.name), ['Legacy', 'Web']);
    assert.ok(profiles.every(p => p.solutionDir === root && p.id.startsWith('proj|')));
  });
});
