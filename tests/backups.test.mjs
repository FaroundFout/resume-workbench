import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportBackup, importBackup } from '../server/backups.mjs';
import { putAsset, readAsset } from '../server/assets.mjs';
import { createEmptyData } from '../web/shared/model.mjs';
import { withStore } from './helpers/store.mjs';
import { padImage } from './helpers/images.mjs';

const encode = value => Buffer.from(JSON.stringify(value));
const code = expected => error => error.code === expected;
const emptyBackup = () => ({ format: 'purecv-backup', version: 1, name: 'Portable', data: createEmptyData('en'), logoImage: null });

test('portable export and import remap hidden logos in a different data directory', async () => {
  await withStore(async source => {
    const doc = await source.create({ name: 'Portable', language: 'zh-CN' });
    const bytes = await readFile(new URL('./fixtures/logo.png', import.meta.url));
    const asset = await putAsset(source, doc.id, bytes);
    doc.data.profile.name = '示例';
    doc.data.logo = { mode: 'hidden', assetId: asset.id, widthCm: 2.4 };
    await source.save(doc.id, { expectedRevision: 0, data: doc.data });
    const exported = await exportBackup(source, doc.id);
    const parsed = JSON.parse(exported);
    assert.equal(parsed.format, 'purecv-backup');
    assert.equal(parsed.version, 1);
    assert.equal(parsed.logoImage.mime, 'image/png');
    assert.deepEqual(Buffer.from(parsed.logoImage.base64, 'base64'), bytes);
    assert.equal(Object.hasOwn(parsed, 'id'), false);
    await withStore(async destination => {
      const imported = await importBackup(destination, exported);
      assert.notEqual(imported.id, doc.id);
      assert.notEqual(imported.data.logo.assetId, asset.id);
      assert.equal(imported.revision, 0);
      assert.equal(imported.data.profile.name, '示例');
      assert.equal(imported.data.logo.mode, 'hidden');
      assert.deepEqual(await readAsset(destination, imported.id, imported.data.logo.assetId), bytes);
    });
  });
});

test('exactly 10MiB backup is accepted and 10MiB plus one is rejected without publishing', async () => {
  await withStore(async store => {
    const json = encode(emptyBackup());
    const exact = Buffer.concat([json, Buffer.alloc(10 * 1024 * 1024 - json.length, 32)]);
    await importBackup(store, exact);
    await assert.rejects(importBackup(store, Buffer.concat([exact, Buffer.from(' ')])), code('BACKUP_TOO_LARGE'));
    assert.equal((await store.list()).length, 1);
  });
});

test('maximum-size owned image can be exported and imported without decoder stack overflow', async () => {
  await withStore(async store => {
    const doc = await store.create({ name: 'Large image', language: 'en' });
    const bytes = padImage(await readFile(new URL('./fixtures/logo.png', import.meta.url)), 5 * 1024 * 1024);
    const asset = await putAsset(store, doc.id, bytes);
    doc.data.logo = { mode: 'custom', assetId: asset.id, widthCm: 2.4 };
    await store.save(doc.id, { expectedRevision: 0, data: doc.data });
    const imported = await importBackup(store, await exportBackup(store, doc.id));
    assert.deepEqual(await readAsset(store, imported.id, imported.data.logo.assetId), bytes);
  });
});

test('invalid structures, noncanonical base64, mismatched MIME and foreign references publish nothing', async () => {
  await withStore(async (store, dataDir) => {
    const bytes = await readFile(new URL('./fixtures/logo.png', import.meta.url));
    const withLogo = emptyBackup();
    withLogo.data.logo = { mode: 'custom', assetId: randomUUID(), widthCm: 2.4 };
    withLogo.logoImage = { mime: 'image/png', base64: bytes.toString('base64') };
    const cases = [Buffer.from('{'), encode({ ...emptyBackup(), version: 2 }), encode({ ...emptyBackup(), extra: true })];
    for (const base64 of ['!', bytes.toString('base64') + '\n', bytes.toString('base64').replace(/=+$/, ''), 'Zh==']) {
      cases.push(encode({ ...withLogo, logoImage: { mime: 'image/png', base64 } }));
    }
    cases.push(encode({ ...withLogo, logoImage: { mime: 'image/jpeg', base64: bytes.toString('base64') } }));
    cases.push(encode({ ...withLogo, logoImage: { mime: 'image/png', base64: padImage(bytes, 5 * 1024 * 1024 + 1).toString('base64') } }));
    cases.push(encode({ ...withLogo, logoImage: null }));
    const hiddenForeign = emptyBackup();
    hiddenForeign.data.logo = { mode: 'hidden', assetId: randomUUID(), widthCm: 2.4 };
    cases.push(encode(hiddenForeign));
    cases.push(encode({ ...emptyBackup(), logoImage: withLogo.logoImage }));
    for (const value of cases) await assert.rejects(importBackup(store, value), code('INVALID_BACKUP'));
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await readdir(join(dataDir, 'resumes')), []);
  });
});
