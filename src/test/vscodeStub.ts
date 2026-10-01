// A minimal stand-in for the 'vscode' module, covering only what msbuild.ts and profiles.ts use, so they can be
// tested under plain Node. Importing ./vscodeHook routes require('vscode') here.

type Listener<T> = (e: T) => void;

class Emitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter(l => l !== listener)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
}

export class ProcessExecution {
  constructor(
    readonly process: string,
    readonly args: string[],
  ) {}
}

export class Task {
  group: unknown;
  presentationOptions: unknown;
  constructor(
    readonly definition: { type: string; id: string },
    readonly scope: unknown,
    readonly name: string,
    readonly source: string,
    readonly execution: ProcessExecution,
    readonly problemMatchers: string,
  ) {}
}

export const TaskScope = { Workspace: 'workspace' };
export const TaskGroup = { Build: 'build' };
export const TaskRevealKind = { Always: 'always' };
export const TaskPanelKind = { Dedicated: 'dedicated' };

const endTaskProcess = new Emitter<{ execution: { task: Task }; exitCode: number | undefined }>();

/** What tests control: how an executed task "runs", and what findFiles returns per glob. */
export const stub = {
  executed: [] as Task[],
  runTask: async (_task: Task): Promise<number | undefined> => 0,
  files: {} as Record<string, string[]>,
};

export const tasks = {
  onDidEndTaskProcess: endTaskProcess.event,
  executeTask: async (task: Task) => {
    stub.executed.push(task);
    // Like VS Code, report the end asynchronously after executeTask has resolved.
    void stub.runTask(task).then(exitCode => endTaskProcess.fire({ execution: { task }, exitCode }));
    return { task };
  },
};

export const workspace = {
  findFiles: async (include: string) => (stub.files[include] ?? []).map(fsPath => ({ fsPath })),
};
