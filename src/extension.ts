import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { applyDesigner, counterpartOf, isDesignerMarkup, planDesigner } from './designer';
import { IisExpressManager, RunningSite } from './iisexpress';
import { buildProjects, buildSolution } from './msbuild';
import { builtAtKey, findChangedReferences } from './references';
import { discoverSlnLaunchProfiles, discoverSolutions, discoverSolutionsWithoutSlnLaunch, discoverWebProjectProfiles } from './profiles';
import { Settings, getSettings } from './settings';
import { resolveSites } from './sites';
import { LaunchProfile, findSolutionFile, generateSlnLaunch, profileLabelFromId, resolveProfileById, slnLaunchPathFor } from './slnLaunch';
import { errorMessage } from './util';
import { registerTableVisualizer } from './visualizer/visualizer';

const PROFILE_KEY = 'remoteSshWebForm.profileId';
const BUILT_AT_KEY = 'remoteSshWebForm.referencesBuiltAt';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('remoteSshWebForm.selectProfile', () => controller.selectProfile()),
    vscode.commands.registerCommand('remoteSshWebForm.build', () => controller.build()),
    vscode.commands.registerCommand('remoteSshWebForm.buildSolution', () => controller.buildSolution()),
    vscode.commands.registerCommand('remoteSshWebForm.run', () => controller.start(false)),
    vscode.commands.registerCommand('remoteSshWebForm.debug', () => controller.start(true)),
    vscode.commands.registerCommand('remoteSshWebForm.stop', () => controller.stop()),
    vscode.commands.registerCommand('remoteSshWebForm.reload', () => controller.reload()),
    vscode.commands.registerCommand('remoteSshWebForm.openBrowser', () => controller.openBrowser()),
    vscode.commands.registerCommand('remoteSshWebForm.generateDesigner', (uri?: vscode.Uri) => controller.generateDesigner(uri)),
    vscode.commands.registerCommand('remoteSshWebForm.toggleCodeBehind', (uri?: vscode.Uri) => toggleCodeBehind(uri)),
  );
  registerTableVisualizer(context);
}

export function deactivate(): void {}

/** Switches between markup and code-behind, like Visual Studio's F7. */
async function toggleCodeBehind(uri?: vscode.Uri): Promise<void> {
  const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.fileName;
  const target = file && counterpartOf(file);
  if (!target) {
    vscode.window.showInformationMessage(
      file ? `Remote SSH WebForm: no markup or code-behind file found for ${path.basename(file)}.` : 'Remote SSH WebForm: open a markup or code-behind file first.',
    );
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(target));
}

class Controller implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Remote SSH WebForm');
  private readonly iis: IisExpressManager;
  private readonly profileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly debugItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly runItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  private readonly stopItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47);
  private readonly reloadItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 46.5);
  private readonly buildSolutionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 46);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ourDebugSessions = new Set<string>();
  private stopWhenDebuggingEnds = false;
  /** Whether the running sites were started by Debug rather than Run, so Reload restarts them the same way. */
  private startedWithDebugging = true;
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
    this.reloadItem.command = 'remoteSshWebForm.reload';
    this.reloadItem.text = '$(debug-restart)';
    this.reloadItem.tooltip = 'Remote SSH WebForm: stop, rebuild and restart the selected profile, reattaching the debugger if it was debugging';
    this.buildSolutionItem.command = 'remoteSshWebForm.buildSolution';
    this.buildSolutionItem.text = '$(tools)';
    this.buildSolutionItem.tooltip = "Remote SSH WebForm: build the selected profile's whole solution";

    this.disposables.push(
      this.iis,
      this.output,
      this.profileItem,
      this.debugItem,
      this.runItem,
      this.stopItem,
      this.reloadItem,
      this.buildSolutionItem,
      this.iis.onDidChange(() => this.refreshStatus()),
      vscode.debug.onDidStartDebugSession(session => this.trackSession(session)),
      vscode.debug.onDidTerminateDebugSession(session => this.onSessionEnded(session)),
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.scheme === 'file' && isDesignerMarkup(doc.fileName) && getSettings().generateDesignerOnSave) this.updateDesigner(doc.fileName, false);
      }),
    );
    this.refreshStatus();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  async selectProfile(): Promise<LaunchProfile | undefined> {
    const [slnProfiles, projectProfiles, solutionsWithoutSlnLaunch] = await Promise.all([
      discoverSlnLaunchProfiles(),
      discoverWebProjectProfiles(),
      discoverSolutionsWithoutSlnLaunch(),
    ]);
    const current = this.context.workspaceState.get<string>(PROFILE_KEY);
    type Item = vscode.QuickPickItem & { profile?: LaunchProfile; createFrom?: string };
    const toItem = (profile: LaunchProfile, description: string): Item => ({
      label: profile.id === current ? `$(check) ${profile.name}` : profile.name,
      description,
      profile,
    });

    const items: Item[] = [];
    if (solutionsWithoutSlnLaunch.length > 0) {
      items.push({ label: 'Create launch profiles', kind: vscode.QuickPickItemKind.Separator });
      for (const solution of solutionsWithoutSlnLaunch) {
        items.push({
          label: `$(new-file) Create ${path.basename(slnLaunchPathFor(solution))}`,
          description: `from ${vscode.workspace.asRelativePath(solution)}`,
          detail: 'One profile per IIS Express web project in the solution; edit the file afterwards to combine projects.',
          createFrom: solution,
        });
      }
    }
    let lastSource: string | undefined;
    for (const profile of slnProfiles) {
      if (profile.source !== lastSource) {
        items.push({ label: vscode.workspace.asRelativePath(profile.source), kind: vscode.QuickPickItemKind.Separator });
        lastSource = profile.source;
      }
      items.push(toItem(profile, profile.projects.map(p => path.parse(p.projectPath).name).join(', ')));
    }
    if (projectProfiles.length > 0) {
      items.push({ label: 'Web projects', kind: vscode.QuickPickItemKind.Separator });
      for (const profile of projectProfiles) items.push(toItem(profile, vscode.workspace.asRelativePath(profile.source)));
    }
    if (!items.some(i => i.profile || i.createFrom)) {
      vscode.window.showWarningMessage('Remote SSH WebForm: no .slnLaunch profiles, solutions or IIS Express web projects found in this workspace.');
      return undefined;
    }

    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the profile to build, run and debug',
      matchOnDescription: true,
    });
    if (choice?.createFrom) {
      return (await this.createSlnLaunch(choice.createFrom)) ? this.selectProfile() : undefined;
    }
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

  buildSolution(): Promise<void> {
    return this.guarded('Build Solution', async () => {
      const solution = await this.resolveSolution();
      if (!solution) return;
      const settings = getSettings();
      if (!(await buildSolution(solution, settings))) {
        vscode.window.showErrorMessage(`Build failed for ${path.basename(solution)}. See the Build Solution terminal and the Problems panel.`);
      }
    });
  }

  start(debug: boolean): Promise<void> {
    return this.guarded(debug ? 'Debug' : 'Run', async () => {
      const profile = await this.ensureProfile();
      if (!profile) return;
      const settings = getSettings();
      this.startedWithDebugging = debug;

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

      await this.forwardPorts(started);
      if (debug) {
        const toAttach = started.filter(s => s.spec.debug);
        this.stopWhenDebuggingEnds = settings.stopSitesWhenDebuggingStops && toAttach.length > 0;
        await this.attach(toAttach, settings);
      }
      this.announce(started);
    });
  }

  /** Stops the sites, rebuilds and starts them again, in the mode (Debug or Run) they were started with. */
  reload(): Promise<void> {
    return this.start(this.startedWithDebugging);
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

  async generateDesigner(uri?: vscode.Uri): Promise<void> {
    const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.fileName;
    if (!file || !isDesignerMarkup(file)) {
      vscode.window.showWarningMessage('Remote SSH WebForm: open or select an .aspx, .ascx or .master file to regenerate its designer file.');
      return;
    }
    const doc = vscode.workspace.textDocuments.find(d => d.fileName === file);
    // Saving regenerates it through the on-save handler when that is enabled.
    const savedNow = !!doc?.isDirty && (await doc.save());
    if (!savedNow || !getSettings().generateDesignerOnSave) this.updateDesigner(file, true);
  }

  /** Brings <markup>.designer.cs/.vb in line with the markup's server controls, as Visual Studio does on save. */
  private updateDesigner(markupPath: string, explicit: boolean): void {
    const name = path.basename(markupPath);
    try {
      const plan = planDesigner(markupPath);
      if ('skipped' in plan) {
        if (explicit) vscode.window.showInformationMessage(`Remote SSH WebForm: no designer file for ${name}: ${plan.skipped}.`);
        return;
      }
      const designerName = path.basename(plan.designerPath);
      for (const warning of plan.warnings) this.output.appendLine(`[designer] ${name}: ${warning}`);
      if (plan.content === undefined) {
        if (explicit) vscode.window.showInformationMessage(`${designerName} is already up to date (${plan.fields.length} field(s)).`);
      } else {
        const notes = applyDesigner(plan);
        this.output.appendLine(`[designer] ${plan.created ? 'Created' : 'Updated'} ${plan.designerPath} (${plan.fields.length} field(s)).`);
        for (const note of notes) this.output.appendLine(`[designer] ${note}`);
        vscode.window.setStatusBarMessage(`$(check) ${plan.created ? 'Created' : 'Updated'} ${designerName}`, 4000);
      }
      if (plan.warnings.length > 0) {
        void vscode.window
          .showWarningMessage(`${designerName}: ${plan.warnings.length} control(s) got no field because their type wasn't found.`, 'Show Output')
          .then(choice => {
            if (choice) this.output.show();
          });
      }
    } catch (error) {
      this.output.appendLine(`[error] Designer for ${name}: ${errorMessage(error)}`);
      if (explicit) vscode.window.showErrorMessage(`Remote SSH WebForm: could not regenerate the designer for ${name}: ${errorMessage(error)}`);
    }
  }

  private async createSlnLaunch(solutionPath: string): Promise<boolean> {
    const { file, entries } = generateSlnLaunch(solutionPath);
    if (entries.length === 0) {
      vscode.window.showWarningMessage(`Remote SSH WebForm: ${path.basename(solutionPath)} has no IIS Express web project, so there is nothing to launch.`);
      return false;
    }
    if (fs.existsSync(file)) {
      vscode.window.showWarningMessage(`Remote SSH WebForm: ${path.basename(file)} already exists; not overwriting it.`);
      return true;
    }
    await fs.promises.writeFile(file, `${JSON.stringify(entries, null, 2)}\n`.replace(/\n/g, '\r\n'), 'utf8');
    this.output.appendLine(`Created ${file} with profiles: ${entries.map(e => e.Name).join(', ')}`);
    void vscode.window
      .showInformationMessage(`Created ${path.basename(file)} with ${entries.length} profile(s). Visual Studio uses the same file.`, 'Open File')
      .then(choice => {
        if (choice) void vscode.window.showTextDocument(vscode.Uri.file(file));
      });
    return true;
  }

  private async resolveSolution(): Promise<string | undefined> {
    const id = this.context.workspaceState.get<string>(PROFILE_KEY);
    const profile = id ? resolveProfileById(id) : undefined;
    const fromProfile = profile && findSolutionFile(profile);
    if (fromProfile) return fromProfile;

    const solutions = await discoverSolutions();
    if (solutions.length <= 1) {
      if (solutions.length === 0) vscode.window.showWarningMessage('Remote SSH WebForm: no .sln or .slnx found in this workspace.');
      return solutions[0];
    }
    const choice = await vscode.window.showQuickPick(
      solutions.map(s => ({ label: path.basename(s), description: vscode.workspace.asRelativePath(s), solution: s })),
      { placeHolder: 'Build which solution?' },
    );
    return choice?.solution;
  }

  private async ensureProfile(): Promise<LaunchProfile | undefined> {
    const id = this.context.workspaceState.get<string>(PROFILE_KEY);
    return (id && resolveProfileById(id)) || this.selectProfile();
  }

  private async buildProfile(profile: LaunchProfile, settings: Settings): Promise<boolean> {
    const projects = profile.projects.map(p => p.projectPath);
    const context = { configuration: settings.configuration, platform: settings.platform, solutionDir: profile.solutionDir };
    let references: string[] = [];
    if (settings.buildChangedReferences && !settings.buildProjectReferences) {
      const builtAt = this.context.workspaceState.get<Record<string, number>>(BUILT_AT_KEY, {});
      const changed = await findChangedReferences(projects, context, builtAt);
      for (const note of changed.notes) this.output.appendLine(`[build] ${note}`);
      this.output.appendLine(
        changed.toBuild.length > 0
          ? `[build] Building ${changed.toBuild.length} of ${changed.checked.length} referenced project(s) first: ${changed.toBuild.map(p => path.parse(p).name).join(', ')}`
          : `[build] All ${changed.checked.length} referenced project(s) are up to date.`,
      );
      references = changed.toBuild;
    }

    const startedAt = Date.now();
    const ok = await buildProjects(projects, profile.solutionDir, settings, references);
    if (ok && references.length > 0) {
      // Remembered so files MSBuild doesn't compile (whose change leaves the assembly untouched) don't trigger the build every time.
      const builtAt = { ...this.context.workspaceState.get<Record<string, number>>(BUILT_AT_KEY, {}) };
      for (const reference of references) builtAt[builtAtKey(reference, context)] = startedAt;
      await this.context.workspaceState.update(BUILT_AT_KEY, builtAt);
    }
    if (!ok) {
      const hint = settings.buildProjectReferences
        ? ''
        : ' If a referenced assembly is missing, build the solution once or enable remoteSshWebForm.buildProjectReferences.';
      vscode.window.showErrorMessage(`Build failed for "${profile.name}". See the Build terminal and the Problems panel.${hint}`);
    }
    return ok;
  }

  /**
   * Forwards every site's port through Remote-SSH, so each one answers on localhost on the client
   * machine, including sites the browser only calls into (e.g. an API used by another site's pages).
   */
  private async forwardPorts(sites: RunningSite[]): Promise<void> {
    if (!vscode.env.remoteName) return;
    await Promise.all(
      sites.map(async site => {
        try {
          const external = await vscode.env.asExternalUri(vscode.Uri.parse(site.spec.url));
          const port = Number(external.authority.split(':').pop()) || site.spec.port;
          if (port !== site.spec.port) {
            this.output.appendLine(
              `[warn] ${site.spec.name}: port ${site.spec.port} is busy on the client, so it is forwarded as ${external.toString(true)}. ` +
                `Pages that call localhost:${site.spec.port} won't reach it; free that port on the client and Reload.`,
            );
          }
        } catch (error) {
          this.output.appendLine(`[warn] ${site.spec.name}: could not forward port ${site.spec.port}: ${errorMessage(error)}`);
        }
      }),
    );
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
    if (this.busy) this.buildSolutionItem.hide();
    else this.buildSolutionItem.show();

    const running = this.iis.running.length;
    if (running > 0) {
      this.stopItem.text = `$(debug-stop) IIS Express (${running})`;
      this.stopItem.show();
      this.reloadItem.show();
      this.debugItem.hide();
      this.runItem.hide();
      return;
    }
    this.stopItem.hide();
    this.reloadItem.hide();
    this.debugItem.text = this.busy ? '$(sync~spin)' : '$(debug-alt)';
    this.debugItem.show();
    if (this.busy) this.runItem.hide();
    else this.runItem.show();
  }
}
