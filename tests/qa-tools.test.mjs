import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQaTools } from './helpers/qa-tools.mjs';
test('QA explicit overrides precede bundle candidates, then ordinary Windows Node falls back to PATH', () => {
  const base = { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', env: {}, exists: () => false };
  assert.deepEqual(resolveQaTools(base), { python: 'python', pdftoppm: 'pdftoppm' });
  assert.deepEqual(resolveQaTools({ ...base, env: { PURECV_PYTHON: 'D:\\qa\\python.exe', PURECV_PDFTOPPM: 'D:\\qa\\pdftoppm.exe' }, exists: () => { throw Error('Override should be first'); } }),
    { python: 'D:\\qa\\python.exe', pdftoppm: 'D:\\qa\\pdftoppm.exe' });
  const bundled = resolveQaTools({ ...base, execPath: 'C:\\bundle\\dependencies\\node\\bin\\node.exe', exists: path => path.endsWith('python.exe') });
  assert.equal(bundled.python, 'C:\\bundle\\dependencies\\python\\python.exe');
  assert.equal(bundled.pdftoppm, 'pdftoppm');
  assert.deepEqual(resolveQaTools({ platform: 'linux', env: {}, exists: () => false }), { python: 'python3', pdftoppm: 'pdftoppm' });
});
