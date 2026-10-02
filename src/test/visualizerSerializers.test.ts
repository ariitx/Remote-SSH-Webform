import * as assert from 'assert/strict';
import { describe, test } from 'node:test';
import {
  countExpression,
  csString,
  dataSetExpression,
  dataTableExpression,
  dataViewExpression,
  helperExpression,
  listExpression,
  typeInfoExpression,
} from '../visualizer/serializers';

const USER = 'this.items[i + 1]';

/** Checks that string literals close and brackets balance, as a cheap stand-in for the C# compiler. */
function assertWellFormed(csharp: string): void {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < csharp.length; i++) {
    const ch = csharp[i];
    if (ch === '"') {
      for (i++; i < csharp.length && csharp[i] !== '"'; i++) if (csharp[i] === '\\') i++;
      assert.ok(i < csharp.length, `unterminated string literal in ${csharp}`);
    } else if (ch === "'") {
      for (i++; i < csharp.length && csharp[i] !== "'"; i++) if (csharp[i] === '\\') i++;
    } else if ('([{'.includes(ch)) stack.push(ch);
    else if (pairs[ch]) assert.equal(stack.pop(), pairs[ch], `unbalanced ${ch} at ${i} in ${csharp.slice(Math.max(0, i - 60), i + 1)}`);
  }
  assert.deepEqual(stack, [], 'unclosed brackets');
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

const builders: [string, string][] = [
  ['typeInfo', typeInfoExpression(USER)],
  ['count', countExpression(USER, 1001)],
  ['dataTable', dataTableExpression(USER, 1000)],
  ['dataView', dataViewExpression(USER, 1000)],
  ['dataSet', dataSetExpression(USER, 1000)],
  ['list built-in', listExpression(USER, 1000, 'built-in')],
  ['list System.Text.Json', listExpression(USER, 1000, 'System.Text.Json')],
  ['list Newtonsoft.Json', listExpression(USER, 1000, 'Newtonsoft.Json')],
  ['helper', helperExpression('C:\\Temp\\x\\helper.dll', USER, 1000)],
];

describe('serializer expressions', () => {
  test('csString escapes quotes, backslashes and control characters', () => {
    assert.equal(csString('a"b\\c'), '"a\\"b\\\\c"');
    assert.equal(csString('line\nbreak\u0001'), '"line\\u000abreak\\u0001"');
    assert.equal(csString('ünï'), '"ünï"');
  });

  for (const [name, csharp] of builders) {
    test(`${name}: well-formed, and evaluates the user's expression once`, () => {
      assertWellFormed(csharp);
      assert.equal(occurrences(csharp, USER), 1);
    });

    test(`${name}: lambda parameters can't collide with the frame's locals`, () => {
      for (const match of csharp.matchAll(/\((\w+), (\w+)\) =>|(\w+) =>/g)) {
        for (const parameter of match.slice(1).filter(Boolean)) assert.match(parameter, /^__tv/, `${parameter} in ${name}`);
      }
    });

    test(`${name}: LINQ is called statically, not as extension methods`, () => {
      // Extension-method syntax only compiles when the stopped file imports System.Linq.
      assert.doesNotMatch(csharp, /\)\.(Select|Where|Cast|Take|ToList|Count|FirstOrDefault|Concat)\(/);
      for (const call of csharp.match(/[\w:.]*\.(Select|Where|Take|ToList|FirstOrDefault|Concat)\(/g) ?? []) {
        assert.ok(call.startsWith('global::System.Linq.Enumerable.'), call);
      }
    });
  }

  test('the lambda-free expressions have no lambdas', () => {
    // On .NET Framework, vsdbg garbles larger evaluated lambdas; these must stay usable there.
    for (const csharp of [helperExpression('C:\\h.dll', USER, 5), listExpression(USER, 5, 'System.Text.Json'), listExpression(USER, 5, 'Newtonsoft.Json')]) {
      assert.doesNotMatch(csharp, /=>/);
    }
  });

  test('the row limit is applied', () => {
    assert.match(dataTableExpression(USER, 250), /Take\(.*, 250\)/);
    assert.match(listExpression(USER, 250, 'built-in'), /Take\(.*, 250\)/);
    assert.match(helperExpression('C:\\h.dll', USER, 250), /, 250 \}\)$/);
  });

  test('the helper is loaded from the given path, as a C# literal', () => {
    const csharp = helperExpression('C:\\Users\\a "b"\\helper.dll', 'x', 10);
    assert.ok(csharp.includes('LoadFrom("C:\\\\Users\\\\a \\"b\\"\\\\helper.dll")'));
    assert.ok(csharp.includes('GetType("RemoteSshWebForm.TableVisualizer.Serializer")'));
    assert.ok(csharp.includes('(object)(x)'));
  });
});
