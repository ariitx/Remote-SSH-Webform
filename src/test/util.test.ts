import * as assert from 'assert/strict';
import { describe, test } from 'node:test';
import { encodePowerShell, errorMessage, powerShellArgs, powershell, psQuote, run, xmlAttr } from '../util';

const onWindows = process.platform === 'win32' ? false : 'needs Windows PowerShell';

describe('util', () => {
  test('psQuote doubles single quotes', () => {
    assert.equal(psQuote("C:\\it's here"), "'C:\\it''s here'");
    assert.equal(psQuote(''), "''");
  });

  test('xmlAttr escapes the characters that break an attribute', () => {
    assert.equal(xmlAttr('a & b < c > "d"'), 'a &amp; b &lt; c &gt; &quot;d&quot;');
  });

  test('encodePowerShell is base64 of UTF-16LE, as -EncodedCommand expects', () => {
    const script = "Write-Host 'é \"x\"'";
    assert.equal(Buffer.from(encodePowerShell(script), 'base64').toString('utf16le'), script);
    assert.deepEqual(powerShellArgs(script), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)]);
  });

  test('errorMessage handles errors and other values', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom');
    assert.equal(errorMessage('plain'), 'plain');
    assert.equal(errorMessage(42), '42');
  });

  test('run returns the exit code and output instead of throwing', async () => {
    const ok = await run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    assert.deepEqual(ok, { code: 3, stdout: 'out', stderr: 'err' });
    const missing = await run('definitely-not-a-real-command-xyz', []);
    assert.notEqual(missing.code, 0);
  });

  test('a psQuote\'d value survives PowerShell intact', { skip: onWindows }, async () => {
    const value = `it's "quoted" $env:PATH \`n — 100%`;
    const result = await powershell(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\nWrite-Output ${psQuote(value)}`);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), value);
  });
});
