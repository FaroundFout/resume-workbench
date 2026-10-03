import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectImage, putAsset, readAsset } from '../server/assets.mjs';
import { withStore } from './helpers/store.mjs';
import { crc32, padImage } from './helpers/images.mjs';

const fixture = extension => readFile(new URL(`./fixtures/logo.${extension}`, import.meta.url));
const code = expected => error => error.code === expected;

test('PNG and JPEG inspection reports the encoded dimensions and canonical MIME', async () => {
  assert.deepEqual(inspectImage(await fixture('png')), { mime: 'image/png', width: 2, height: 3 });
  assert.deepEqual(inspectImage(await fixture('jpg')), { mime: 'image/jpeg', width: 2, height: 3 });
});

test('valid PNG and JPEG at exactly 5MiB are accepted and one extra byte is rejected', async () => {
  for (const extension of ['png', 'jpg']) {
    const exact = padImage(await fixture(extension), 5 * 1024 * 1024);
    assert.equal(inspectImage(exact).width, 2);
    assert.throws(() => inspectImage(Buffer.concat([exact, Buffer.from([0])])), code('IMAGE_TOO_LARGE'));
  }
});

test('truncated images, missing image bodies, wrong CRCs and zero dimensions fail inspection', async () => {
  const png = await fixture('png');
  const jpg = await fixture('jpg');
  for (const bytes of [Buffer.from('GIF89a'), png.subarray(0, -1), jpg.subarray(0, -1), Buffer.concat([png, Buffer.from([0])])]) {
    assert.throws(() => inspectImage(bytes), code('INVALID_IMAGE'));
  }
  const corrupt = Buffer.from(png);
  corrupt[29] ^= 1;
  assert.throws(() => inspectImage(corrupt), code('INVALID_IMAGE'));
  const zero = Buffer.from(png);
  zero.writeUInt32BE(0, 16);
  zero.writeUInt32BE(crc32(zero.subarray(12, 29)), 29);
  assert.throws(() => inspectImage(zero), code('INVALID_IMAGE'));
  const noBody = Buffer.concat([png.subarray(0, 33), png.subarray(-12)]);
  assert.throws(() => inspectImage(noBody), code('INVALID_IMAGE'));
  const noScan = Buffer.concat([jpg.subarray(0, jpg.indexOf(Buffer.from([0xff, 0xda]))), Buffer.from([0xff, 0xd9])]);
  assert.throws(() => inspectImage(noScan), code('INVALID_IMAGE'));
});

test('PNG chunk types reject high-bit bytes even with a recomputed valid CRC', async () => {
  const png = await fixture('png');
  for (let offset = 8; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
    const end = offset + 12 + png.readUInt32BE(offset);
    for (let index = 0; index < 4; index++) {
      const disguised = Buffer.from(png);
      disguised[offset + 4 + index] |= 0x80;
      disguised.writeUInt32BE(crc32(disguised.subarray(offset + 4, end - 4)), end - 4);
      assert.throws(() => inspectImage(disguised), code('INVALID_IMAGE'), `chunk at ${offset}, type byte ${index}`);
    }
  }
});

test('uploads use fresh owned IDs, preserve bytes, and cannot read traversal or foreign IDs', async () => {
  await withStore(async store => {
    const a = await store.create({ name: 'A', language: 'en' });
    const b = await store.create({ name: 'B', language: 'en' });
    const bytes = await fixture('png');
    const first = await putAsset(store, a.id, bytes);
    const second = await putAsset(store, a.id, bytes);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(await readAsset(store, a.id, first.id), bytes);
    await assert.rejects(readAsset(store, b.id, first.id), code('NOT_FOUND'));
    await assert.rejects(readAsset(store, a.id, '../outside'), code('VALIDATION_ERROR'));
    assert.equal((await store.read(a.id)).revision, 0);
    await assert.rejects(putAsset(store, a.id, null), code('INVALID_IMAGE'));
  });
});
