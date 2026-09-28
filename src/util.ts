import { execFile } from 'child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(file: string, args: string[]): Promise<RunResult> {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// -EncodedCommand sidesteps Windows command-line re-parsing of quotes in -Command strings.
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function powerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)];
}

export function powershell(script: string): Promise<RunResult> {
  return run('powershell.exe', powerShellArgs(script));
}

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function xmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
