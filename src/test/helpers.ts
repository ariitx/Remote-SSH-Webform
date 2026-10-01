import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const windir = process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows';

/** System.Web.dll from the .NET Framework folder, when this machine has one. */
export const frameworkSystemWeb = ['Framework64', 'Framework', 'FrameworkArm64']
  .map(fx => path.join(windir, 'Microsoft.NET', fx, 'v4.0.30319', 'System.Web.dll'))
  .find(p => fs.existsSync(p));

/** Skip reason for tests that resolve types from the .NET Framework assemblies. */
export const needsFramework = frameworkSystemWeb ? false : '.NET Framework 4.x is not installed';

const roots: string[] = [];

/** Writes the files (relative path -> content) into a fresh temp directory and returns its path. */
export function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsw-test-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return root;
}

export function cleanup(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

export const CSPROJ = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
  '  <PropertyGroup>',
  '    <RootNamespace>Web</RootNamespace>',
  '  </PropertyGroup>',
  '</Project>',
  '',
].join('\r\n');

/** A web application project; `iisUrl` becomes its <IISUrl>. */
export function webProject(iisUrl?: string): string {
  return [
    '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>',
    '    <ProjectTypeGuids>{349c5851-65df-11da-9384-00065b846f21};{fae04ec0-301f-11d3-bf4b-00c04f79efbc}</ProjectTypeGuids>',
    '  </PropertyGroup>',
    '  <ProjectExtensions><VisualStudio><FlavorProperties GUID="{349c5851-65df-11da-9384-00065b846f21}"><WebProjectProperties>',
    '    <UseIIS>True</UseIIS>',
    iisUrl ? `    <IISUrl>${iisUrl}</IISUrl>` : '',
    '  </WebProjectProperties></FlavorProperties></VisualStudio></ProjectExtensions>',
    '</Project>',
    '',
  ].join('\r\n');
}

/** A class library project (not a web project). */
export const LIBRARY_PROJECT = '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\r\n  <PropertyGroup><OutputType>Library</OutputType></PropertyGroup>\r\n</Project>\r\n';

/** A classic .sln listing the given project paths (relative to the solution), plus a solution folder. */
export function solution(projects: string[]): string {
  const lines = ['Microsoft Visual Studio Solution File, Format Version 12.00', '# Visual Studio Version 17'];
  lines.push('Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Solution Items", "Solution Items", "{11111111-1111-1111-1111-111111111111}"', 'EndProject');
  projects.forEach((p, i) => {
    const type = p.endsWith('.vbproj') ? 'F184B08F-C81C-45F6-A57F-5ABD9991F28F' : 'FAE04EC0-301F-11D3-BF4B-00C04F79EFBC';
    lines.push(`Project("{${type}}") = "${p.replace(/^.*[\\/]|\.\w+$/g, '')}", "${p}", "{00000000-0000-0000-0000-00000000000${i}}"`, 'EndProject');
  });
  lines.push('Global', 'EndGlobal', '');
  return lines.join('\r\n');
}

/** A page whose directive inherits Web.<className> with a C# code-behind. */
export function page(className: string, body: string, directive = ''): string {
  return `<%@ Page Language="C#" CodeBehind="${className}.aspx.cs" Inherits="Web.${className}"${directive} %>\n${body}\n`;
}
