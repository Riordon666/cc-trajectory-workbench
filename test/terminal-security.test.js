const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { boundedInt, resolveCwd, resolveShell } = require('../workbench/server/terminal');

test('terminal clamps dimensions, restricts cwd and shell selection', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(resolveCwd(path.resolve(root, '..'), root), root);
  assert.equal(resolveCwd(root, root), root);
  assert.equal(boundedInt(9999, 20, 400, 80), 80);
  assert.doesNotMatch(resolveShell('totally-untrusted.exe'), /totally-untrusted/i);
});
