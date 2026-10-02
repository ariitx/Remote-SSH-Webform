// The table visualizer's link to the debugger: which session and stack frame to evaluate in, and DAP requests.
import * as vscode from 'vscode';
import { EvaluateResponse } from './payload';
import { Evaluator, VisualizerError } from './inspect';
import { unescapeCSharpString } from './payload';

/** .NET Framework (clr) and .NET (coreclr) sessions, both served by vsdbg in the C# extension. */
export const DEBUG_TYPES = ['clr', 'coreclr'];

export function isSupportedSession(session: vscode.DebugSession | undefined): session is vscode.DebugSession {
  return !!session && DEBUG_TYPES.includes(session.type);
}

export interface Target {
  session: vscode.DebugSession;
  frameId: number;
}

/**
 * The stack frame to evaluate in: the one focused in the Call Stack view, provided it belongs to a .NET session
 * (and to `sessionId`, when given). A focused thread means its top frame.
 */
export async function resolveTarget(sessionId?: string): Promise<Target> {
  const item = vscode.debug.activeStackItem;
  if (item && isSupportedSession(item.session) && (!sessionId || item.session.id === sessionId)) {
    if (item instanceof vscode.DebugStackFrame) return { session: item.session, frameId: item.frameId };
    const trace = await item.session.customRequest('stackTrace', { threadId: item.threadId, startFrame: 0, levels: 1 });
    const frame = trace?.stackFrames?.[0];
    if (frame) return { session: item.session, frameId: frame.id };
  }
  if (item && sessionId && item.session.id !== sessionId) {
    throw new VisualizerError('That variable belongs to another debug session.', 'Select a stack frame of its session in the Call Stack view and try again.', 'info');
  }
  if (!isSupportedSession(vscode.debug.activeDebugSession)) {
    throw new VisualizerError('Start debugging a .NET program first.', 'The table visualizer works with the C# extension\'s "clr" and "coreclr" debuggers.', 'info');
  }
  throw new VisualizerError('Pause the program to view the table.', 'The debugger can read values only while the program is stopped, e.g. at a breakpoint.', 'info');
}

export function createEvaluator(target: Target, timeoutMs: number): Evaluator {
  const { session, frameId } = target;
  return {
    evaluate: expression =>
      withTimeout(session.customRequest('evaluate', { expression, frameId, context: 'repl' }) as Thenable<EvaluateResponse>, timeoutMs),
    exceptionMessage: async variablesReference => {
      const message = async (reference: number): Promise<{ text?: string; inner?: number }> => {
        const response = await withTimeout(session.customRequest('variables', { variablesReference: reference }) as Thenable<{ variables: { name: string; value: string; variablesReference: number }[] }>, timeoutMs);
        const variables = response?.variables ?? [];
        const text = variables.find(v => v.name === 'Message')?.value;
        const inner = variables.find(v => v.name === 'InnerException' && v.variablesReference > 0)?.variablesReference;
        return { text: text === undefined ? undefined : (unescapeCSharpString(text) ?? text), inner };
      };
      const outer = await message(variablesReference);
      // Reflection wraps a throwing property getter in TargetInvocationException; the inner exception says what happened.
      if (outer.inner) {
        const inner = await message(outer.inner);
        if (inner.text) return outer.text ? `${outer.text} ${inner.text}` : inner.text;
      }
      return outer.text;
    },
  };
}

function withTimeout<T>(request: Thenable<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer from the debugger after ${Math.round(timeoutMs / 1000)} s (timed out).`)), timeoutMs);
    request.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
