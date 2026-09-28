import * as fs from 'fs';
import * as path from 'path';

const WEB_APPLICATION_TYPE_GUID = '349c5851-65df-11da-9384-00065b846f21';

export interface ProjectInfo {
  csprojPath: string;
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

export function inspectProject(csprojPath: string): ProjectInfo {
  const text = readText(csprojPath) ?? '';
  const isWeb = /<UseIISExpress>\s*true\s*<\/UseIISExpress>/i.test(text) || text.toLowerCase().includes(WEB_APPLICATION_TYPE_GUID);

  // Visual Studio writes <IISUrl> to .csproj.user when set per-developer, so it wins over the .csproj.
  let iisUrl: URL | undefined;
  for (const candidate of [readText(`${csprojPath}.user`), text]) {
    const match = candidate && /<IISUrl>\s*([^<\s]+)\s*<\/IISUrl>/i.exec(candidate);
    if (!match) continue;
    try {
      iisUrl = new URL(match[1]);
      break;
    } catch {
      // malformed URL: fall through to the next candidate
    }
  }

  return { csprojPath, name: path.basename(csprojPath, '.csproj'), dir: path.dirname(csprojPath), isWeb, iisUrl };
}
