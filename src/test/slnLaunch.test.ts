import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { after, describe, test } from 'node:test';
import { inspectProject, isLaunchableWebProject } from '../projects';
import {
  findSolutionFile,
  generateSlnLaunch,
  hasSlnLaunch,
  listSolutionProjects,
  parseSlnLaunch,
  profileLabelFromId,
  resolveProfileById,
  singleProjectProfile,
  slnLaunchPathFor,
} from '../slnLaunch';
import { LIBRARY_PROJECT, cleanup, makeProject, solution, webProject } from './helpers';

after(cleanup);

describe('parseSlnLaunch', () => {
  test('reads profiles, resolving project paths against the .slnLaunch folder', () => {
    const root = makeProject({
      'App.slnLaunch':
        '﻿' +
        JSON.stringify([
          { Name: 'Web + API', Projects: [{ Path: 'Web\\Web.csproj', Action: 'Start' }, { Path: 'Api\\Api.csproj', Action: 'StartWithoutDebugging' }] },
          { Name: 'Only valid actions', Projects: [{ Path: 'Web\\Web.csproj', Action: 'Nothing' }, { Path: 42, Action: 'Start' }, { Path: 'Tool\\Tool.csproj', Action: 'Start' }] },
          { Name: 'No projects array' },
          { Projects: [] },
        ]),
    });
    const file = path.join(root, 'App.slnLaunch');
    const profiles = parseSlnLaunch(file);
    assert.deepEqual(
      profiles.map(p => ({ id: p.id, name: p.name, projects: p.projects.map(x => `${path.relative(root, x.projectPath)}:${x.action}`) })),
      [
        { id: `sln|${file}|Web + API`, name: 'Web + API', projects: [`${path.join('Web', 'Web.csproj')}:Start`, `${path.join('Api', 'Api.csproj')}:StartWithoutDebugging`] },
        { id: `sln|${file}|Only valid actions`, name: 'Only valid actions', projects: [`${path.join('Tool', 'Tool.csproj')}:Start`] },
      ],
    );
    assert.equal(profiles[0].solutionDir, root);
    assert.equal(profiles[0].source, file);
  });

  test('invalid JSON, a non-array, or a missing file give no profiles', () => {
    const root = makeProject({ 'Bad.slnLaunch': '{ not json', 'Object.slnLaunch': '{"Name":"x"}' });
    for (const name of ['Bad.slnLaunch', 'Object.slnLaunch', 'Missing.slnLaunch']) assert.deepEqual(parseSlnLaunch(path.join(root, name)), []);
  });
});

describe('solutions', () => {
  test('slnLaunchPathFor and hasSlnLaunch (either file counts)', () => {
    const root = makeProject({ 'A.sln': '', 'B.sln': '', 'B.slnLaunch.user': '[]', 'C.slnx': '', 'C.slnLaunch': '[]' });
    assert.equal(slnLaunchPathFor(path.join(root, 'A.sln')), path.join(root, 'A.slnLaunch'));
    assert.equal(slnLaunchPathFor(path.join(root, 'C.slnx')), path.join(root, 'C.slnLaunch'));
    assert.equal(hasSlnLaunch(path.join(root, 'A.sln')), false);
    assert.equal(hasSlnLaunch(path.join(root, 'B.sln')), true);
    assert.equal(hasSlnLaunch(path.join(root, 'C.slnx')), true);
  });

  test('listSolutionProjects returns existing C#/VB projects in solution order', () => {
    const root = makeProject({
      'App.sln': solution(['Web\\Web.csproj', 'Lib\\Lib.vbproj', 'Gone\\Gone.csproj', 'Db\\Db.sqlproj']),
      'App.slnx': '<Solution>\n  <Folder Name="/src/">\n    <Project Path="Lib/Lib.vbproj" />\n    <Project Path="Web/Web.csproj" />\n    <Project Path="Db/Db.sqlproj" />\n  </Folder>\n</Solution>\n',
      'Web/Web.csproj': webProject('http://localhost:5000/'),
      'Lib/Lib.vbproj': LIBRARY_PROJECT,
      'Db/Db.sqlproj': '',
    });
    const web = path.join(root, 'Web', 'Web.csproj');
    const lib = path.join(root, 'Lib', 'Lib.vbproj');
    assert.deepEqual(listSolutionProjects(path.join(root, 'App.sln')), [web, lib]);
    assert.deepEqual(listSolutionProjects(path.join(root, 'App.slnx')), [lib, web]);
  });

  test('generateSlnLaunch: one profile per launchable web project, plus "All web projects"', () => {
    const root = makeProject({
      'App.sln': solution(['Web\\Web.csproj', 'Lib\\Lib.csproj', 'NoUrl\\NoUrl.csproj', 'Api\\Api.csproj']),
      'Web/Web.csproj': webProject('http://localhost:5000/'),
      'Lib/Lib.csproj': LIBRARY_PROJECT,
      'NoUrl/NoUrl.csproj': webProject(),
      'Api/Api.csproj': webProject('https://localhost:44300/api'),
    });
    const { file, entries } = generateSlnLaunch(path.join(root, 'App.sln'));
    assert.equal(file, path.join(root, 'App.slnLaunch'));
    const web = { Path: path.join('Web', 'Web.csproj'), Action: 'Start' };
    const api = { Path: path.join('Api', 'Api.csproj'), Action: 'Start' };
    assert.deepEqual(entries, [
      { Name: 'Web', Projects: [web] },
      { Name: 'Api', Projects: [api] },
      { Name: 'All web projects', Projects: [web, api] },
    ]);
  });

  test('generateSlnLaunch: a single web project gets no "All web projects"; none gives no entries', () => {
    const root = makeProject({
      'One.sln': solution(['Web\\Web.csproj', 'Lib\\Lib.csproj']),
      'None.sln': solution(['Lib\\Lib.csproj']),
      'Web/Web.csproj': webProject('http://localhost:5000/'),
      'Lib/Lib.csproj': LIBRARY_PROJECT,
    });
    assert.deepEqual(generateSlnLaunch(path.join(root, 'One.sln')).entries.map(e => e.Name), ['Web']);
    assert.deepEqual(generateSlnLaunch(path.join(root, 'None.sln')).entries, []);
  });

  test('findSolutionFile: the only solution, else the one named like the .slnLaunch', () => {
    const root = makeProject({
      'single/App.sln': '',
      'single/Other.slnLaunch': '[]',
      'multi/A.sln': '',
      'multi/B.slnx': '',
      'multi/B.slnLaunch.user': '[]',
      'multi/C.slnLaunch': '[]',
    });
    const profile = (dir: string, source: string) => ({ id: '', name: '', source: path.join(root, dir, source), solutionDir: path.join(root, dir), projects: [] });
    assert.equal(findSolutionFile(profile('single', 'Other.slnLaunch')), path.join(root, 'single', 'App.sln'));
    assert.equal(findSolutionFile(profile('multi', 'B.slnLaunch.user')), path.join(root, 'multi', 'B.slnx'));
    assert.equal(findSolutionFile(profile('multi', 'C.slnLaunch')), undefined);
    assert.equal(findSolutionFile(profile('missing', 'X.slnLaunch')), undefined);
  });
});

describe('profile ids', () => {
  test('singleProjectProfile finds the solution folder above the project', () => {
    const root = makeProject({ 'App.sln': '', 'src/Web/Web.csproj': webProject('http://localhost:5000/') });
    const project = path.join(root, 'src', 'Web', 'Web.csproj');
    assert.deepEqual(singleProjectProfile(project), {
      id: `proj|${project}`,
      name: 'Web',
      source: project,
      solutionDir: root,
      projects: [{ projectPath: project, action: 'Start' }],
    });
  });

  test('resolveProfileById round-trips project and .slnLaunch profiles, including names with "|"', () => {
    const root = makeProject({
      'App.sln': '',
      'App.slnLaunch': JSON.stringify([{ Name: 'Web | API', Projects: [{ Path: 'Web\\Web.csproj', Action: 'Start' }] }]),
      'Web/Web.csproj': webProject('http://localhost:5000/'),
    });
    const [profile] = parseSlnLaunch(path.join(root, 'App.slnLaunch'));
    assert.deepEqual(resolveProfileById(profile.id), profile);
    assert.equal(profileLabelFromId(profile.id), 'Web | API');

    const project = singleProjectProfile(path.join(root, 'Web', 'Web.csproj'));
    assert.deepEqual(resolveProfileById(project.id), project);
    assert.equal(profileLabelFromId(project.id), 'Web');
  });

  test('resolveProfileById: unknown profile name, missing file, or unknown kind', () => {
    const root = makeProject({ 'App.slnLaunch': '[]' });
    assert.equal(resolveProfileById(`sln|${path.join(root, 'App.slnLaunch')}|Gone`), undefined);
    assert.equal(resolveProfileById(`sln|${path.join(root, 'Missing.slnLaunch')}|X`), undefined);
    assert.equal(resolveProfileById(`other|${path.join(root, 'App.slnLaunch')}`), undefined);
    assert.equal(resolveProfileById('garbage'), undefined);
  });
});

describe('inspectProject', () => {
  test('detects web projects by the web application type GUID or <UseIISExpress>', () => {
    const root = makeProject({
      'Guid.csproj': webProject('http://localhost:5000/'),
      'Express.csproj': '<Project><PropertyGroup><UseIISExpress>true</UseIISExpress></PropertyGroup></Project>',
      'Lib.csproj': LIBRARY_PROJECT,
    });
    assert.equal(inspectProject(path.join(root, 'Guid.csproj')).isWeb, true);
    assert.equal(inspectProject(path.join(root, 'Express.csproj')).isWeb, true);
    assert.equal(inspectProject(path.join(root, 'Lib.csproj')).isWeb, false);
  });

  test('the .user file\'s <IISUrl> wins; a malformed one falls through to the project file', () => {
    const root = makeProject({
      'Web.csproj': webProject('http://localhost:5000/'),
      'Web.csproj.user': '<Project><IISUrl>https://localhost:44301/app</IISUrl></Project>',
      'Bad.csproj': webProject('http://localhost:5001/'),
      'Bad.csproj.user': '<Project><IISUrl>not a url</IISUrl></Project>',
    });
    const web = inspectProject(path.join(root, 'Web.csproj'));
    assert.equal(web.iisUrl?.href, 'https://localhost:44301/app');
    assert.equal(web.name, 'Web');
    assert.equal(web.dir, root);
    assert.equal(inspectProject(path.join(root, 'Bad.csproj')).iisUrl?.href, 'http://localhost:5001/');
  });

  test('isLaunchableWebProject needs both a web project and an <IISUrl>; a missing file is neither', () => {
    const root = makeProject({
      'Web.csproj': webProject('http://localhost:5000/'),
      'NoUrl.csproj': webProject(),
      'Lib.csproj': LIBRARY_PROJECT.replace('</Project>', '<IISUrl>http://localhost:5002/</IISUrl></Project>'),
    });
    assert.equal(isLaunchableWebProject(path.join(root, 'Web.csproj')), true);
    assert.equal(isLaunchableWebProject(path.join(root, 'NoUrl.csproj')), false);
    assert.equal(isLaunchableWebProject(path.join(root, 'Lib.csproj')), false);
    assert.equal(fs.existsSync(path.join(root, 'Missing.csproj')), false);
    assert.equal(isLaunchableWebProject(path.join(root, 'Missing.csproj')), false);
  });
});
