// One webview per visualized expression. It refreshes when the debugger stops again (e.g. after a step), and handles
// the page's copy and CSV export requests.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { createEvaluator, resolveTarget } from './debugBridge';
import { InspectOptions, ViewData, VisualizerError, inspect } from './inspect';
import { ListSerializer } from './serializers';
import { errorMessage } from '../util';

export const VIEW_TYPE = 'remoteSshWebForm.tableVisualizer';
const EVALUATION_TIMEOUT_MS = 30_000;
const REFRESH_DELAY_MS = 150;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** What the panel needs from the code that owns all panels. */
export interface PanelHost {
  readonly extensionUri: vscode.Uri;
  maxRows(): number;
  /** The helper assembly to load into a debuggee of this debug type, if it's available. */
  helperPath(debugType: string): string | undefined;
  /** Readers that failed in a session, so they aren't retried on every refresh. */
  unavailableSerializers(sessionId: string): Set<ListSerializer | 'helper'>;
  isSessionAlive(sessionId: string): boolean;
  onPanelDisposed(panel: TablePanel): void;
}

/** Messages to the page (media/visualizer/table.js). */
type ToPage =
  | { type: 'loading' }
  | { type: 'data'; data: ViewData; time: string }
  | { type: 'error'; message: string; detail?: string; severity: 'info' | 'error' }
  | { type: 'status'; text: string };

type FromPage = { type: 'ready' } | { type: 'refresh' } | { type: 'copy'; text: string } | { type: 'exportCsv'; csv: string; name: string };

export class TablePanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** The session the current values came from. */
  private sessionId: string | undefined;
  /** The last data/error message, replayed when the page (re)loads. */
  private lastState: ToPage | undefined;
  private sequence = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  /** A stop happened while the panel was hidden; refresh when it's shown. */
  private stale = false;

  constructor(
    private readonly host: PanelHost,
    readonly expression: string,
  ) {
    const media = vscode.Uri.joinPath(host.extensionUri, 'media', 'visualizer');
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Table: ${expression}`,
      // Beside the code: when the debugger stops, VS Code shows the source in the active group, which would hide the
      // table there (and a hidden table only refreshes once it's shown again).
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    this.panel.webview.html = this.html(media);
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: FromPage) => this.onMessage(message)),
      this.panel.onDidChangeViewState(() => {
        if (this.panel.visible && this.stale) this.scheduleRefresh();
      }),
    );
  }

  /** The values this panel shows, for tests. */
  get state(): unknown {
    return this.lastState;
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  /** Reads the expression again, in `sessionId`'s focused frame when given. */
  async refresh(sessionId?: string): Promise<void> {
    clearTimeout(this.refreshTimer);
    this.stale = false;
    const sequence = ++this.sequence;
    void this.post({ type: 'loading' });
    let state: ToPage;
    try {
      const target = await resolveTarget(sessionId);
      const options: InspectOptions = {
        maxRows: this.host.maxRows(),
        helperPath: this.host.helperPath(target.session.type),
        serializers: serializerOrder(target.session.type),
        unavailable: this.host.unavailableSerializers(target.session.id),
      };
      const data = await inspect(createEvaluator(target, EVALUATION_TIMEOUT_MS), this.expression, options);
      this.sessionId = target.session.id;
      state = { type: 'data', data, time: new Date().toLocaleTimeString() };
    } catch (error) {
      state =
        error instanceof VisualizerError
          ? { type: 'error', message: error.message, detail: error.detail, severity: error.severity }
          : { type: 'error', message: `Couldn't read ${this.expression}.`, detail: errorMessage(error), severity: 'error' };
    }
    if (sequence !== this.sequence) return; // A newer refresh has started.
    this.lastState = state;
    await this.post(state);
  }

  /** Called when the focused stack item changes: the debugger stopped, stepped, resumed, or another frame was picked. */
  onStackItemChanged(item: vscode.DebugThread | vscode.DebugStackFrame | undefined): void {
    if (!item) {
      if (this.lastState?.type === 'data') void this.post({ type: 'status', text: 'The program is running; these are the values from the last stop.' });
      return;
    }
    // While its own session lives, follow only that session: with several sites attached, a stop in another process
    // isn't about this value.
    if (this.sessionId && item.session.id !== this.sessionId && this.host.isSessionAlive(this.sessionId)) return;
    if (!this.panel.visible) {
      this.stale = true;
      return;
    }
    this.scheduleRefresh(item.session.id);
  }

  onSessionEnded(sessionId: string): void {
    if (sessionId === this.sessionId && this.lastState?.type === 'data') {
      void this.post({ type: 'status', text: 'The debug session ended; these are the values from its last stop.' });
    }
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.sequence++;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.panel.dispose();
    this.host.onPanelDisposed(this);
  }

  private scheduleRefresh(sessionId?: string): void {
    clearTimeout(this.refreshTimer);
    // Stepping fires several changes in a row; read once things settle.
    this.refreshTimer = setTimeout(() => void this.refresh(sessionId), REFRESH_DELAY_MS);
  }

  private async onMessage(message: FromPage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.lastState) await this.post(this.lastState);
        return;
      case 'refresh':
        await this.refresh();
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.setStatusBarMessage('Copied to the clipboard.', 2000);
        return;
      case 'exportCsv':
        await this.exportCsv(message.csv, message.name);
        return;
    }
  }

  private async exportCsv(csv: string, name: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const fileName = `${name.replace(/[\\/:*?"<>|]+/g, '_') || 'table'}.csv`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : undefined,
      filters: { 'CSV files': ['csv'] },
      saveLabel: 'Export',
    });
    if (!target) return;
    try {
      // The byte-order mark makes Excel read the file as UTF-8.
      await vscode.workspace.fs.writeFile(target, Buffer.concat([UTF8_BOM, Buffer.from(csv, 'utf8')]));
      vscode.window.setStatusBarMessage(`Exported ${vscode.workspace.asRelativePath(target)}.`, 3000);
    } catch (error) {
      void vscode.window.showErrorMessage(`Couldn't export the table: ${errorMessage(error)}`);
    }
  }

  private post(message: ToPage): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
    const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`, `font-src ${webview.cspSource}`].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('table.css')}">
<title>Table</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('tableCore.js')}"></script>
<script nonce="${nonce}" src="${uri('table.js')}"></script>
</body>
</html>`;
  }
}

/**
 * Which libraries to try for sequences when the helper assembly can't be used. .NET Framework apps (clr) usually have
 * Newtonsoft.Json and lack System.Text.Json; .NET (coreclr) apps the reverse. built-in works without either, but shows
 * nested objects only by type name.
 */
export function serializerOrder(debugType: string): ListSerializer[] {
  return debugType === 'clr' ? ['Newtonsoft.Json', 'System.Text.Json', 'built-in'] : ['System.Text.Json', 'Newtonsoft.Json', 'built-in'];
}
