import * as assert from 'assert/strict';
import { describe, test } from 'node:test';
import { EXPRESSIONS, Evaluator, HELPER, InspectOptions, VisualizerError, debuggerFailure, inspect } from '../visualizer/inspect';
import { EvaluateResponse } from '../visualizer/payload';
import { ListSerializer, csString } from '../visualizer/serializers';

/** A C# literal as vsdbg displays a string result. */
const literal = (text: string): EvaluateResponse => ({ result: csString(text), type: 'string' });

/**
 * An evaluator answering by the kind of expression asked: the helper call, the type probe, a list serializer, a
 * DataTable, or a count. Records what was asked.
 */
function fakeEvaluator(answers: Partial<Record<'helper' | 'typeInfo' | 'stj' | 'newtonsoft' | 'builtin' | 'dataTable' | 'count', EvaluateResponse | Error>>) {
  const asked: string[] = [];
  const evaluator: Evaluator = {
    async evaluate(expression) {
      const kind = expression.includes('Assembly.LoadFrom')
        ? 'helper'
        : expression.includes('BaseType?.FullName')
          ? 'typeInfo'
          : expression.includes('System.Text.Json')
            ? 'stj'
            : expression.includes('Newtonsoft')
              ? 'newtonsoft'
              : expression.includes('Enumerable.Count(')
                ? 'count'
                : expression.includes('System.Data.DataTable')
                  ? 'dataTable'
                  : 'builtin';
      asked.push(kind);
      const answer = answers[kind];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error(`unexpected ${kind} evaluation`);
      return answer;
    },
    async exceptionMessage() {
      return 'Could not load file or assembly.';
    },
  };
  return { evaluator, asked };
}

function options(overrides: Partial<InspectOptions> = {}): InspectOptions {
  return { maxRows: 3, serializers: ['System.Text.Json', 'Newtonsoft.Json', 'built-in'] as ListSerializer[], unavailable: new Set(), ...overrides };
}

const helperTable = JSON.stringify({
  kind: 'datatable',
  type: 'System.Data.DataTable',
  tables: [{ name: 'Orders', total: 1, columns: [{ name: 'Id', type: 'System.Int32' }], rows: [['1']] }],
});

async function rejects(promise: Promise<unknown>, message: RegExp, severity: 'info' | 'error'): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof VisualizerError, String(error));
    assert.match(error.message, message);
    assert.equal(error.severity, severity);
    return true;
  });
}

describe('inspect with the helper assembly', () => {
  test('reads the value in one evaluation', async () => {
    const { evaluator, asked } = fakeEvaluator({ helper: literal(helperTable) });
    const view = await inspect(evaluator, 'orders', options({ helperPath: 'C:\\h.dll' }));
    assert.deepEqual(asked, ['helper']);
    assert.equal(view.serializer, HELPER);
    assert.equal(view.kind, 'datatable');
    assert.equal(view.typeName, 'DataTable');
    assert.deepEqual(view.tables[0].rows, [['1']]);
  });

  test('null, unsupported values and helper errors become messages', async () => {
    await rejects(inspect(fakeEvaluator({ helper: literal('{"kind":"null"}') }).evaluator, 'x', options({ helperPath: 'h' })), /x is null/, 'info');
    await rejects(
      inspect(fakeEvaluator({ helper: literal('{"kind":"unsupported","type":"System.String"}') }).evaluator, 'x', options({ helperPath: 'h' })),
      /x \(string\) can't be shown/,
      'info',
    );
    await rejects(inspect(fakeEvaluator({ helper: literal('{"error":"System.Exception: boom"}') }).evaluator, 'x', options({ helperPath: 'h' })), /Reading x failed/, 'error');
  });

  test('a name that is not in scope is reported without falling back', async () => {
    const { evaluator, asked } = fakeEvaluator({ helper: { result: "error CS0103: The name 'x' does not exist in the current context" } });
    await rejects(inspect(evaluator, 'x', options({ helperPath: 'h' })), /x isn't available in the current stack frame/, 'error');
    assert.deepEqual(asked, ['helper']);
  });

  test('when the helper cannot be loaded, the expressions are used, and the helper is not tried again', async () => {
    const unavailable = new Set<ListSerializer | 'helper'>();
    const { evaluator, asked } = fakeEvaluator({
      helper: { result: "'(string)...' threw an exception of type 'System.IO.FileNotFoundException'", type: 'string {System.IO.FileNotFoundException}', variablesReference: 7 },
      typeInfo: literal('System.Data.DataTable|System.ComponentModel.MarshalByValueComponent|System.Object||E|-1'),
      dataTable: literal('{"name":"Orders","total":1,"columns":[{"name":"Id","type":"System.Int32"}],"rows":[["1"]]}'),
    });
    const view = await inspect(evaluator, 'orders', options({ helperPath: 'h', unavailable }));
    assert.equal(view.serializer, EXPRESSIONS);
    assert.deepEqual(asked, ['helper', 'typeInfo', 'dataTable']);
    assert.ok(unavailable.has('helper'));

    asked.length = 0;
    await inspect(evaluator, 'orders', options({ helperPath: 'h', unavailable }));
    assert.deepEqual(asked, ['typeInfo', 'dataTable']);
  });
});

describe('inspect with debugger expressions', () => {
  const listInfo = (count: number) => literal(`System.Collections.Generic.List\`1[[System.Int32, mscorlib]]|System.Object|||E|${count}`);

  test('skips libraries that are not loaded, and remembers that', async () => {
    const unavailable = new Set<ListSerializer | 'helper'>();
    const { evaluator, asked } = fakeEvaluator({
      typeInfo: listInfo(2),
      stj: { result: "error CS0234: The type or namespace name 'Json' does not exist in the namespace 'System.Text'" },
      newtonsoft: literal('[1,2]'),
    });
    const view = await inspect(evaluator, 'numbers', options({ unavailable }));
    assert.equal(view.serializer, 'Newtonsoft.Json');
    assert.deepEqual(view.tables[0].rows, [[1], [2]]);
    assert.deepEqual([...unavailable], ['System.Text.Json']);
    assert.deepEqual(asked, ['typeInfo', 'stj', 'newtonsoft']);
  });

  test('falls back to built-in when a library throws', async () => {
    const { evaluator } = fakeEvaluator({
      typeInfo: listInfo(1),
      stj: { result: "'...' threw an exception of type 'System.NotSupportedException'", type: 'string {System.NotSupportedException}' },
      newtonsoft: { result: "error CS0400: The type or namespace name 'Newtonsoft' could not be found in the global namespace" },
      builtin: literal('{"element":"System.Int32","members":{},"rows":["7"]}'),
    });
    const view = await inspect(evaluator, 'numbers', options());
    assert.equal(view.serializer, EXPRESSIONS);
    assert.deepEqual(view.tables[0].columns, [{ name: 'Value', type: 'System.Int32' }]);
  });

  test('a sequence without Count is counted only when it fills maxRows', async () => {
    const rows = (n: number) => literal(`{"element":"System.Int32","members":{},"rows":[${Array.from({ length: n }, (_, i) => i).join(',')}]}`);
    const short = fakeEvaluator({ typeInfo: listInfo(-1), builtin: rows(2) });
    const view = await inspect(short.evaluator, 'q', options({ serializers: ['built-in'] }));
    assert.equal(view.tables[0].total, 2);
    assert.ok(!short.asked.includes('count'));

    const exact = fakeEvaluator({ typeInfo: listInfo(-1), builtin: rows(3), count: literal('3') });
    assert.equal((await inspect(exact.evaluator, 'q', options({ serializers: ['built-in'] }))).tables[0].total, 3);

    const more = fakeEvaluator({ typeInfo: listInfo(-1), builtin: rows(3), count: literal('4') });
    assert.equal((await inspect(more.evaluator, 'q', options({ serializers: ['built-in'] }))).tables[0].total, undefined);
  });

  test('null, out-of-scope and unsupported values', async () => {
    await rejects(inspect(fakeEvaluator({ typeInfo: { result: 'null', type: 'string' } }).evaluator, 'nobody', options()), /nobody is null/, 'info');
    await rejects(
      inspect(fakeEvaluator({ typeInfo: { result: "error CS0103: The name 'gone' does not exist in the current context" } }).evaluator, 'gone', options()),
      /gone isn't available/,
      'error',
    );
    await rejects(inspect(fakeEvaluator({ typeInfo: literal('Sample.Person|System.Object||||-1') }).evaluator, 'p', options()), /p \(Person\) can't be shown/, 'info');
  });

  test('an exception names its type and message', async () => {
    const { evaluator } = fakeEvaluator({
      typeInfo: { result: "'...' threw an exception of type 'System.NullReferenceException'", type: 'string {System.NullReferenceException}', variablesReference: 3 },
    });
    await rejects(inspect(evaluator, 'a.b', options()), /Evaluating a\.b threw System\.NullReferenceException: Could not load file or assembly\./, 'error');
  });

  test('a failed request and an unreadable answer', async () => {
    await rejects(inspect(fakeEvaluator({ typeInfo: new Error('Evaluation timed out') }).evaluator, 'x', options()), /timed out reading x/, 'error');
    await rejects(
      inspect(fakeEvaluator({ typeInfo: { result: 'The debugger is unable to evaluate this expression', type: 'string' } }).evaluator, 'x', options()),
      /couldn't evaluate x/,
      'error',
    );
    await rejects(inspect(fakeEvaluator({ typeInfo: { result: '"cut off', type: 'string' } }).evaluator, 'x', options()), /incomplete value/, 'error');
  });
});

describe('debuggerFailure', () => {
  test('explains common debugger errors', () => {
    assert.match(debuggerFailure('Evaluation timed out.', 'x').message, /timed out/);
    assert.match(debuggerFailure('Cannot evaluate expression because the code of the current method is optimized.', 'x').message, /optimized code/);
    assert.match(debuggerFailure('Cannot evaluate expression because a native frame is on top of the call stack.', 'x').message, /can't run code/);
    const notPaused = debuggerFailure('Unable to evaluate: the process is running', 'x');
    assert.equal(notPaused.severity, 'info');
    assert.match(debuggerFailure('something else', 'x').detail ?? '', /something else/);
  });
});
