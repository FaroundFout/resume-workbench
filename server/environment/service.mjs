import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectEnvironment } from './check.mjs';
import { verifyPdfEnvironment } from './verify.mjs';
import { acquireEnvironmentLease } from './lease.mjs';
import { applyEnvironmentRecord, saveEnvironmentRecord, clearEnvironmentRecord } from './record.mjs';
import { requiredProjectFiles } from './manifest.mjs';
import { AppError } from '../errors.mjs';

const failureState = code => code === 'TEX_PACKAGE_MISSING' ? 'missing-packages'
  : /^PROJECT_RESOURCE_/u.test(code) ? 'missing-resources'
    : /^COMPILER_/u.test(code) ? 'missing-compiler' : 'verification-failed';
const stampOf = (info, target) => JSON.stringify([target, info.isFile(), info.size, info.mtimeMs, info.ctimeMs, info.ino]);
async function fileStamp(path) {
  try {
    const [info, target] = await Promise.all([stat(path), realpath(path)]);
    return stampOf(info, target);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return error.code;
    throw error;
  }
}

/** Read-only asynchronous checks share the build slot and cross-process lease.
 * Polls compare filesystem metadata, then hash/query again only after change.
 * Metadata is a change detector; bilingual compilation remains the readiness gate.
 */
export function createEnvironmentService({ config, builds, inspect = inspectEnvironment,
  verify = verifyPdfEnvironment, acquireLease = acquireEnvironmentLease } = {}) {
  let report = { editorReady: true, pdfReady: false, state: 'verification-required', checks: [], task: null, toolchain: null };
  let active = null, closed = false, refreshing = null;
  let watched = new Map(), selection = config.xelatexPath;
  let generation = 0;
  const fixedFiles = [...requiredProjectFiles.map(file => join(config.projectRoot, file)),
    join(config.projectRoot, '.runtime', 'tex-selection.json'), join(config.projectRoot, 'server', 'environment', 'manifest.mjs')];
  const checkpoint = task => task.controller.signal.throwIfAborted();
  async function inspection(signal) {
    const observed = new Map(fixedFiles.map(path => [path, null]));
    const value = await inspect(config, { signal, onFile: item => { observed.set(item.path, item.stat); } });
    if (value.toolchain) for (const path of [value.toolchain.executable, value.toolchain.lookup].filter(Boolean)) if (!observed.has(path)) observed.set(path, null);
    const stamps = await Promise.all([...observed].map(async ([path, info]) => [path,
      info ? stampOf(info, await realpath(path).catch(() => path)) : await fileStamp(path)]));
    signal?.throwIfAborted();
    watched = new Map(stamps); selection = config.xelatexPath;
    return value;
  }
  async function initialize() {
    report = await applyEnvironmentRecord(config.projectRoot, await inspection());
    return report;
  }
  async function changed() {
    if (selection !== config.xelatexPath) return true;
    for (const [path, stamp] of watched) if (await fileStamp(path) !== stamp) return true;
    return false;
  }
  async function getReport() {
    if (active) {
      // Like terminal build reads, terminal check polls observe lease release.
      if (active.public.status !== 'running') await active.work;
      return report;
    }
    if (!refreshing) refreshing = (async () => {
      if (await changed()) {
        if (active) return; // A POST now owns discovery and the verification slot.
        // Revoke readiness before the slower hash and dependency query starts.
        const task = report.task;
        const taskChecks = task?.status === 'failed' ? report.checks.filter(item => item.id === 'environment' || /^pdf-/u.test(item.id)) : [];
        await invalidate({ code: 'ENVIRONMENT_CHANGED', message: '环境或项目资源已变化，请重新检测环境。' });
        const value = await inspection();
        // A POST may have reserved its slot while this read-only refresh awaited.
        if (!active) report = { ...value, checks: [...value.checks, ...taskChecks], task };
      }
    })().finally(() => { refreshing = null; });
    await refreshing;
    return report;
  }
  async function invalidate({ code = 'ENVIRONMENT_INVALIDATED', message = 'PDF 环境发生变化，请重新检测环境。' } = {}) {
    generation++;
    report = { ...report, pdfReady: false, verifiedAt: null, state: failureState(code),
      checks: [...report.checks.filter(item => item.code !== 'PDF_VERIFIED' && item.code !== 'PDF_SMOKE_PASSED'),
        { id: 'environment', status: 'failed', code, message }] };
    await clearEnvironmentRecord(config.projectRoot);
  }
  async function execute(task, previous) {
    let startGeneration = generation;
    let lease;
    try {
      // Drain a metadata-triggered refresh before our own discovery to avoid a
      // late quick-check overwriting this verification result.
      await refreshing;
      startGeneration = generation;
      checkpoint(task);
      const initial = await inspection(task.controller.signal);
      checkpoint(task);
      report = { ...initial, pdfReady: false, state: 'checking', task: task.public };
      if (initial.state !== 'verification-required') {
        task.public.status = 'failed'; task.public.phase = 'complete';
        report = { ...initial, task: task.public }; await clearEnvironmentRecord(config.projectRoot); return;
      }
      task.public.phase = 'acquire-lease';
      lease = await acquireLease(initial.toolchain, { mode: 'verify', signal: task.controller.signal });
      checkpoint(task);
      const value = await verify(config, initial.toolchain, { inspection: initial, lease, signal: task.controller.signal,
        onProgress: phase => { if (active === task) task.public.phase = phase; } });
      checkpoint(task);
      if (value.pdfReady && (startGeneration !== generation || await changed())) {
        task.public.status = 'failed';
        report = { ...value, pdfReady: false, state: 'verification-required', verifiedAt: null, task: task.public,
          checks: [...value.checks, { id: 'environment', status: 'failed', code: 'ENVIRONMENT_CHANGED', message: '验收期间环境或资源发生变化，请重新检测。' }] };
      } else {
        task.public.status = value.task?.status === 'cancelled' ? 'cancelled' : value.pdfReady ? 'succeeded' : 'failed';
        report = { ...value, task: task.public };
      }
      task.public.phase = 'complete';
      if (report.pdfReady) await saveEnvironmentRecord(config.projectRoot, report);
      else await clearEnvironmentRecord(config.projectRoot);
    } catch (cause) {
      task.public.phase = 'complete';
      const cancelled = task.controller.signal.aborted || cause.name === 'AbortError';
      task.public.status = cancelled ? 'cancelled' : 'failed';
      if (cancelled) {
        const unchanged = previous.pdfReady && previous.fingerprint === report.fingerprint && startGeneration === generation && !await changed();
        report = unchanged ? { ...previous, task: task.public } : { ...report, state: 'verification-required', pdfReady: false, verifiedAt: null, task: task.public };
      } else {
        const code = cause instanceof AppError ? cause.code : 'ENVIRONMENT_CHECK_FAILED';
        report = { ...report, state: failureState(code), pdfReady: false, verifiedAt: null, task: task.public,
          checks: [...report.checks, { id: 'environment', status: 'failed', code,
            message: cause instanceof AppError ? cause.message : '环境检测失败，请检查文件和发行版权限后重试。' }] };
        await clearEnvironmentRecord(config.projectRoot);
      }
    } finally {
      try { await lease?.release(); }
      finally { await task.reservation?.release(); if (active === task) active = null; }
    }
  }
  function check() {
    if (closed) throw new AppError('ENVIRONMENT_CHECK_CLOSED', '服务正在关闭，请重启后重新检测。', 503);
    if (active) return report;
    const task = { controller: new AbortController(), public: { id: randomUUID(), phase: 'inspect', status: 'running' } };
    task.reservation = builds?.reserveEnvironmentTask({ controller: task.controller });
    const previous = report;
    active = task;
    report = { ...report, state: 'checking', pdfReady: false, task: task.public };
    // The HTTP response receives a stable startup value, not a mutable task.
    const started = { ...report, task: { ...task.public } };
    task.work = execute(task, previous);
    // A failure to write a cache must still terminate the public task safely.
    task.work = task.work.catch(() => {
      task.public.status = 'failed'; task.public.phase = 'complete';
      report = { ...report, state: 'verification-failed', pdfReady: false, verifiedAt: null, task: task.public,
        checks: [...report.checks, { id: 'environment', status: 'failed', code: 'ENVIRONMENT_RECORD_FAILED', message: '环境结果未能保存，请检查项目目录权限后重试。' }] };
    });
    return started;
  }
  async function cancel() { const task = active; if (task) { task.controller.abort(); await task.work; } }
  async function shutdown() { closed = true; await cancel(); await refreshing; }
  return { initialize, getReport, check, cancel, shutdown, invalidate, setBuildManager(value) { builds = value; } };
}
