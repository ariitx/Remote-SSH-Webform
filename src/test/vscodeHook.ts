// Import this before any module that imports 'vscode': it resolves 'vscode' to the stub in this folder.
import Module = require('module');

const resolver = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const original = resolver._resolveFilename;
resolver._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? require.resolve('./vscodeStub') : original.call(this, request, ...rest);
};
