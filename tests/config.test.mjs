import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { createStore } from '../server/storage.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'PureCV 配置 '));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('defaults permit saving without a configured compiler', async () => fixture(async root => {
  const config = await loadConfig(root);
  assert.equal(config.port, 3000);
  assert.equal(config.compileTimeoutMs, 90000);
  assert.equal(config.xelatexPath, null);
  assert.equal(config.dataDir, join(root, '.purecv'));
  const store = await createStore(config);
  const doc = await store.create({ name: '可保存', language: 'en' });
  assert.equal((await store.save(doc.id, { expectedRevision: 0, data: doc.data })).revision, 1);
}));
test('relative data and executable paths resolve against project root', async () => fixture(async root => {
  await writeFile(join(root, 'config.local.json'), JSON.stringify({ dataDir: '个人 数据', port: 8123, xelatexPath: 'tools/xelatex.exe', compileTimeoutMs: 2500 }));
  const config = await loadConfig(root);
  assert.equal(config.dataDir, join(root, '个人 数据'));
  assert.equal(config.xelatexPath, join(root, 'tools', 'xelatex.exe'));
  assert.equal(config.compileTimeoutMs, 2500);
}));
test('invalid ports, timeouts and malformed local config have controlled errors', async () => fixture(async root => {
  for (const value of [{ port: 0 }, { port: 65536 }, { port: '3000' }, { compileTimeoutMs: 0 }, { dataDir: '' }, { xelatexPath: [] }, null]) {
    await writeFile(join(root, 'config.local.json'), JSON.stringify(value));
    await assert.rejects(loadConfig(root), e => e.code === 'CONFIG_INVALID');
  }
  await writeFile(join(root, 'config.local.json'), '{bad');
  await assert.rejects(loadConfig(root), e => e.code === 'CONFIG_INVALID');
}));
