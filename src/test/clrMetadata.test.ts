import * as assert from 'assert/strict';
import * as path from 'path';
import { after, describe, test } from 'node:test';
import { publicTypeNames } from '../clrMetadata';
import { cleanup, frameworkSystemWeb, makeProject, needsFramework } from './helpers';

after(cleanup);

describe('publicTypeNames', () => {
  test('lists the public top-level types of a .NET assembly', { skip: needsFramework }, () => {
    const types = publicTypeNames(frameworkSystemWeb!);
    assert.ok(types.size > 1000);
    assert.ok(types.has('System.Web.UI.WebControls.TextBox'));
    assert.ok(types.has('System.Web.UI.HtmlControls.HtmlIframe'));
    assert.ok(types.has('System.Web.HttpRuntime'));
    // Nested types are reachable only through their parent, so they never name a tag.
    assert.ok(![...types].some(t => t.includes('+') || t.includes('/')));
  });

  test('caches by path and modification time', { skip: needsFramework }, () => {
    assert.equal(publicTypeNames(frameworkSystemWeb!), publicTypeNames(frameworkSystemWeb!));
  });

  test('returns an empty set for a missing file or a file that is not an assembly', () => {
    const root = makeProject({ 'notes.dll': 'MZ but not really a PE file', 'empty.dll': '' });
    assert.equal(publicTypeNames(path.join(root, 'missing.dll')).size, 0);
    assert.equal(publicTypeNames(path.join(root, 'notes.dll')).size, 0);
    assert.equal(publicTypeNames(path.join(root, 'empty.dll')).size, 0);
  });
});
