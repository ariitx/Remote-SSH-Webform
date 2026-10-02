// "Visualize as Table": shows a DataTable, DataSet, DataView, array, list, dictionary or other sequence from a paused
// .NET debug session in a sortable, filterable webview table. VS Code's debug visualizer API
// (registerDebugVisualizationProvider) is still a proposed API, which a published extension can't use, and the debug
// hover's own menu isn't open to extensions. So the entry points are: the Variables / Watch context menu and inline
// button (which also shows on the rows of the debug hover), the editor's context menu, a link in the editor hover
// (shown in the stopped file while Alt is held), and a command-palette command.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSupportedSession } from './debugBridge';
import { SourceLanguage, expressionAt } from './editorExpression';
import { ListSerializer } from './serializers';
import { PanelHost, TablePanel } from './panel';
import { getSettings } from '../settings';

const HELPER_FILE = 'RemoteSshWebForm.TableVisualizer.dll';

/** The argument VS Code passes to commands in the debug/variables/context and debug/watch/context menus. */
interface VariableMenuArgs {
  sessionId?: string;
  variable?: { name?: string; evaluateName?: string; type?: string };
}

export function registerTableVisualizer(context: vscode.ExtensionContext): void {
  const visualizer = new TableVisualizer(context.extensionUri);
  context.subscriptions.push(
    visualizer,
    vscode.commands.registerCommand('remoteSshWebForm.visualizeVariable', (args?: VariableMenuArgs) => visualizer.showVariable(args)),
    vscode.commands.registerCommand('remoteSshWebForm.visualizeExpression', (expression?: unknown) =>
      typeof expression === 'string' && expression.trim() ? visualizer.showExpression(expression.trim()) : visualizer.promptExpression(),
    ),
    vscode.commands.registerCommand('remoteSshWebForm.visualizeAtCursor', () => visualizer.showAtCursor()),
    vscode.languages.registerHoverProvider(SOURCE_LANGUAGES.map(language => ({ language })), { provideHover: (document, position) => hoverFor(document, position) }),
  );
}

const SOURCE_LANGUAGES: SourceLanguage[] = ['csharp', 'vb'];

/** Whether a .NET debug session is stopped, so values can be read. */
function isPaused(): boolean {
  const item = vscode.debug.activeStackItem;
  return item instanceof vscode.DebugStackFrame && isSupportedSession(item.session);
}

/**
 * A "Visualize as Table" link for the variable under the mouse. In the stopped file VS Code shows the debug hover
 * instead of this one; holding Alt switches to it.
 */
function hoverFor(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
  if (!isPaused() || !SOURCE_LANGUAGES.includes(document.languageId as SourceLanguage)) return undefined;
  const found = expressionAt(document.lineAt(position.line).text, position.character, document.languageId as SourceLanguage);
  if (!found) return undefined;
  const command = `command:remoteSshWebForm.visualizeExpression?${encodeURIComponent(JSON.stringify([found.expression]))}`;
  const markdown = new vscode.MarkdownString(`[$(table) Visualize as Table](${command} "Show this value in a table"): `, true);
  markdown.appendText(found.expression);
  markdown.isTrusted = { enabledCommands: ['remoteSshWebForm.visualizeExpression'] };
  return new vscode.Hover(markdown, new vscode.Range(position.line, found.start, position.line, found.end));
}

class TableVisualizer implements PanelHost, vscode.Disposable {
  /** One panel per expression. */
  private readonly panels = new Map<string, TablePanel>();
  private readonly unavailable = new Map<string, Set<ListSerializer | 'helper'>>();
  private readonly helperCopies = new Map<string, string | undefined>();
  private readonly liveSessions = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly extensionUri: vscode.Uri) {
    if (vscode.debug.activeDebugSession) this.liveSessions.add(vscode.debug.activeDebugSession.id);
    this.disposables.push(
      vscode.debug.onDidStartDebugSession(session => this.liveSessions.add(session.id)),
      vscode.debug.onDidTerminateDebugSession(session => {
        this.liveSessions.delete(session.id);
        this.unavailable.delete(session.id);
        for (const panel of this.panels.values()) panel.onSessionEnded(session.id);
      }),
      vscode.debug.onDidChangeActiveStackItem(item => {
        if (item && !isSupportedSession(item.session)) return;
        for (const panel of this.panels.values()) panel.onStackItemChanged(item);
      }),
    );
  }

  async showVariable(args?: VariableMenuArgs): Promise<void> {
    const expression = args?.variable?.evaluateName;
    if (!expression) {
      // Variables without an evaluateName (e.g. synthetic "Raw View" nodes) can't be re-evaluated.
      void vscode.window.showInformationMessage(
        `"${args?.variable?.name ?? 'This item'}" has no expression the debugger can evaluate. Use "Visualize Expression as Table" with an expression instead.`,
      );
      return;
    }
    await this.show(expression, args?.sessionId);
  }

  async promptExpression(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : '';
    const expression = await vscode.window.showInputBox({
      title: 'Visualize Expression as Table',
      prompt: 'A C# expression to evaluate in the current stack frame, e.g. a DataTable, DataSet, List<T>, array or Dictionary',
      value: selected.includes('\n') ? '' : selected,
      ignoreFocusOut: true,
    });
    if (expression?.trim()) await this.show(expression.trim());
  }

  async showExpression(expression: string): Promise<void> {
    await this.show(expression);
  }

  /** The editor context menu's command: the selection, or the variable under the cursor. */
  async showAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const selection = editor.selection;
    const language = editor.document.languageId as SourceLanguage;
    const selected = selection.isEmpty ? '' : editor.document.getText(selection).trim();
    const expression =
      selected && !selected.includes('\n')
        ? selected
        : SOURCE_LANGUAGES.includes(language)
          ? expressionAt(editor.document.lineAt(selection.active.line).text, selection.active.character, language)?.expression
          : undefined;
    if (!expression) {
      void vscode.window.showInformationMessage('Put the cursor on a variable name, or select an expression, to view it as a table.');
      return;
    }
    await this.show(expression);
  }

  maxRows(): number {
    return getSettings().tableVisualizerMaxRows;
  }

  /**
   * The helper assembly built from debuggee/ for the session's runtime. The debuggee loads a copy in the temp folder,
   * named by content, because it keeps the file locked until it exits: loading it from the extension's folder would
   * block updating or uninstalling the extension while IIS Express runs.
   */
  helperPath(debugType: string): string | undefined {
    const framework = debugType === 'clr' ? 'net40' : 'netstandard2.0';
    if (this.helperCopies.has(framework)) return this.helperCopies.get(framework);
    let copy: string | undefined;
    try {
      const source = path.join(this.extensionUri.fsPath, 'out', 'debuggee', framework, HELPER_FILE);
      const bytes = fs.readFileSync(source);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      copy = path.join(os.tmpdir(), 'remote-ssh-webform', `table-visualizer-${hash}`, framework, HELPER_FILE);
      if (!fs.existsSync(copy)) {
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.writeFileSync(copy, bytes);
      }
    } catch {
      copy = undefined; // Not built, or the temp folder isn't writable: the debugger expressions still work.
    }
    this.helperCopies.set(framework, copy);
    return copy;
  }

  unavailableSerializers(sessionId: string): Set<ListSerializer | 'helper'> {
    let set = this.unavailable.get(sessionId);
    if (!set) this.unavailable.set(sessionId, (set = new Set()));
    return set;
  }

  isSessionAlive(sessionId: string): boolean {
    return this.liveSessions.has(sessionId);
  }

  onPanelDisposed(panel: TablePanel): void {
    if (this.panels.get(panel.expression) === panel) this.panels.delete(panel.expression);
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private async show(expression: string, sessionId?: string): Promise<void> {
    let panel = this.panels.get(expression);
    if (panel) panel.reveal();
    else {
      panel = new TablePanel(this, expression);
      this.panels.set(expression, panel);
    }
    await panel.refresh(sessionId);
  }
}
