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

/** A page whose directive inherits Web.<className> with a C# code-behind. */
export function page(className: string, body: string, directive = ''): string {
  return `<%@ Page Language="C#" CodeBehind="${className}.aspx.cs" Inherits="Web.${className}"${directive} %>\n${body}\n`;
}
