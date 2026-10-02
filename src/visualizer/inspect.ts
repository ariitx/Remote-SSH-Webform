// Reads a debuggee value into table data: probes its type, picks the serialization expression, and turns the
// debugger's answers (or failures) into tables or readable errors. The debugger is behind the Evaluator interface,
// so this is unit-tested without VS Code.
import {
  EvaluateResponse,
  Evaluated,
  TableData,
  ValueKind,
  classifyEvaluateResponse,
  friendlyTypeName,
  isMissingTypeError,
  kindOf,
  parseHelperPayload,
  parseJsonPayload,
  parseTypeInfo,
  tableFromDataTablePayload,
  tableFromListPayload,
  tablesFromDataSetPayload,
  unescapeCSharpString,
} from './payload';
import {
  ListSerializer,
  countExpression,
  dataSetExpression,
  dataTableExpression,
  dataViewExpression,
  helperExpression,
  listExpression,
  typeInfoExpression,
} from './serializers';

export interface Evaluator {
  evaluate(expression: string): Promise<EvaluateResponse>;
  /** The Message of an exception the debugger returned as an expandable value, if it can be read. */
  exceptionMessage(variablesReference: number): Promise<string | undefined>;
}

/** A failure to show to the user. `info` is for expected states, such as a null value. */
export class VisualizerError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly severity: 'info' | 'error' = 'error',
  ) {
    super(message);
  }
}

export interface ViewData {
  expression: string;
  /** Readable type name, e.g. List<Person>. */
  typeName: string;
  fullTypeName: string;
  kind: ValueKind;
  /** What read the value: the helper assembly, debugger expressions, System.Text.Json or Newtonsoft.Json. */
  serializer: string;
  tables: TableData[];
  maxRows: number;
}

export interface InspectOptions {
  maxRows: number;
  /** The helper assembly for this debuggee's runtime, if there is one. */
  helperPath?: string;
  /** Serializers for lists and other sequences when the helper can't be used, in order of preference. */
  serializers: ListSerializer[];
  /**
   * Readers that don't work in this debuggee: 'helper' when it can't be loaded, or a serializer whose library isn't.
   * Updated as they fail; kept per session.
   */
  unavailable: Set<ListSerializer | 'helper'>;
}

export const HELPER = 'helper assembly';
export const EXPRESSIONS = 'debugger expressions';

export const SUPPORTED_TYPES_HINT =
  'Supported: DataTable (including typed tables), DataSet, DataView, arrays, List<T>, Dictionary<TKey, TValue> and other IEnumerable collections.';

export async function inspect(evaluator: Evaluator, expression: string, options: InspectOptions): Promise<ViewData> {
  let helperFailure: string | undefined;
  if (options.helperPath && !options.unavailable.has('helper')) {
    const result = await inspectWithHelper(evaluator, expression, options.helperPath, options);
    if (typeof result !== 'string') return result;
    helperFailure = result;
  }
  try {
    return await inspectWithExpressions(evaluator, expression, options);
  } catch (error) {
    if (helperFailure && error instanceof VisualizerError && error.severity === 'error') {
      throw new VisualizerError(error.message, `${error.detail ? `${error.detail}\n` : ''}The helper assembly wasn't used: ${helperFailure}`);
    }
    throw error;
  }
}

/**
 * Reads the value with the helper assembly. Returns why it failed instead when the debugger expressions may still
 * work, and throws when they wouldn't either.
 */
async function inspectWithHelper(evaluator: Evaluator, expression: string, helperPath: string, options: InspectOptions): Promise<ViewData | string> {
  const evaluated = await evaluateRaw(evaluator, helperExpression(helperPath, expression, options.maxRows), expression);
  if (evaluated.kind === 'compileError') throw compileError(evaluated.message, expression);
  if (evaluated.kind === 'exception') {
    // Either loading the helper failed (e.g. the debuggee runs on another machine, so the path doesn't exist there),
    // or evaluating the expression itself threw; the expression path reports the latter properly.
    if (/FileNotFound|FileLoad|BadImageFormat|Security|NotSupported|TypeLoad|MissingMethod|DirectoryNotFound/.test(evaluated.exceptionType)) {
      options.unavailable.add('helper');
    }
    return (await exceptionError(evaluator, evaluated, 'Loading it')).message;
  }
  const text = decode(evaluated.value, expression);
  if (text === null) return 'it returned nothing.';
  let result;
  try {
    result = parseHelperPayload(parseJsonPayload(text), friendlyTypeName);
  } catch (error) {
    throw new VisualizerError(`The data read from ${expression} isn't valid.`, String(error));
  }
  switch (result.kind) {
    case 'error':
      throw new VisualizerError(`Reading ${expression} failed.`, result.error);
    case 'null':
      throw new VisualizerError(`${expression} is null.`, undefined, 'info');
    case 'unsupported':
      throw new VisualizerError(`${expression} (${friendlyTypeName(result.type)}) can't be shown as a table.`, SUPPORTED_TYPES_HINT, 'info');
    default:
      return {
        expression,
        typeName: friendlyTypeName(result.type),
        fullTypeName: result.type,
        kind: result.kind,
        serializer: HELPER,
        tables: result.tables,
        maxRows: options.maxRows,
      };
  }
}

async function inspectWithExpressions(evaluator: Evaluator, expression: string, options: InspectOptions): Promise<ViewData> {
  const { maxRows } = options;
  const infoText = await evaluateString(evaluator, typeInfoExpression(expression), expression, true);
  if (infoText === null) throw new VisualizerError(`${expression} is null.`, undefined, 'info');
  const info = parseTypeInfo(infoText);
  const typeName = friendlyTypeName(info.fullName);
  const kind = kindOf(info);
  if (!kind) throw new VisualizerError(`${expression} (${typeName}) can't be shown as a table.`, SUPPORTED_TYPES_HINT, 'info');
  const view = { expression, typeName, fullTypeName: info.fullName, kind, maxRows };

  if (kind === 'datatable' || kind === 'dataview') {
    const builder = kind === 'datatable' ? dataTableExpression : dataViewExpression;
    const table = tableFromDataTablePayload(await evaluateJson(evaluator, builder(expression, maxRows), expression));
    return { ...view, serializer: EXPRESSIONS, tables: [table] };
  }
  if (kind === 'dataset') {
    const dataSet = tablesFromDataSetPayload(await evaluateJson(evaluator, dataSetExpression(expression, maxRows), expression));
    return { ...view, serializer: EXPRESSIONS, tables: dataSet.tables };
  }

  const { payload, serializer } = await serializeSequence(evaluator, expression, options);
  let total = info.count;
  const rowCount = Array.isArray((payload as { rows?: unknown[] }).rows) ? (payload as { rows: unknown[] }).rows.length : 0;
  if (total === undefined) {
    // No Count: the items read so far tell, unless there were maxRows of them; then count one more to see if that's all.
    if (rowCount < maxRows) total = rowCount;
    else {
      const counted = Number(await evaluateString(evaluator, countExpression(expression, maxRows + 1), expression));
      total = counted <= maxRows ? counted : undefined;
    }
  }
  return { ...view, serializer: serializer === 'built-in' ? EXPRESSIONS : serializer, tables: [tableFromListPayload(payload, typeName, total)] };
}

async function serializeSequence(evaluator: Evaluator, expression: string, options: InspectOptions): Promise<{ payload: unknown; serializer: ListSerializer }> {
  let failure: VisualizerError | undefined;
  for (const serializer of options.serializers) {
    if (options.unavailable.has(serializer)) continue;
    const evaluated = await evaluateRaw(evaluator, listExpression(expression, options.maxRows, serializer), expression);
    if (evaluated.kind === 'compileError') {
      if (serializer !== 'built-in' && isMissingTypeError(evaluated.message)) {
        options.unavailable.add(serializer);
        continue;
      }
      failure = new VisualizerError(`The debugger couldn't compile the ${serializer} expression for ${expression}.`, evaluated.message);
      continue;
    }
    if (evaluated.kind === 'exception') {
      failure = await exceptionError(evaluator, evaluated, `Reading the items of ${expression}`);
      continue;
    }
    try {
      const json = parseJsonPayload(decode(evaluated.value, expression) ?? 'null');
      // The libraries return just the items; only built-in adds their member types.
      return { payload: serializer === 'built-in' ? json : { element: null, members: {}, rows: json }, serializer };
    } catch (error) {
      failure = error instanceof VisualizerError ? error : new VisualizerError(`The ${serializer} output for ${expression} isn't valid JSON.`, String(error));
    }
  }
  throw failure ?? new VisualizerError(`No serializer could read ${expression}.`);
}

async function evaluateJson(evaluator: Evaluator, csharp: string, expression: string): Promise<unknown> {
  const text = await evaluateString(evaluator, csharp, expression);
  if (text === null) throw new VisualizerError(`${expression} is null.`, undefined, 'info');
  try {
    return parseJsonPayload(text);
  } catch (error) {
    throw new VisualizerError(`The data read from ${expression} isn't valid JSON.`, String(error));
  }
}

/** Evaluates an expression that yields a string. `probe` marks the first evaluation, whose compile errors are about the user's expression. */
async function evaluateString(evaluator: Evaluator, csharp: string, expression: string, probe = false): Promise<string | null> {
  const evaluated = await evaluateRaw(evaluator, csharp, expression);
  if (evaluated.kind === 'compileError') {
    if (probe) throw compileError(evaluated.message, expression);
    throw new VisualizerError(`The debugger couldn't evaluate ${expression}.`, evaluated.message);
  }
  if (evaluated.kind === 'exception') throw await exceptionError(evaluator, evaluated, `Evaluating ${expression}`);
  return decode(evaluated.value, expression);
}

/** A compile error of an expression that wraps the user's: most likely about the user's expression. */
function compileError(message: string, expression: string): VisualizerError {
  if (/error CS(0103|0117|1061|0120|0026):/.test(message)) {
    return new VisualizerError(`${expression} isn't available in the current stack frame.`, message);
  }
  return new VisualizerError(`The debugger couldn't evaluate ${expression}.`, message);
}

function decode(display: string, expression: string): string | null {
  const text = unescapeCSharpString(display);
  if (text === undefined) {
    const shown = display.length > 500 ? `${display.slice(0, 500)}…` : display;
    // Not a string literal at all: vsdbg's way of failing, e.g. "The debugger is unable to evaluate this expression".
    if (!display.trimStart().startsWith('"')) throw new VisualizerError(`The debugger couldn't evaluate ${expression}.`, shown);
    throw new VisualizerError(`The debugger returned an incomplete value for ${expression}; it may have been truncated.`, shown);
  }
  return text;
}

async function evaluateRaw(evaluator: Evaluator, csharp: string, expression: string): Promise<Evaluated & { variablesReference?: number }> {
  let response: EvaluateResponse;
  try {
    response = await evaluator.evaluate(csharp);
  } catch (error) {
    throw debuggerFailure(error instanceof Error ? error.message : String(error), expression);
  }
  return { ...classifyEvaluateResponse(response), variablesReference: response.variablesReference };
}

async function exceptionError(evaluator: Evaluator, evaluated: { exceptionType: string; message: string; variablesReference?: number }, action: string): Promise<VisualizerError> {
  let message: string | undefined;
  if (evaluated.variablesReference) {
    try {
      message = await evaluator.exceptionMessage(evaluated.variablesReference);
    } catch {
      // The type alone still says what went wrong.
    }
  }
  return new VisualizerError(`${action} threw ${evaluated.exceptionType}${message ? `: ${message}` : '.'}`, evaluated.message);
}

/** A readable error for a failed evaluate request. */
export function debuggerFailure(message: string, expression: string): VisualizerError {
  if (/time[ds]? ?out/i.test(message)) {
    return new VisualizerError(
      `The debugger timed out reading ${expression}.`,
      `${message}\nTry a smaller remoteSshWebForm.tableVisualizer.maxRows, or check that the program isn't blocked (e.g. waiting on a lock another thread holds).`,
    );
  }
  if (/optimi[sz]ed/i.test(message)) {
    return new VisualizerError(`The debugger can't evaluate ${expression} in optimized code.`, `${message}\nStep into your own code, or build in Debug.`);
  }
  if (/native frame|managed (code|frame)|func(tion)?[- ]?eval/i.test(message)) {
    return new VisualizerError(`The debugger can't run code to read ${expression} at this point.`, `${message}\nStep to a line of your own code and try again.`);
  }
  if (/not (stopped|paused)|is running|process.*(exited|terminated)/i.test(message)) {
    return new VisualizerError('Pause the program to view the table.', message, 'info');
  }
  return new VisualizerError(`The debugger couldn't evaluate ${expression}.`, message);
}
