import * as fs from 'fs';
import * as path from 'path';

const WEB_APPLICATION_TYPE_GUID = '349c5851-65df-11da-9384-00065b846f21';

export interface ProjectInfo {
  projectPath: string;
  name: string;
  dir: string;
  isWeb: boolean;
  iisUrl?: URL;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function inspectProject(projectPath: string): ProjectInfo {
  const text = readText(projectPath) ?? '';
  const isWeb = /<UseIISExpress>\s*true\s*<\/UseIISExpress>/i.test(text) || text.toLowerCase().includes(WEB_APPLICATION_TYPE_GUID);

  // Visual Studio writes <IISUrl> to the project's .user file when set per-developer, so it wins.
  let iisUrl: URL | undefined;
  for (const candidate of [readText(`${projectPath}.user`), text]) {
    const match = candidate && /<IISUrl>\s*([^<\s]+)\s*<\/IISUrl>/i.exec(candidate);
    if (!match) continue;
    try {
      iisUrl = new URL(match[1]);
      break;
    } catch {
      // malformed URL: fall through to the next candidate
    }
  }

  return { projectPath, name: path.parse(projectPath).name, dir: path.dirname(projectPath), isWeb, iisUrl };
}

/** A web project with an <IISUrl> to take the port from; libraries sometimes carry a stray <UseIISExpress>. */
export function isLaunchableWebProject(projectPath: string): boolean {
  const info = inspectProject(projectPath);
  return info.isWeb && !!info.iisUrl;
}
