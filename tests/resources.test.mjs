import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createEmptyData } from '../web/shared/model.mjs';
import * as resources from '../server/latex/resources.mjs';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fonts = ['Lato/Lato-Regular.ttf', 'Lato/Lato-Bold.ttf', 'Lato/Lato-Italic.ttf', 'Lato/Lato-BoldItalic.ttf', 'Simsun/SourceHanSerifCN-Regular.ttf', 'Simsun/SourceHanSerifCN-Bold.ttf'];
async function filesBelow(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? filesBelow(join(dir, entry.name)) : [join(dir, entry.name)]));
  return nested.flat();
}
async function protectedHashes() {
  const files = (await Promise.all(['resume', 'resume_zh', 'font'].map(dir => filesBelow(join(projectRoot, dir))))).flat();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(file))])));
}
async function withBuild(callback) {
  const root = await mkdtemp(join(tmpdir(), 'PureCV 资源 中文 '));
  const dataDir = join(root, '个人 数据');
  const buildDir = join(dataDir, 'builds', 'build-example');
  try {
    await callback({ dataDir, buildDir, projectRoot });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const snapshot = data => ({ resumeId: 'resume-example', revision: 3, data, logoImage: null });

test('preparation uses actual templates, fixed relative names, and only required fonts without altering originals', async () => {
  await withBuild(async options => {
    const before = await protectedHashes();
    const result = await resources.prepareBuild({ ...options, snapshot: snapshot(createEmptyData('en')) });
    assert.deepEqual(result, { cwd: resolve(options.buildDir), entryFile: 'resume.tex' });
    assert.deepEqual((await readdir(options.buildDir)).sort(), ['macros.tex', 'resources', 'resume.tex']);
    const tex = await readFile(join(options.buildDir, 'resume.tex'), 'utf8');
    assert.ok(tex.includes('letterpaper'));
    assert.ok(tex.includes('../../resources/font/Lato/'));
    assert.ok(tex.includes('resources/logo.png'));
    assert.ok(!tex.includes(options.dataDir));
    assert.ok(!tex.includes(options.projectRoot));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(tex + await readFile(join(options.buildDir, 'macros.tex'), 'utf8')));
    assert.equal(hash(await readFile(join(options.buildDir, 'resources/logo.png'))), hash(await readFile(join(projectRoot, 'resume/uestc.png'))));
    for (const font of fonts) {
      const source = hash(await readFile(join(projectRoot, 'font', font)));
      assert.equal(hash(await readFile(join(options.dataDir, 'resources/font', font))), source);
    }
    const cache = await filesBelow(join(options.dataDir, 'resources/font'));
    assert.equal(cache.length, fonts.length);
    assert.deepEqual(await readdir(join(options.buildDir, 'resources')), ['logo.png']);
    assert.deepEqual(await protectedHashes(), before);
  });
});

test('custom snapshot bytes use fixed png or jpg file names independent of asset ID', async () => {
  await withBuild(async options => {
    for (const [mime, extension] of [['image/png', 'png'], ['image/jpeg', 'jpg']]) {
      const data = createEmptyData('zh-CN');
      data.logo = { mode: 'custom', assetId: 'asset-controlled', widthCm: 2.4 };
      const bytes = await readFile(new URL(`./fixtures/logo.${extension}`, import.meta.url));
      const buildDir = join(options.dataDir, 'builds', extension);
      await resources.prepareBuild({ ...options, buildDir, snapshot: { ...snapshot(data), logoImage: { mime, bytes } } });
      assert.deepEqual(await readFile(join(buildDir, `resources/logo.${extension}`)), bytes);
      const tex = await readFile(join(buildDir, 'resume.tex'), 'utf8');
      assert.ok(tex.includes(`resources/logo.${extension}`));
      assert.ok(!tex.includes('asset-controlled'));
    }
  });
});

test('hidden retained custom image bytes are not written or referenced', async () => {
  await withBuild(async options => {
    const data = createEmptyData('zh-CN');
    data.logo = { mode: 'hidden', assetId: 'retained', widthCm: 2.4 };
    const bytes = await readFile(new URL('./fixtures/logo.png', import.meta.url));
    await resources.prepareBuild({ ...options, snapshot: { ...snapshot(data), logoImage: { mime: 'image/png', bytes } } });
    assert.deepEqual(await readdir(join(options.buildDir, 'resources')), []);
    const tex = await readFile(join(options.buildDir, 'resume.tex'), 'utf8');
    assert.ok(!tex.includes('\\includegraphics'));
    assert.ok(!tex.includes('logo.png'));
  });
});

test('font cache digest repairs corruption and follows a changed source font', async () => {
  await withBuild(async options => {
    await resources.prepareBuild({ ...options, snapshot: snapshot(createEmptyData('en')) });
    const cachedFont = join(options.dataDir, 'resources/font/Lato/Lato-Regular.ttf');
    await writeFile(cachedFont, 'corrupted cache');
    const localProject = join(options.dataDir, 'source copy');
    for (const file of [...fonts.map(font => `font/${font}`), 'templates/purecv-en/main.tex', 'templates/shared/macros.tex', 'resume/uestc.png']) {
      const destination = join(localProject, file);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, await readFile(join(projectRoot, file)));
    }
    const data = createEmptyData('en');
    await resources.prepareBuild({ ...options, projectRoot: localProject, buildDir: join(options.dataDir, 'builds', 'repair'), snapshot: snapshot(data) });
    assert.equal(hash(await readFile(cachedFont)), hash(await readFile(join(projectRoot, 'font/Lato/Lato-Regular.ttf'))));
    const updated = Buffer.concat([await readFile(join(localProject, 'font/Lato/Lato-Regular.ttf')), Buffer.from('changed-source')]);
    await writeFile(join(localProject, 'font/Lato/Lato-Regular.ttf'), updated);
    const buildDir = join(options.dataDir, 'builds', 'updated');
    await resources.prepareBuild({ ...options, projectRoot: localProject, buildDir, snapshot: snapshot(data) });
    assert.equal(hash(await readFile(cachedFont)), hash(updated));
    const tex = await readFile(join(buildDir, 'resume.tex'), 'utf8');
    assert.ok(tex.includes('../../resources/font/Lato/'));
  });
});

test('missing custom image and unsupported image MIME fail with controlled errors', async () => {
  await withBuild(async options => {
    const data = createEmptyData('en');
    data.logo = { mode: 'custom', assetId: 'asset-controlled', widthCm: 2.4 };
    await assert.rejects(resources.prepareBuild({ ...options, snapshot: snapshot(data) }), error => error.code === 'INVALID_IMAGE' && !error.message.includes(options.dataDir));
    await assert.rejects(resources.prepareBuild({ ...options, snapshot: { ...snapshot(data), logoImage: { mime: 'image/svg+xml', bytes: Buffer.from('<svg/>') } } }), error => error.code === 'INVALID_IMAGE');
  });
});
test('already cancelled preparation creates no cache or build files', async () => withBuild(async options => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resources.prepareBuild({ ...options, signal: controller.signal, snapshot: snapshot(createEmptyData('en')) }), e => e.name === 'AbortError');
  await assert.rejects(readdir(options.dataDir), e => e.code === 'ENOENT');
}));
test('cancellation during real resource reads settles before any later build writes', async () => withBuild(async options => {
  const controller = new AbortController();
  const preparing = resources.prepareBuild({ ...options, signal: controller.signal, snapshot: snapshot(createEmptyData('en')) });
  controller.abort();
  await assert.rejects(preparing, e => e.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(readFile(join(options.buildDir, 'resume.tex')), e => e.code === 'ENOENT');
}));
