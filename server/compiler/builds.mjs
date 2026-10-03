import { randomUUID } from 'node:crypto';
import { open, readdir, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError } from '../errors.mjs';
import { prepareBuild as defaultPrepareBuild } from '../latex/resources.mjs';
import { detectCompiler } from './environment.mjs';
import { runXeLaTeX } from './process.mjs';

const error = (code, message, status = 500) => new AppError(code, message, status);
async function validatePdf(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 5) throw error('PDF_INVALID', '编译未生成有效 PDF');
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(5);
    await handle.read(bytes, 0, 5, 0);
    if (!bytes.equals(Buffer.from('%PDF-'))) throw error('PDF_INVALID', '编译未生成有效 PDF');
  } finally { await handle.close(); }
}
/** One service owns one manager; detect is an optional internal collaborator. */
export function createBuildManager({ config, store, prepareBuild = defaultPrepareBuild, run = runXeLaTeX, detect = detectCompiler }) {
  let active = null;
  let closed = false;
  let lastCreatedAt = 0;
  const persistenceFailures = new Map();
  const remaining = slot => slot.deadline - performance.now();
  const stopped = slot => slot.stopReason === 'timeout' ? 'timed_out' : 'interrupted';
  const cancellationError = slot => slot.stopReason === 'timeout'
    ? error('COMPILE_TIMEOUT', '编译超过总时间限制', 408)
    : error('BUILDER_SHUTDOWN', '服务正在关闭', 503);
  function checkpoint(slot) {
    if (remaining(slot) <= 0 && !slot.controller.signal.aborted) {
      slot.stopReason = 'timeout';
      slot.controller.abort();
    }
    if (slot.controller.signal.aborted) throw cancellationError(slot);
  }
  // Capture only reads immutable data. Cancellation can discard its late result
  // safely; mutating registration/preparation are always awaited to quiescence.
  function captureUntilStopped(slot, resumeId, expectedRevision) {
    const signal = slot.controller.signal;
    checkpoint(slot);
    return new Promise((resolveCapture, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(cancellationError(slot)); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => store.capture(resumeId, expectedRevision)).then(resolveCapture, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }
  const buildPath = (id, file) => join(store.buildDirectory(id), file);
  async function execute(slot, record, snapshot, executable) {
    let status = 'failed';
    let failure = null;
    let log = '';
    let finalPassLog = '';
    let pages = null;
    try {
      const buildDir = store.buildDirectory(record.id);
      checkpoint(slot);
      const prepared = await prepareBuild({ projectRoot: config.projectRoot, dataDir: config.dataDir, buildDir, snapshot, signal: slot.controller.signal });
      checkpoint(slot);
      if (resolve(prepared.cwd) !== resolve(buildDir) || prepared.entryFile !== 'resume.tex') throw error('BUILD_INPUT_INVALID', '编译输入不在受控构建目录');
      for (let pass = 1; pass <= 2; pass++) {
        if (slot.controller.signal.aborted) { status = stopped(slot); break; }
        if (remaining(slot) <= 0) { status = 'timed_out'; break; }
        const result = await run({ executable, ...prepared, timeoutMs: Math.max(1, Math.floor(remaining(slot))), signal: slot.controller.signal });
        finalPassLog = result.log;
        log += `\n=== 编译 ${pass}/2 ===\n${result.log}`;
        if (result.aborted || slot.controller.signal.aborted) { status = stopped(slot); break; }
        if (result.timedOut || remaining(slot) <= 0) { status = 'timed_out'; break; }
        if (result.exitCode !== 0) { status = 'failed'; break; }
        if (pass === 2) status = 'succeeded';
      }
      if (status === 'succeeded') {
        await validatePdf(buildPath(record.id, 'resume.pdf'));
        const matches = [...log.matchAll(/Output written on[^\n]*\((\d+) pages?\b/gi)];
        if (matches.length) pages = Number(matches.at(-1)[1]) || null;
      }
    } catch (cause) {
      status = slot.controller.signal.aborted ? stopped(slot) : remaining(slot) <= 0 ? 'timed_out' : 'failed';
      failure = status === 'timed_out' || status === 'interrupted' ? null
        : { code: cause instanceof AppError ? cause.code : 'COMPILE_FAILED', message: cause instanceof AppError ? cause.message : '编译失败，请查看任务日志' };
      // Full diagnostics are local build artifacts, never embedded in API errors.
      log += `\n${cause.stack || cause}\n`;
    }
    if (slot.controller.signal.aborted) status = stopped(slot);
    if (status !== 'succeeded' && !failure) failure = { code: status === 'timed_out' ? 'COMPILE_TIMEOUT' : status === 'interrupted' ? 'INTERRUPTED' : 'COMPILE_FAILED',
      message: status === 'timed_out' ? '编译超过总时间限制' : status === 'interrupted' ? '服务中断了编译任务' : '编译失败，请查看任务日志' };
    // A clean final pass resolves first-pass rerun/PageLabels warnings; the
    // complete two-pass history remains in build.log for troubleshooting.
    const warnings = [...new Set((status === 'succeeded' ? finalPassLog : log).split(/\r?\n/).filter(line => /Warning:|Overfull \\hbox|Underfull \\hbox/.test(line)))].slice(0, 100);
    await writeFile(buildPath(record.id, 'build.log'), log || failure?.message || '编译完成', 'utf8');
    await store.publishBuild({ ...record, status, finishedAt: new Date().toISOString(), pages: status === 'succeeded' ? pages : null, warnings, error: failure });
    await store.pruneBuilds(record.resumeId);
  }
  async function submit({ resumeId, expectedRevision }) {
    if (closed) throw error('BUILDER_SHUTDOWN', '服务正在关闭，请重新启动后编译', 503);
    if (active) throw error('BUILDER_BUSY', '已有简历正在编译，请稍后重试', 409);
    let settle;
    const slot = { controller: new AbortController(), deadline: performance.now() + config.compileTimeoutMs,
      completion: new Promise(done => { settle = done; }) };
    slot.timer = setTimeout(() => {
      if (!slot.controller.signal.aborted) {
        slot.stopReason = 'timeout';
        slot.controller.abort();
      }
    }, config.compileTimeoutMs);
    active = slot; // Reserve before any asynchronous detection or snapshot capture.
    const release = () => { clearTimeout(slot.timer); if (active === slot) active = null; settle(); };
    try {
      const compiler = await detect(config, { signal: slot.controller.signal, timeoutMs: remaining(slot) });
      checkpoint(slot);
      if (!compiler.available) throw error('COMPILER_UNAVAILABLE', compiler.message, 503);
      const snapshot = await captureUntilStopped(slot, resumeId, expectedRevision);
      checkpoint(slot);
      lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
      const record = await store.registerBuild({ id: randomUUID(), resumeId: snapshot.resumeId, revision: snapshot.revision,
        status: 'running', createdAt: new Date(lastCreatedAt).toISOString(), finishedAt: null, pages: null, warnings: [], error: null });
      slot.recordId = record.id;
      slot.work = execute(slot, record, snapshot, compiler.executable);
      // Filesystem publication failures stay recoverable as running records.
      slot.work.then(release, cause => {
        slot.persistenceError = cause;
        const diagnostic = error('BUILD_PUBLISH_FAILED', '构建结果未能保存，请检查数据目录和磁盘空间后重启服务');
        Object.defineProperty(diagnostic, 'cause', { value: cause });
        persistenceFailures.set(record.id, diagnostic);
        release();
      });
      return record;
    } catch (cause) { release(); throw cause; }
  }
  async function pdfPath(id) {
    const record = await store.readBuild(id);
    if (record.status !== 'succeeded') throw error('PDF_NOT_AVAILABLE', '该构建尚无可用 PDF', 404);
    const path = buildPath(id, 'resume.pdf');
    try { await validatePdf(path); } catch { throw error('PDF_NOT_AVAILABLE', '该构建 PDF 不可用', 404); }
    return path;
  }
  async function logPath(id) {
    await store.readBuild(id);
    const path = buildPath(id, 'build.log');
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw Error(); }
    catch { throw error('LOG_NOT_AVAILABLE', '该构建日志尚不可用', 404); }
    return path;
  }
  async function recover() {
    if (active) throw error('BUILDER_BUSY', '编译期间不能恢复历史任务', 409);
    await store.recoverBuilds();
    for (const item of await readdir(join(store.dataDir, 'builds'), { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.name)) continue;
      let record;
      try { record = await store.readBuild(item.name); }
      catch (cause) { if (cause.code === 'NOT_FOUND') continue; throw cause; }
      if (record.status === 'interrupted') {
        try { await writeFile(buildPath(record.id, 'build.log'), '服务中断了上次构建，请重新编译。\n', { flag: 'wx' }); }
        catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      }
    }
    for (const resume of await store.list()) await store.pruneBuilds(resume.id);
    persistenceFailures.clear();
  }
  async function shutdown() {
    closed = true;
    const slot = active;
    if (!slot) return;
    if (!slot.controller.signal.aborted) {
      slot.stopReason = 'shutdown';
      slot.controller.abort();
    }
    await slot.completion;
    if (slot.persistenceError) throw slot.persistenceError;
  }
  async function read(id) {
    const record = await store.readBuild(id);
    if (persistenceFailures.has(id)) throw persistenceFailures.get(id);
    // A terminal poll means publication and its retention cleanup both finished.
    if (record.status !== 'running' && active?.recordId === id) await active.completion;
    if (persistenceFailures.has(id)) throw persistenceFailures.get(id);
    return record;
  }
  return { submit, read, latestForResume: id => store.latestSuccessfulBuild(id), pdfPath, logPath, recover, shutdown };
}
