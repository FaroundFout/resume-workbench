import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createEmptyData, validateResumeData } from '../web/shared/model.mjs';
import { inspectImage } from './assets.mjs';
import { AppError } from './errors.mjs';

// Only server-generated UUIDs become directory or file names.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminalStatuses = ['succeeded', 'failed', 'timed_out', 'interrupted'];
const validation = (message, fields) => new AppError('VALIDATION_ERROR', message, 400, fields);
function assertId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw validation('无效的记录 ID');
  return value;
}
function assertRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw validation('修订号必须为非负整数');
}
function assertName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw validation('简历名称须为 1–2000 字符');
  return value;
}
function validData(input) {
  const result = validateResumeData(input);
  if (!result.ok) throw validation('简历数据不符合格式要求', { issues: result.issues });
  return structuredClone(result.value);
}
function checkRevision(doc, expectedRevision) {
  if (doc.revision !== expectedRevision) {
    throw new AppError('REVISION_CONFLICT', '简历已被其他页面修改，请保留草稿后重新载入', 409, { expectedRevision, actualRevision: doc.revision });
  }
}
// A short Windows share lock can block either file replacement or staged
// directory publication. Retry only rename; never remove a complete destination.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await delay(20 * 2 ** attempt);
    }
  }
}
async function atomicWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temporary, path);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new AppError('NOT_FOUND', '记录不存在', 404);
    if (error instanceof SyntaxError) throw new AppError('CORRUPT_DATA', '本地记录损坏', 500);
    throw error;
  }
}
const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
function validBuild(record) {
  const value = structuredClone(record);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('无效的构建记录');
  assertId(value.id);
  assertId(value.resumeId);
  assertRevision(value.revision);
  const date = input => typeof input === 'string' && Number.isFinite(Date.parse(input));
  if (!['running', ...terminalStatuses].includes(value.status) || !date(value.createdAt) ||
      (value.status === 'running' ? value.finishedAt !== null : !date(value.finishedAt)) ||
      !(value.pages === null || (Number.isSafeInteger(value.pages) && value.pages > 0)) ||
      !Array.isArray(value.warnings) || !value.warnings.every(x => typeof x === 'string') ||
      !(value.error === null || (typeof value.error === 'object' && !Array.isArray(value.error)))) {
    throw validation('无效的构建记录');
  }
  return value;
}

/** A single service owns this store; all operations on a resume share its queue. */
export async function createStore({ dataDir }) {
  if (typeof dataDir !== 'string' || !dataDir) throw validation('需要本地数据目录');
  dataDir = resolve(dataDir);
  const resumesDir = join(dataDir, 'resumes');
  const buildsDir = join(dataDir, 'builds');
  await mkdir(resumesDir, { recursive: true });
  await mkdir(buildsDir, { recursive: true });
  const queues = new Map();
  function serial(id, operation) {
    const previous = queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    queues.set(id, current);
    current.then(cleanup, cleanup);
    function cleanup() { if (queues.get(id) === current) queues.delete(id); }
    return current;
  }
  const resumeDirectory = id => join(resumesDir, assertId(id));
  const assetPath = (resumeId, assetId) => join(resumeDirectory(resumeId), 'assets', assertId(assetId));
  const buildDirectory = id => join(buildsDir, assertId(id));
  async function read(id) {
    const doc = await readJson(join(resumeDirectory(id), 'resume.json'));
    if (doc.schemaVersion !== 1 || doc.id !== id || !Number.isSafeInteger(doc.revision) || doc.revision < 0 ||
        typeof doc.updatedAt !== 'string' || !Number.isFinite(Date.parse(doc.updatedAt)) ||
        typeof doc.name !== 'string' || !doc.name.trim() || !validateResumeData(doc.data).ok) {
      throw new AppError('CORRUPT_DATA', '本地简历记录损坏', 500);
    }
    return doc;
  }
  async function readOwnedAsset(resumeId, assetId) {
    const path = assetPath(resumeId, assetId);
    await read(resumeId);
    try { return await readFile(path); }
    catch (error) {
      if (error.code === 'ENOENT') throw new AppError('NOT_FOUND', '此简历的图片不存在', 404);
      throw error;
    }
  }
  async function ownedLogo(resumeId, data) {
    if (data.logo.assetId === null) return null;
    const bytes = await readOwnedAsset(resumeId, data.logo.assetId);
    return { mime: inspectImage(bytes).mime, bytes };
  }
  async function createWithAsset({ name, data, logoImage = null }) {
    name = assertName(name);
    data = validData(data);
    if ((data.logo.assetId !== null) !== (logoImage !== null)) throw validation('校徽引用与图片不匹配');
    if (logoImage !== null) {
      const bytes = Buffer.from(logoImage.bytes);
      if (inspectImage(bytes).mime !== logoImage.mime) throw validation('校徽图片类型不匹配');
      logoImage = { mime: logoImage.mime, bytes };
      data.logo.assetId = randomUUID();
    }
    const id = randomUUID();
    const staging = join(resumesDir, `.pending-${id}`);
    const doc = { schemaVersion: 1, id, name, revision: 0, updatedAt: new Date().toISOString(), data };
    try {
      await mkdir(join(staging, 'assets'), { recursive: true });
      if (logoImage) await atomicWrite(join(staging, 'assets', data.logo.assetId), logoImage.bytes);
      await atomicWrite(join(staging, 'resume.json'), JSON.stringify(doc));
      await renameWithRetry(staging, resumeDirectory(id));
      return structuredClone(doc);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async function create({ name, language, seed }) {
    if (!['zh-CN', 'en'].includes(language)) throw validation('无效的简历语言');
    const data = seed === undefined ? createEmptyData(language) : validData(seed);
    data.language = language;
    if (data.logo.assetId !== null) throw validation('新简历不能引用其他简历的图片');
    return createWithAsset({ name, data });
  }
  async function save(id, { expectedRevision, name, data }) {
    assertId(id);
    assertRevision(expectedRevision);
    data = validData(data);
    if (name !== undefined) name = assertName(name);
    return serial(id, async () => {
      const previous = await read(id);
      checkRevision(previous, expectedRevision);
      await ownedLogo(id, data);
      if (previous.revision === Number.MAX_SAFE_INTEGER) throw validation('修订号超出允许范围');
      const doc = { ...previous, name: name ?? previous.name, data, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      await atomicWrite(join(resumeDirectory(id), 'resume.json'), JSON.stringify(doc));
      return structuredClone(doc);
    });
  }
  async function capture(id, expectedRevision) {
    assertId(id);
    assertRevision(expectedRevision);
    return serial(id, async () => {
      const doc = await read(id);
      checkRevision(doc, expectedRevision);
      return { resumeId: id, revision: doc.revision, data: doc.data, logoImage: await ownedLogo(id, doc.data) };
    });
  }
  async function copy(id, { name, language, draft }) {
    assertId(id);
    assertName(name);
    if (!['zh-CN', 'en'].includes(language)) throw validation('无效的简历语言');
    if (draft !== undefined) draft = validData(draft);
    return serial(id, async () => {
      const original = await read(id);
      const data = draft ?? original.data;
      const logoImage = await ownedLogo(id, data);
      data.language = language;
      return createWithAsset({ name, data, logoImage });
    });
  }
  async function list() {
    const ids = (await readdir(resumesDir, { withFileTypes: true })).filter(x => x.isDirectory() && ID.test(x.name)).map(x => x.name);
    const docs = await Promise.all(ids.map(read));
    return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  async function writeAsset(resumeId, bytes) {
    assertId(resumeId);
    bytes = Buffer.from(bytes);
    inspectImage(bytes);
    return serial(resumeId, async () => {
      await read(resumeId);
      const id = randomUUID();
      await atomicWrite(assetPath(resumeId, id), bytes);
      return id;
    });
  }
  async function readBuild(id) {
    const record = await readJson(join(buildDirectory(id), 'record.json'));
    if (record.id !== id) throw new AppError('CORRUPT_DATA', '本地构建记录损坏', 500);
    return validBuild(record);
  }
  async function allBuilds() {
    const ids = (await readdir(buildsDir, { withFileTypes: true })).filter(x => x.isDirectory() && ID.test(x.name)).map(x => x.name);
    const records = [];
    for (const id of ids) {
      try { records.push(await readBuild(id)); }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    return records.sort(newestFirst);
  }
  async function registerBuild(input) {
    const record = validBuild(input);
    if (record.status !== 'running') throw validation('新构建必须处于运行中');
    return serial(record.resumeId, async () => {
      const doc = await read(record.resumeId);
      if (record.revision > doc.revision) throw validation('构建不能引用未来修订');
      const directory = buildDirectory(record.id);
      try { await mkdir(directory); }
      catch (error) {
        if (error.code === 'EEXIST') throw new AppError('BUILD_CONFLICT', '构建 ID 已存在', 409);
        throw error;
      }
      try { await atomicWrite(join(directory, 'record.json'), JSON.stringify(record)); }
      catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
      return structuredClone(record);
    });
  }
  async function publishBuild(input) {
    const record = validBuild(input);
    if (!terminalStatuses.includes(record.status)) throw validation('发布的构建必须已结束');
    const previous = await readBuild(record.id);
    return serial(previous.resumeId, async () => {
      const current = await readBuild(record.id);
      if (current.status !== 'running' || current.resumeId !== record.resumeId || current.revision !== record.revision || current.createdAt !== record.createdAt) {
        throw new AppError('BUILD_CONFLICT', '构建身份或状态发生冲突', 409);
      }
      await atomicWrite(join(buildDirectory(record.id), 'record.json'), JSON.stringify(record));
      return structuredClone(record);
    });
  }
  async function latestSuccessfulBuild(resumeId) {
    assertId(resumeId);
    return (await allBuilds()).find(x => x.resumeId === resumeId && x.status === 'succeeded') ?? null;
  }
  async function recoverBuilds() {
    for (const record of await allBuilds()) {
      if (record.status === 'running') await publishBuild({ ...record, status: 'interrupted', finishedAt: new Date().toISOString(), error: { code: 'INTERRUPTED', message: '服务中断了上次构建' } });
    }
  }
  async function pruneBuilds(resumeId) {
    assertId(resumeId);
    return serial(resumeId, async () => {
      const records = (await allBuilds()).filter(x => x.resumeId === resumeId);
      let successes = 0;
      let failures = 0;
      for (const record of records) {
        const keep = record.status === 'running' || (record.status === 'succeeded' ? ++successes <= 5 : ++failures <= 1);
        if (!keep) await rm(buildDirectory(record.id), { recursive: true, force: true });
      }
    });
  }
  return { dataDir, list, create, read, save, copy, capture, registerBuild, readBuild, publishBuild,
    latestSuccessfulBuild, recoverBuilds, pruneBuilds, assetPath, buildDirectory, writeAsset, readOwnedAsset, createWithAsset };
}
