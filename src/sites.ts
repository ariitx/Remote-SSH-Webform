import * as fs from 'fs';
import * as path from 'path';
import { inspectProject } from './projects';
import { LaunchProfile } from './slnLaunch';
import { run, xmlAttr } from './util';

export interface SiteSpec {
  name: string;
  projectDir: string;
  protocol: 'http' | 'https';
  port: number;
  appPath: string;
  debug: boolean;
  url: string;
}

export interface ConfigOptions {
  bindAllHostnames: boolean;
  applicationPool: string;
  /** Physical path for the root "/" application when a site lives under a virtual path. */
  emptyRootDir: string;
}

export async function resolveSites(profile: LaunchProfile): Promise<{ sites: SiteSpec[]; notes: string[] }> {
  const sites: SiteSpec[] = [];
  const notes: string[] = [];
  const names = new Set<string>();
  const ports = new Map<number, string>();

  for (const project of profile.projects) {
    const rel = path.relative(profile.solutionDir, project.csprojPath);
    if (!fs.existsSync(project.csprojPath)) {
      notes.push(`Skipping ${rel}: project file not found.`);
      continue;
    }
    const info = inspectProject(project.csprojPath);
    if (!info.isWeb) {
      notes.push(`Skipping ${rel}: not an IIS Express web project (built, but not started).`);
      continue;
    }
    if (!info.iisUrl) {
      notes.push(`Skipping ${rel}: no <IISUrl> in its .csproj/.csproj.user to take the port from.`);
      continue;
    }

    const protocol = info.iisUrl.protocol === 'https:' ? 'https' : 'http';
    const port = Number(info.iisUrl.port) || (protocol === 'https' ? 443 : 80);
    if (ports.has(port)) {
      notes.push(`Skipping ${rel}: port ${port} is already used by ${ports.get(port)} in this profile.`);
      continue;
    }
    if (protocol === 'https' && !(await hasSslCertificate(port))) {
      notes.push(
        `Skipping ${rel}: https on port ${port}, but no certificate is bound to 0.0.0.0:${port}. ` +
          'IIS Express pre-binds its development certificate to ports 44300-44399; use one of those, or bind one with "netsh http add sslcert".',
      );
      continue;
    }

    let name = info.name;
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${info.name}_${i}`;
    names.add(name.toLowerCase());
    ports.set(port, name);

    const appPath = info.iisUrl.pathname.replace(/\/+$/, '') || '/';
    sites.push({
      name,
      projectDir: info.dir,
      protocol,
      port,
      appPath,
      debug: project.action === 'Start',
      url: `${protocol}://localhost:${port}${appPath === '/' ? '/' : `${appPath}/`}`,
    });
  }
  return { sites, notes };
}

async function hasSslCertificate(port: number): Promise<boolean> {
  const result = await run('netsh', ['http', 'show', 'sslcert', `ipport=0.0.0.0:${port}`]);
  return result.code === 0 && /\b[0-9a-f]{40}\b/i.test(result.stdout);
}

export function findIisExpress(configuredPath: string): string {
  const candidates = configuredPath
    ? [configuredPath]
    : [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
        .filter((dir): dir is string => !!dir)
        .map(dir => path.join(dir, 'IIS Express', 'iisexpress.exe'));
  const found = candidates.find(c => fs.existsSync(c));
  if (!found) {
    throw new Error(`IIS Express not found (${candidates.join(', ')}). Install IIS Express or set remoteSshWebForm.iisExpressPath.`);
  }
  return found;
}

export function templatePathFor(iisExpressExe: string): string {
  return path.join(path.dirname(iisExpressExe), 'config', 'templates', 'PersonalWebServer', 'applicationhost.config');
}

/**
 * Renders a standalone applicationhost.config from IIS Express's own template, replacing its
 * sample site with one site per SiteSpec. A blank binding hostname ("*:<port>:") answers on any
 * Host header; IIS Express's ad hoc mode and Visual Studio's default pin it to "localhost", which
 * makes requests via the machine's IP/hostname fail with 503.
 */
export function renderApplicationHostConfig(template: string, sites: SiteSpec[], options: ConfigOptions): string {
  const hostname = options.bindAllHostnames ? '' : 'localhost';
  const sitesXml = sites.map((site, i) => siteXml(site, i + 1, hostname, options)).join('');
  const withoutSample = template.replace(/<site\s+name="WebSite1"[\s\S]*?<\/site>\s*/i, '');
  const insertAt = withoutSample.search(/<siteDefaults[\s>]/i);
  if (insertAt < 0) throw new Error('Unexpected IIS Express template: no <siteDefaults> element.');
  return withoutSample.slice(0, insertAt) + sitesXml + withoutSample.slice(insertAt);
}

function siteXml(site: SiteSpec, id: number, hostname: string, options: ConfigOptions): string {
  const application = (appPath: string, physicalPath: string) =>
    `                <application path="${xmlAttr(appPath)}" applicationPool="${xmlAttr(options.applicationPool)}">\n` +
    `                    <virtualDirectory path="/" physicalPath="${xmlAttr(physicalPath)}" />\n` +
    `                </application>\n`;
  const applications =
    site.appPath === '/'
      ? application('/', site.projectDir)
      : application('/', options.emptyRootDir) + application(site.appPath, site.projectDir);
  return (
    `            <site name="${xmlAttr(site.name)}" id="${id}" serverAutoStart="true">\n` +
    applications +
    `                <bindings>\n` +
    `                    <binding protocol="${site.protocol}" bindingInformation="*:${site.port}:${hostname}" />\n` +
    `                </bindings>\n` +
    `            </site>\n`
  );
}
