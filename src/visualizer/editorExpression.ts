// Finds the expression under the cursor in C# or VB.NET source, for "Visualize as Table" from the editor's context
// menu and hover. Like VS Code's debug hover, it takes the member chain up to the word under the cursor (on `Tables`
// in `ds.Tables.Count` that's `ds.Tables`), and it also keeps C# indexers (`ds.Tables[0].Rows`). Method calls aren't
// included, since evaluating them would run them. The result is C#, which vsdbg evaluates in VB.NET frames too.

export type SourceLanguage = 'csharp' | 'vb';

export interface FoundExpression {
  expression: string;
  /** Character offsets of the expression in the line. */
  start: number;
  end: number;
}

const IDENTIFIER = /[\p{L}\p{Nd}\p{Mn}\p{Mc}\p{Pc}]/u;

const CSHARP_KEYWORDS = new Set(
  ('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event ' +
    'explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null ' +
    'object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string ' +
    'struct switch throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await nameof ' +
    'get set value when where yield let from select dynamic').split(' '),
);

const VB_KEYWORDS = new Set(
  ('addhandler addressof alias and andalso as boolean byref byte byval call case catch cbool cbyte cchar cdate cdbl cdec char cint class ' +
    'clng cobj const continue csbyte cshort csng cstr ctype cuint culng cushort date decimal declare default delegate dim directcast do ' +
    'double each else elseif end enum erase error event exit false finally for friend function get gettype global gosub goto handles if ' +
    'implements imports in inherits integer interface is isnot let lib like long loop mod module mustinherit mustoverride namespace ' +
    'narrowing new next not nothing notinheritable notoverridable object of on operator option optional or orelse overloads overridable ' +
    'overrides paramarray partial private property protected public raiseevent readonly redim rem removehandler resume return sbyte select ' +
    'set shadows shared short single static step stop string structure sub synclock then throw to true try trycast typeof uinteger ulong ' +
    'ushort using when while widening with withevents writeonly xor await async').split(' '),
);

/** The expression under `character` (0-based) in `line`, or undefined when the cursor isn't on a variable name. */
export function expressionAt(line: string, character: number, language: SourceLanguage): FoundExpression | undefined {
  if (insideStringOrComment(line, character, language)) return undefined;

  // The word under (or just before) the cursor.
  let start = character;
  let end = character;
  if (!isIdentifierChar(line[start]) && start > 0 && isIdentifierChar(line[start - 1])) start = end = start - 1;
  if (!isIdentifierChar(line[start])) return undefined;
  while (start > 0 && isIdentifierChar(line[start - 1])) start--;
  while (end < line.length && isIdentifierChar(line[end])) end++;
  if (line[start - 1] === '@' && language === 'csharp') start--; // verbatim identifier, e.g. @class
  const word = line.slice(start, end);
  if (/^\d/.test(word) || isKeyword(word, language)) return undefined;

  // Walk left over `.name`, `?.name` and, in C#, `[index]`.
  let begin = start;
  for (;;) {
    let p = begin;
    if (language === 'csharp' && line[p - 1] === ']') {
      const open = matchingOpenBracket(line, p - 1);
      if (open < 0) return undefined;
      p = open;
      if (line[p - 1] === '?') p--; // people?[0]
    } else if (line[p - 1] === '.' && line[p - 2] !== '.') {
      p--;
      if (line[p - 1] === '?') p--;
    } else break;
    // What the member access applies to: a name, or (C#) an indexer to keep walking over.
    if (language === 'csharp' && line[p - 1] === ']') {
      begin = p;
      continue;
    }
    if (line[p - 1] === ')') return undefined; // a call's result
    let q = p;
    while (q > 0 && isIdentifierChar(line[q - 1])) q--;
    if (q === p) return undefined; // e.g. a string literal's member
    if (line[q - 1] === '@' && language === 'csharp') q--;
    begin = q;
  }

  // C# indexers right after the word belong to it: on `Tables` in `ds.Tables[0]`, `ds.Tables[0]` is meant.
  let finish = end;
  if (language === 'csharp') {
    while (line[finish] === '[') {
      const close = matchingCloseBracket(line, finish);
      if (close < 0) break;
      finish = close + 1;
    }
  }

  let expression = line.slice(begin, finish);
  if (language === 'vb') expression = expression.replace(/^(Me|MyClass)\./i, 'this.').replace(/^MyBase\./i, 'base.');
  return { expression, start: begin, end: finish };
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENTIFIER.test(ch);
}

function isKeyword(word: string, language: SourceLanguage): boolean {
  if (language === 'csharp') return CSHARP_KEYWORDS.has(word);
  return VB_KEYWORDS.has(word.toLowerCase());
}

function matchingOpenBracket(line: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (line[i] === ']') depth++;
    else if (line[i] === '[' && --depth === 0) return i;
  }
  return -1;
}

function matchingCloseBracket(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '[') depth++;
    else if (line[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

/**
 * A rough check, enough to keep the hover link off words in strings and comments on the same line. The holes of
 * interpolated strings ($"{orders.Rows.Count} rows") are code.
 */
function insideStringOrComment(line: string, character: number, language: SourceLanguage): boolean {
  interface Literal {
    /** VB strings and C# verbatim strings (@"...") escape a quote by doubling it, and have no backslash escapes. */
    doubledQuotes: boolean;
    interpolated: boolean;
    /** Braces open inside the current hole; -1 while in the string's text. */
    holeBraces: number;
  }
  const literals: Literal[] = [];
  const current = () => literals[literals.length - 1];
  const inText = () => literals.length > 0 && current().holeBraces < 0;
  for (let i = 0; i < character && i < line.length; i++) {
    const ch = line[i];
    if (inText()) {
      const literal = current();
      if (ch === '"') {
        if (literal.doubledQuotes && line[i + 1] === '"') i++;
        else literals.pop();
      } else if (ch === '\\' && !literal.doubledQuotes) i++;
      else if (literal.interpolated && ch === '{') {
        if (line[i + 1] === '{') i++;
        else literal.holeBraces = 0;
      }
    } else if (ch === '"') {
      const prefix = line.slice(Math.max(0, i - 2), i);
      literals.push({
        doubledQuotes: language === 'vb' || prefix.endsWith('@') || prefix === '@$',
        interpolated: prefix.endsWith('$') || prefix === '$@',
        holeBraces: -1,
      });
    } else if (language === 'csharp' && ch === '/' && line[i + 1] === '/') return true;
    else if (language === 'vb' && ch === "'") return true;
    else if (literals.length > 0 && ch === '{') current().holeBraces++;
    else if (literals.length > 0 && ch === '}') {
      if (current().holeBraces === 0) current().holeBraces = -1; // back in the string's text
      else current().holeBraces--;
    }
  }
  return inText();
}
