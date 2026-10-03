import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../server/storage.mjs';

export async function withStore(callback) {
  const dataDir = await mkdtemp(join(tmpdir(), 'PureCV 测试 '));
  try {
    await callback(await createStore({ dataDir }), dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
