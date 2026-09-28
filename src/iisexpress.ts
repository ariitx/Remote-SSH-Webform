import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { Settings } from './settings';
import { SiteSpec, findIisExpress, renderApplicationHostConfig, templatePathFor } from './sites';
import { errorMessage, powershell, psQuote, run } from './util';

export interface RunningSite {
  spec: SiteSpec;
  pid: number;
  alive: boolean;
}

interface ManagedSite extends RunningSite {
  child: ChildProcess;
  terminal: vscode.Terminal;
}

/**
 * Runs one iisexpress.exe per site: IIS Express hosts a single site per process, so /config
 * without /site would silently serve only the first site in the file.
 */
export class IisExpressManager implements vscode.Disposable {
  private sites: ManagedSite[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly storageDir: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  get configPath(): string {
    return path.join(this.storageDir, 'applicationhost.config');
  }

  get running(): RunningSite[] {
    return this.sites.filter(s => s.alive);
  }

  async start(specs: SiteSpec[], settings: Settings): Promise<{ started: RunningSite[]; failures: string[] }> {
    await this.stop();
    for (const site of this.sites) site.terminal.dispose();
    this.sites = [];

    const exe = findIisExpress(settings.iisExpressPath);
    await this.writeConfig(exe, specs, settings);
    if (settings.bindAllHostnames) await this.ensureUrlReservations(specs);

    const results = await Promise.allSettled(specs.map(spec => this.startSite(exe, spec, settings)));
    const failures = results.flatMap(r => (r.status === 'rejected' ? [errorMessage(r.reason)] : []));
    this.running.map(s => (s as ManagedSite).terminal)[0]?.show(true);
    this.changed.fire();
    return { started: this.running, failures };
  }

  async stop(): Promise<void> {
    for (const site of this.sites) if (site.alive) site.child.kill();
    await killProcessesUsingConfig(this.configPath);
    this.changed.fire();
  }

  dispose(): void {
    for (const site of this.sites) {
      if (site.alive) site.child.kill();
      site.terminal.dispose();
    }
    this.changed.dispose();
  }

  private async writeConfig(exe: string, specs: SiteSpec[], settings: Settings): Promise<void> {
    const template = templatePathFor(exe);
    if (!fs.existsSync(template)) throw new Error(`IIS Express config template not found: ${template}`);
    const emptyRootDir = path.join(this.storageDir, 'empty-root');
    await fs.promises.mkdir(emptyRootDir, { recursive: true });
    const config = renderApplicationHostConfig(await fs.promises.readFile(template, 'utf8'), specs, {
      bindAllHostnames: settings.bindAllHostnames,
      applicationPool: settings.applicationPool,
      emptyRootDir,
    });
    await fs.promises.writeFile(this.configPath, config, 'utf8');
  }

  /** Binding "*:<port>:" needs an http.sys URL reservation unless IIS Express runs elevated. */
  private async ensureUrlReservations(specs: SiteSpec[]): Promise<void> {
    const elevated = (await run('net', ['session'])).code === 0;
    for (const spec of specs) {
      const url = `${spec.protocol}://*:${spec.port}/`;
      // http.sys refuses to register a URL on a port reserved for the other scheme ("Cannot create a
      // file when that file already exists"), e.g. an http reservation left behind for an https site.
      const otherScheme = spec.protocol === 'https' ? 'http' : 'https';
      const conflicting = `${otherScheme}://*:${spec.port}/`;
      if ((await run('netsh', ['http', 'show', 'urlacl', `url=${conflicting}`])).stdout.includes(`://*:${spec.port}/`)) {
        this.log.appendLine(
          `[warn] ${spec.name}: port ${spec.port} is reserved for ${otherScheme.toUpperCase()} (${conflicting}), which blocks ${spec.protocol.toUpperCase()} on it. ` +
            `Remove it from an elevated prompt: netsh http delete urlacl url=${conflicting}`,
        );
      }
      if (elevated) continue;
      const shown = await run('netsh', ['http', 'show', 'urlacl', `url=${url}`]);
      if (shown.stdout.includes(`://*:${spec.port}/`)) continue;
      const added = await run('netsh', ['http', 'add', 'urlacl', `url=${url}`, 'sddl=D:(A;;GX;;;WD)']);
      if (added.code === 0) {
        this.log.appendLine(`Added URL reservation ${url}.`);
      } else {
        this.log.appendLine(
          `[warn] ${spec.name}: no URL reservation for ${url} and this session isn't elevated, so IIS Express may fail to bind it. ` +
            `Run once from an elevated prompt: netsh http add urlacl url=${url} sddl=D:(A;;GX;;;WD) - or set remoteSshWebForm.bindAllHostnames to false (localhost only).`,
        );
      }
    }
  }

  private startSite(exe: string, spec: SiteSpec, settings: Settings): Promise<RunningSite> {
    return new Promise((resolve, reject) => {
      const write = new vscode.EventEmitter<string>();
      const pending: string[] = [];
      let opened = false;
      const print = (text: string) => {
        const normalized = text.replace(/\r?\n/g, '\r\n');
        if (opened) write.fire(normalized);
        else pending.push(normalized);
      };

      const child = spawn(exe, [`/site:${spec.name}`, `/config:${this.configPath}`, '/systray:false'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const terminal = vscode.window.createTerminal({
        name: `IIS Express: ${spec.name} :${spec.port}`,
        iconPath: new vscode.ThemeIcon('server-process'),
        pty: {
          onDidWrite: write.event,
          open: () => {
            opened = true;
            for (const text of pending.splice(0)) write.fire(text);
          },
          close: () => {
            if (site.alive) child.kill();
          },
          handleInput: (data: string) => {
            if (data === '\x03' || data.toLowerCase() === 'q') {
              print('\nStopping...\n');
              child.kill();
            }
          },
        },
      });
      const site: ManagedSite = { spec, pid: child.pid ?? 0, alive: true, child, terminal };
      this.sites.push(site);

      let output = '';
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!error) {
          resolve(site);
          return;
        }
        if (site.alive) child.kill();
        reject(error);
      };
      const timer = setTimeout(
        () => settle(new Error(`${spec.name}: IIS Express didn't report it was running within ${settings.startupTimeoutSeconds}s.`)),
        settings.startupTimeoutSeconds * 1000,
      );

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        print(text);
        output = (output + text).slice(-8000);
        if (!/IIS Express is running/i.test(output)) return;
        // Registration errors arrive on stderr and can trail the "running" line on stdout.
        setTimeout(() => {
          settle(
            /Failed to register URL/i.test(output)
              ? new Error(
                  `${spec.name}: IIS Express couldn't register ${spec.protocol}://*:${spec.port}/ - the port may be in use by another ` +
                    `IIS Express / Visual Studio instance, or lack a URL reservation.\n${output.trim()}`,
                )
              : undefined,
          );
        }, 500);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', error => {
        site.alive = false;
        print(`\n${error.message}\n`);
        settle(new Error(`${spec.name}: failed to start IIS Express: ${error.message}`));
        this.changed.fire();
      });
      child.on('exit', code => {
        site.alive = false;
        print(`\n[IIS Express exited${code === null ? '' : ` with code ${code}`}]\n`);
        settle(new Error(`${spec.name}: IIS Express exited (code ${code}) before it was ready.\n${output.trim()}`));
        this.changed.fire();
      });
    });
  }
}

/** Also catches instances orphaned by a previous extension host (e.g. after a window reload). */
async function killProcessesUsingConfig(configPath: string): Promise<void> {
  await powershell(
    `$cfg = ${psQuote(configPath.toLowerCase())}\n` +
      `Get-CimInstance Win32_Process -Filter "Name='iisexpress.exe'" | ` +
      'Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($cfg) } | ' +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  );
}
