import * as vscode from 'vscode';
import * as path from 'path';
import { IisExpressManager, RunningSite } from './iisexpress';
import { buildProjects } from './msbuild';
import { discoverSlnLaunchProfiles, discoverWebProjectProfiles } from './profiles';
import { Settings, getSettings } from './settings';
import { resolveSites } from './sites';
import { LaunchProfile, profileLabelFromId, resolveProfileById } from './slnLaunch';
import { errorMessage } from './util';

const PROFILE_KEY = 'remoteSshWebForm.profileId';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('remoteSshWebForm.selectProfile', () => controller.selectProfile()),
    vscode.commands.registerCommand('remoteSshWebForm.build', () => controller.build()),
    vscode.commands.registerCommand('remoteSshWebForm.run', () => controller.start(false)),
    vscode.commands.registerCommand('remoteSshWebForm.debug', () => controller.start(true)),
    vscode.commands.registerCommand('remoteSshWebForm.stop', () => controller.stop()),
    vscode.commands.registerCommand('remoteSshWebForm.openBrowser', () => controller.openBrowser()),
  );
}

export function deactivate(): void {}

class Controller implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Remote SSH WebForm');
  private readonly iis: IisExpressManager;
  private readonly profileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly debugItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly runItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  private readonly stopItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ourDebugSessions = new Set<string>();
  private stopWhenDebuggingEnds = false;
  private busy = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.iis = new IisExpressManager((context.storageUri ?? context.globalStorageUri).fsPath, this.output);

    this.profileItem.command = 'remoteSshWebForm.selectProfile';
    this.profileItem.tooltip = 'Remote SSH WebForm: select the launch profile to build, run and debug';
    this.debugItem.command = 'remoteSshWebForm.debug';
    this.debugItem.tooltip = 'Remote SSH WebForm: build, run and debug the selected profile';
    this.runItem.command = 'remoteSshWebForm.run';
    this.runItem.text = '$(play)';
    this.runItem.tooltip = 'Remote SSH WebForm: build and run the selected profile without debugging';
    this.stopItem.command = 'remoteSshWebForm.stop';
    this.stopItem.tooltip = 'Remote SSH WebForm: stop the IIS Express sites it started';

    this.disposables.push(
      this.iis,
      this.output,
      this.profileItem,
      this.debugItem,
      this.runItem,
      this.stopItem,
      this.iis.onDidChange(() => this.refreshStatus()),
      vscode.debug.onDidStartDebugSession(session => this.trackSession(session)),
      vscode.debug.onDidTerminateDebugSession(session => this.onSessionEnded(session)),
    );
    this.refreshStatus();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  async selectProfile(): Promise<LaunchProfile | undefined> {
    const [slnProfiles, projectProfiles] = await Promise.all([discoverSlnLaunchProfiles(), discoverWebProjectProfiles()]);
    const current = this.context.workspaceState.get<string>(PROFILE_KEY);
    type Item = vscode.QuickPickItem & { profile?: LaunchProfile };
    const toItem = (profile: LaunchProfile, description: string): Item => ({
      label: profile.id === current ? `$(check) ${profile.name}` : profile.name,
      description,
      profile,
    });

    const items: Item[] = [];
    let lastSource: string | undefined;
    for (const profile of slnProfiles) {
      if (profile.source !== lastSource) {
        items.push({ label: vscode.workspace.asRelativePath(profile.source), kind: vscode.QuickPickItemKind.Separator });
        lastSource = profile.source;
      }
      items.push(toItem(profile, profile.projects.map(p => path.basename(p.csprojPath, '.csproj')).join(', ')));
    }
    if (projectProfiles.length > 0) {
      items.push({ label: 'Web projects', kind: vscode.QuickPickItemKind.Separator });
      for (const profile of projectProfiles) items.push(toItem(profile, vscode.workspace.asRelativePath(profile.source)));
    }
    if (!items.some(i => i.profile)) {
      vscode.window.showWarningMessage('Remote SSH WebForm: no .slnLaunch profiles or IIS Express web projects found in this workspace.');
      return undefined;
    }

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the profile to build, run and debug',
      matchOnDescription: true,
    });
    if (!choice?.profile) return undefined;
    await this.context.workspaceState.update(PROFILE_KEY, choice.profile.id);
    this.refreshStatus();
    return choice.profile;
  }

  build(): Promise<void> {
    return this.guarded('Build', async () => {
      const profile = await this.ensureProfile();
      if (profile) await this.buildProfile(profile, getSettings());
    });
  }

  start(debug: boolean): Promise<void> {
    return this.guarded(debug ? 'Debug' : 'Run', async () => {
      const profile = await this.ensureProfile();
      if (!profile) return;
      const settings = getSettings();

      // Forget sessions from a previous run first, so their termination can't stop the new sites.
      this.stopWhenDebuggingEnds = false;
      this.ourDebugSessions.clear();
      await this.iis.stop();

      if (settings.buildBeforeRun && !(await this.buildProfile(profile, settings))) return;

      const { sites, notes } = await resolveSites(profile);
      for (const note of notes) this.output.appendLine(`[note] ${note}`);
      if (sites.length === 0) throw new Error(`no IIS Express web project to start in "${profile.name}". See the Remote SSH WebForm output.`);

      const { started, failures } = await this.iis.start(sites, settings);
      for (const failure of failures) this.output.appendLine(`[error] ${failure}`);
      if (started.length === 0) throw new Error(failures.join('\n') || 'no site started.');
      if (notes.length > 0 || failures.length > 0) this.output.show(true);
      if (failures.length > 0) {
        vscode.window.showWarningMessage(`Remote SSH WebForm: ${failures.length} site(s) failed to start. See the output for details.`);
      }

      if (debug) {
        const toAttach = started.filter(s => s.spec.debug);
        this.stopWhenDebuggingEnds = settings.stopSitesWhenDebuggingStops && toAttach.length > 0;
        await this.attach(toAttach, settings);
      }
      this.announce(started);
    });
  }

  async stop(): Promise<void> {
    this.stopWhenDebuggingEnds = false;
    this.ourDebugSessions.clear();
    try {
      await this.iis.stop();
    } catch (error) {
      vscode.window.showErrorMessage(`Remote SSH WebForm: stop failed: ${errorMessage(error)}`);
    }
  }

  async openBrowser(): Promise<void> {
    const sites = this.iis.running;
    if (sites.length === 0) {
      vscode.window.showInformationMessage('Remote SSH WebForm: no IIS Express site is running.');
      return;
    }
    const site =
      sites.length === 1
        ? sites[0]
        : (await vscode.window.showQuickPick(sites.map(s => ({ label: s.spec.name, description: s.spec.url, site: s })), { placeHolder: 'Open which site?' }))
            ?.site;
    if (!site) return;
    // asExternalUri forwards the port through Remote-SSH, so localhost works on the client machine.
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(site.spec.url));
    await vscode.env.openExternal(uri);
  }

  private async ensureProfile(): Promise<LaunchProfile | undefined> {
    const id = this.context.workspaceState.get<string>(PROFILE_KEY);
    return (id && resolveProfileById(id)) || this.selectProfile();
  }

  private async buildProfile(profile: LaunchProfile, settings: Settings): Promise<boolean> {
    const ok = await buildProjects(profile.projects.map(p => p.csprojPath), profile.solutionDir, settings);
    if (!ok) {
      const hint = settings.buildProjectReferences
        ? ''
        : ' If a referenced assembly is missing, build the solution once or enable remoteSshWebForm.buildProjectReferences.';
      vscode.window.showErrorMessage(`Build failed for "${profile.name}". See the Build terminal and the Problems panel.${hint}`);
    }
    return ok;
  }

  private async attach(sites: RunningSite[], settings: Settings): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    for (const site of sites) {
      const ok = await vscode.debug.startDebugging(folder, {
        type: 'clr',
        request: 'attach',
        name: `${site.spec.name} (IIS Express :${site.spec.port})`,
        processId: String(site.pid),
        justMyCode: settings.justMyCode,
        requireExactSource: false,
      });
      if (!ok) this.output.appendLine(`[warn] Could not attach the debugger to ${site.spec.name} (pid ${site.pid}).`);
    }
  }

  private trackSession(session: vscode.DebugSession): void {
    const pid = Number(session.configuration.processId);
    if (session.type === 'clr' && this.iis.running.some(s => s.pid === pid)) this.ourDebugSessions.add(session.id);
  }

  private onSessionEnded(session: vscode.DebugSession): void {
    if (!this.ourDebugSessions.delete(session.id)) return;
    if (this.ourDebugSessions.size > 0 || !this.stopWhenDebuggingEnds) return;
    this.stopWhenDebuggingEnds = false;
    void this.iis.stop();
  }

  private announce(sites: RunningSite[]): void {
    this.output.appendLine(`Running: ${sites.map(s => `${s.spec.name} -> ${s.spec.url} (pid ${s.pid})`).join(', ')}`);
    void vscode.window
      .showInformationMessage(`IIS Express running: ${sites.map(s => `${s.spec.name} :${s.spec.port}`).join(', ')}`, 'Open in Browser')
      .then(choice => {
        if (choice) void this.openBrowser();
      });
  }

  private async guarded(action: string, fn: () => Promise<void>): Promise<void> {
    if (process.platform !== 'win32') {
      vscode.window.showErrorMessage('Remote SSH WebForm runs on the Windows host. Open this folder through Remote-SSH on the Windows machine.');
      return;
    }
    if (this.busy) {
      vscode.window.showInformationMessage('Remote SSH WebForm is busy; wait for the current operation to finish.');
      return;
    }
    this.busy = true;
    this.refreshStatus();
    try {
      await fn();
    } catch (error) {
      const message = errorMessage(error);
      this.output.appendLine(`[error] ${action}: ${message}`);
      void vscode.window.showErrorMessage(`Remote SSH WebForm: ${action} failed: ${message.split('\n')[0]}`, 'Show Output').then(choice => {
        if (choice) this.output.show();
      });
    } finally {
      this.busy = false;
      this.refreshStatus();
    }
  }

  private refreshStatus(): void {
    const id = this.context.workspaceState.get<string>(PROFILE_KEY);
    this.profileItem.text = `$(server-process) ${id ? profileLabelFromId(id) : 'Select WebForm profile'}`;
    this.profileItem.show();

    const running = this.iis.running.length;
    if (running > 0) {
      this.stopItem.text = `$(debug-stop) IIS Express (${running})`;
      this.stopItem.show();
      this.debugItem.hide();
      this.runItem.hide();
      return;
    }
    this.stopItem.hide();
    this.debugItem.text = this.busy ? '$(sync~spin)' : '$(debug-alt)';
    this.debugItem.show();
    if (this.busy) this.runItem.hide();
    else this.runItem.show();
  }
}
