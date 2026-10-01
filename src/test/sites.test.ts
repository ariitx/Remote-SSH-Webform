import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { after, describe, test } from 'node:test';
import { LaunchProfile, ProjectAction } from '../slnLaunch';
import { SiteSpec, findIisExpress, renderApplicationHostConfig, resolveSites, templatePathFor } from '../sites';
import { LIBRARY_PROJECT, cleanup, makeProject, webProject } from './helpers';

after(cleanup);

function profile(root: string, projects: [string, ProjectAction][]): LaunchProfile {
  return { id: 'test', name: 'test', source: root, solutionDir: root, projects: projects.map(([p, action]) => ({ projectPath: path.join(root, p), action })) };
}

describe('resolveSites', () => {
  test('one site per web project, with URL, app path and debug flag', async () => {
    const root = makeProject({
      'Web/Web.csproj': webProject('http://localhost:5000/'),
      'Api/Api.csproj': webProject('http://localhost:5001/api/v1/'),
      'Plain/Plain.csproj': webProject('http://localhost/'),
    });
    const { sites, notes } = await resolveSites(
      profile(root, [
        ['Web/Web.csproj', 'Start'],
        ['Api/Api.csproj', 'StartWithoutDebugging'],
        ['Plain/Plain.csproj', 'Start'],
      ]),
    );
    assert.deepEqual(notes, []);
    assert.deepEqual(sites, [
      { name: 'Web', projectDir: path.join(root, 'Web'), protocol: 'http', port: 5000, appPath: '/', debug: true, url: 'http://localhost:5000/' },
      { name: 'Api', projectDir: path.join(root, 'Api'), protocol: 'http', port: 5001, appPath: '/api/v1', debug: false, url: 'http://localhost:5001/api/v1/' },
      { name: 'Plain', projectDir: path.join(root, 'Plain'), protocol: 'http', port: 80, appPath: '/', debug: true, url: 'http://localhost:80/' },
    ]);
  });

  test('skips, with a note, projects that are missing, not web, without <IISUrl>, or on a taken port', async () => {
    const root = makeProject({
      'Web/Web.csproj': webProject('http://localhost:5000/'),
      'Lib/Lib.csproj': LIBRARY_PROJECT,
      'NoUrl/NoUrl.csproj': webProject(),
      'Clash/Clash.csproj': webProject('http://localhost:5000/other'),
    });
    const { sites, notes } = await resolveSites(
      profile(root, [
        ['Web/Web.csproj', 'Start'],
        ['Missing/Missing.csproj', 'Start'],
        ['Lib/Lib.csproj', 'Start'],
        ['NoUrl/NoUrl.csproj', 'Start'],
        ['Clash/Clash.csproj', 'Start'],
      ]),
    );
    assert.deepEqual(sites.map(s => s.name), ['Web']);
    assert.equal(notes.length, 4);
    assert.match(notes[0], /Missing\.csproj: project file not found/);
    assert.match(notes[1], /Lib\.csproj: not an IIS Express web project/);
    assert.match(notes[2], /NoUrl\.csproj: no <IISUrl>/);
    assert.match(notes[3], /Clash\.csproj: port 5000 is already used by Web/);
  });

  test('projects with the same name get distinct site names', async () => {
    const root = makeProject({
      'a/Web/Web.csproj': webProject('http://localhost:5000/'),
      'b/Web/Web.csproj': webProject('http://localhost:5001/'),
      'c/web/web.csproj': webProject('http://localhost:5002/'),
    });
    const { sites } = await resolveSites(
      profile(root, [
        ['a/Web/Web.csproj', 'Start'],
        ['b/Web/Web.csproj', 'Start'],
        ['c/web/web.csproj', 'Start'],
      ]),
    );
    assert.deepEqual(sites.map(s => s.name), ['Web', 'Web_2', 'web_3']);
  });

  test('https without a certificate bound to the port is skipped with a note', async () => {
    // Port 1 never has an IIS Express development certificate (those are bound to 44300-44399).
    const root = makeProject({ 'Secure/Secure.csproj': webProject('https://localhost:1/') });
    const { sites, notes } = await resolveSites(profile(root, [['Secure/Secure.csproj', 'Start']]));
    assert.deepEqual(sites, []);
    assert.match(notes[0], /https on port 1, but no certificate is bound to 0\.0\.0\.0:1/);
  });
});

describe('applicationhost.config', () => {
  const TEMPLATE = [
    '<configuration>',
    '    <system.applicationHost>',
    '        <sites>',
    '            <site name="WebSite1" id="1" serverAutoStart="true">',
    '                <application path="/">',
    '                    <virtualDirectory path="/" physicalPath="%IIS_SITES_HOME%\\WebSite1" />',
    '                </application>',
    '                <bindings>',
    '                    <binding protocol="http" bindingInformation=":8080:localhost" />',
    '                </bindings>',
    '            </site>',
    '            <siteDefaults>',
    '                <logFile logFormat="W3C" />',
    '            </siteDefaults>',
    '        </sites>',
    '    </system.applicationHost>',
    '</configuration>',
    '',
  ].join('\n');

  const site = (overrides: Partial<SiteSpec>): SiteSpec => ({
    name: 'Web',
    projectDir: 'C:\\src\\Web',
    protocol: 'http',
    port: 5000,
    appPath: '/',
    debug: true,
    url: 'http://localhost:5000/',
    ...overrides,
  });
  const options = { bindAllHostnames: true, applicationPool: 'Clr4IntegratedAppPool', emptyRootDir: 'C:\\storage\\empty-root' };

  test('replaces the sample site with one site per spec, before <siteDefaults>', () => {
    const config = renderApplicationHostConfig(TEMPLATE, [site({}), site({ name: 'Api', projectDir: 'C:\\src\\Api', protocol: 'https', port: 44300 })], options);
    assert.ok(!config.includes('WebSite1'));
    assert.equal(
      config.slice(config.indexOf('<sites>'), config.indexOf('<siteDefaults>')),
      [
        '<sites>',
        '            <site name="Web" id="1" serverAutoStart="true">',
        '                <application path="/" applicationPool="Clr4IntegratedAppPool">',
        '                    <virtualDirectory path="/" physicalPath="C:\\src\\Web" />',
        '                </application>',
        '                <bindings>',
        '                    <binding protocol="http" bindingInformation="*:5000:" />',
        '                </bindings>',
        '            </site>',
        '            <site name="Api" id="2" serverAutoStart="true">',
        '                <application path="/" applicationPool="Clr4IntegratedAppPool">',
        '                    <virtualDirectory path="/" physicalPath="C:\\src\\Api" />',
        '                </application>',
        '                <bindings>',
        '                    <binding protocol="https" bindingInformation="*:44300:" />',
        '                </bindings>',
        '            </site>',
        '            ',
      ].join('\n'),
    );
    assert.ok(config.includes('            </site>\n            <siteDefaults>\n                <logFile logFormat="W3C" />'));
  });

  test('localhost-only binding, a virtual path with an empty root app, and XML escaping', () => {
    const config = renderApplicationHostConfig(
      TEMPLATE,
      [site({ name: 'R&D "Web"', appPath: '/app', projectDir: 'C:\\src\\R&D' })],
      { ...options, bindAllHostnames: false, applicationPool: 'Clr4ClassicAppPool' },
    );
    assert.ok(config.includes('<site name="R&amp;D &quot;Web&quot;" id="1"'));
    assert.ok(config.includes('bindingInformation="*:5000:localhost"'));
    assert.ok(config.includes('<application path="/" applicationPool="Clr4ClassicAppPool">\n                    <virtualDirectory path="/" physicalPath="C:\\storage\\empty-root" />'));
    assert.ok(config.includes('<application path="/app" applicationPool="Clr4ClassicAppPool">\n                    <virtualDirectory path="/" physicalPath="C:\\src\\R&amp;D" />'));
  });

  test('a template without <siteDefaults> is rejected', () => {
    assert.throws(() => renderApplicationHostConfig('<configuration />', [site({})], options), /no <siteDefaults>/);
  });

  const realTemplate = templatePathFor(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'IIS Express', 'iisexpress.exe'));
  test('works with the installed IIS Express template', { skip: fs.existsSync(realTemplate) ? false : 'IIS Express is not installed' }, () => {
    const config = renderApplicationHostConfig(fs.readFileSync(realTemplate, 'utf8'), [site({})], options);
    assert.ok(!/<site\s+name="WebSite1"/.test(config));
    assert.equal(config.match(/<site\s/g)?.length, 1);
    assert.ok(config.indexOf('<site name="Web"') < config.indexOf('<siteDefaults'));
  });
});

describe('IIS Express location', () => {
  test('a configured path is used when it exists, and reported when it does not', () => {
    assert.equal(findIisExpress(process.execPath), process.execPath);
    assert.throws(() => findIisExpress('C:\\nowhere\\iisexpress.exe'), /IIS Express not found \(C:\\nowhere\\iisexpress\.exe\)/);
  });

  test('the config template sits next to iisexpress.exe', () => {
    assert.equal(
      templatePathFor(path.join('C:', 'IIS Express', 'iisexpress.exe')),
      path.join('C:', 'IIS Express', 'config', 'templates', 'PersonalWebServer', 'applicationhost.config'),
    );
  });
});
