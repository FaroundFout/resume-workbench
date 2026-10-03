import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEmptyData } from '../web/shared/model.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'PureCV 导入 空格-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, '产品'); await mkdir(root);
  for (const path of ['server', 'web']) await cp(join(project, path), join(root, path), { recursive: true });
  await mkdir(join(root, 'scripts'));
  // Before implementation the real CLI is absent; leave it absent for meaningful RED.
  await cp(join(project, 'scripts/import-personal-data.mjs'), join(root, 'scripts/import-personal-data.mjs')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await writeFile(join(root, 'config.local.json'), JSON.stringify({ dataDir: '私有 数据' }));
  const data = createEmptyData('zh-CN');
  data.profile.name = '虚构测试姓名';
  data.profile.contacts = [{ id: 'email', type: 'email', label: '邮箱', value: 'private-test@example.invalid' }];
  data.sections.skills.items = [{ id: 's', category: '测试', content: [{ text: '加粗链接', bold: true, url: 'https://example.invalid' }] }];
  const input = join(temp, '输入.json');
  await writeFile(input, JSON.stringify({ name: '测试迁入', data }));
  return { temp, root, data, input, dataDir: join(root, '私有 数据'), run: (...args) => exec(process.execPath, [join(root, 'scripts/import-personal-data.mjs'), ...args], { cwd: temp, windowsHide: true }) };
}

test('CLI validates and preserves private data in script-root configured storage without contact output', async t => {
  const f = await fixture(t);
  const result = await f.run(f.input).catch(e => e);
  assert.equal(result.code ?? 0, 0, 'valid import should succeed through the CLI');
  const summary = JSON.parse(result.stdout); assert.deepEqual(Object.keys(summary).sort(), ['id', 'name']);
  assert.match(summary.id, uuid); assert.equal(summary.name, '测试迁入');
  assert.doesNotMatch(result.stdout + result.stderr, /private-test@example.invalid|虚构测试姓名/);
  const stored = JSON.parse(await readFile(join(f.dataDir, 'resumes', summary.id, 'resume.json'), 'utf8'));
  assert.equal(stored.revision, 0); assert.deepEqual(stored.data, f.data);
  assert.equal(stored.name, '测试迁入'); assert.equal(stored.id, summary.id);
  await assert.rejects(readdir(join(f.temp, '.purecv')), { code: 'ENOENT' });
});

test('repeat imports create new UUIDs and retain the first document unchanged', async t => {
  const f = await fixture(t);
  const first = await f.run(f.input).catch(e => e);
  assert.equal(first.code ?? 0, 0, 'first import should succeed');
  const a = JSON.parse(first.stdout); const path = join(f.dataDir, 'resumes', a.id, 'resume.json');
  const before = await readFile(path, 'utf8');
  const second = await f.run(f.input); const b = JSON.parse(second.stdout);
  assert.match(b.id, uuid); assert.notEqual(a.id, b.id);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await readdir(join(f.dataDir, 'resumes'))).length, 2);
});

test('invalid input is rejected before storage creation without exposing contacts', async t => {
  const f = await fixture(t);
  const badData = structuredClone(f.data); badData.layout.paper = 'bad';
  const dangling = structuredClone(f.data); dangling.logo = { mode: 'custom', assetId: 'missing', widthCm: 2.4 };
  const duplicateContact = structuredClone(f.data); duplicateContact.profile.contacts.push(structuredClone(duplicateContact.profile.contacts[0]));
  const duplicateSection = structuredClone(f.data); duplicateSection.sections.skills.items.push(structuredClone(duplicateSection.sections.skills.items[0]));
  for (const input of [
    { name: '测试', data: badData }, { name: '', data: f.data }, { name: 5, data: f.data },
    { name: '测试', data: duplicateContact }, { name: '测试', data: duplicateSection },
    { name: 'x'.repeat(2001), data: f.data }, { name: '测试', data: f.data, id: 'overwrite' },
    { name: '测试', data: dangling }, [], null, 'malformed JSON',
  ]) {
    await writeFile(f.input, typeof input === 'string' ? input : JSON.stringify(input));
    await assert.rejects(f.run(f.input), e => e.code === 1 && /导入失败/.test(e.stderr) && !/private-test@example.invalid/.test(e.stderr + e.stdout));
    await assert.rejects(readdir(f.dataDir), { code: 'ENOENT' });
  }
});

test('CLI requires exactly one explicit file and default personal storage is git ignored', async t => {
  const f = await fixture(t);
  for (const args of [[], [f.input, f.input], [join(f.temp, 'missing.json')]]) {
    await assert.rejects(f.run(...args), e => e.code === 1 && /用法|导入失败/.test(e.stderr));
    await assert.rejects(readdir(f.dataDir), { code: 'ENOENT' });
  }
  const ignored = await exec('git', ['-c', 'core.excludesFile=', 'check-ignore', '.purecv/resumes/private/resume.json'], { cwd: project, windowsHide: true });
  assert.equal(ignored.stdout.trim(), '.purecv/resumes/private/resume.json');
});
