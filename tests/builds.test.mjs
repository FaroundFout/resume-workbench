import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createBuildFixture, finish } from './helpers/builds.mjs';
import { createBuildManager } from '../server/compiler/builds.mjs';
import { runProcess } from '../server/compiler/process.mjs';

async function fixture(fn, options) {
  const f = await createBuildFixture(options);
  try { await fn(f); } finally { await f.close(); }
}
test('a failed new build preserves the previous PDF and exposes its own diagnostics', async () => fixture(async f => {
  const first = await f.submitAndFinish();
  assert.equal(first.status, 'succeeded');
  assert.equal(first.pages, 1);
  assert.ok(first.warnings.length);
  const failed = await f.submitAndFinish({ outcome: 'failed' });
  assert.equal(failed.status, 'failed');
  assert.equal(await f.latestSuccessfulId(), first.id);
  assert.equal(await f.readPdf(first.id), '%PDF-first');
  assert.match(await readFile(await f.manager.logPath(failed.id), 'utf8'), /Output written/);
  await assert.rejects(f.manager.pdfPath(failed.id), e => e.code === 'PDF_NOT_AVAILABLE');
  await assert.rejects(f.manager.logPath('../outside'), e => e.code === 'VALIDATION_ERROR');
}));
test('missing or invalid PDF never publishes a successful build', async () => fixture(async f => {
  for (const outcome of ['missing_pdf', 'invalid_pdf']) assert.equal((await f.submitAndFinish({ outcome })).status, 'failed');
  assert.equal(await f.latestSuccessfulId(), undefined);
}));
test('global busy reservation happens before asynchronous capture', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await fixture(async f => {
    const original = f.store.capture;
    f.store.capture = async (...args) => { await blocked; return original(...args); };
    const pending = f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    await assert.rejects(f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 }), e => e.code === 'BUILDER_BUSY');
    release();
    await finish(f.manager, (await pending).id);
    f.store.capture = original;
  });
});
test('a later edit cannot change the captured revision or generated input', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await fixture(async f => {
    const record = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    f.doc.data.profile.name = 'edited later';
    await f.store.save(f.doc.id, { expectedRevision: 0, data: f.doc.data });
    release();
    const built = await finish(f.manager, record.id);
    assert.equal(built.revision, 0);
    assert.equal(await readFile(join(f.store.buildDirectory(record.id), 'resume.tex'), 'utf8'), 'first');
  }, { prepareBuild: async ({ buildDir, snapshot }) => {
    await blocked;
    await writeFile(join(buildDir, 'resume.tex'), snapshot.data.profile.name || 'first');
    return { cwd: buildDir, entryFile: 'resume.tex' };
  } });
});
test('two compile passes consume one total deadline', async () => {
  const budgets = [];
  await fixture(async f => {
    const result = await f.submitAndFinish();
    assert.equal(result.status, 'timed_out');
    assert.equal(budgets.length, 2);
    assert.ok(budgets[1] < budgets[0] - 20);
    assert.equal(await f.latestSuccessfulId(), undefined);
  }, { config: { compileTimeoutMs: 100 }, run: async ({ timeoutMs }) => {
    budgets.push(timeoutMs);
    if (budgets.length === 1) { await delay(35); return { exitCode: 0, timedOut: false, aborted: false, log: 'pass1' }; }
    await delay(timeoutMs);
    return { exitCode: null, timedOut: true, aborted: false, log: 'pass2 timeout' };
  } });
});
test('recovery interrupts abandoned records and restores the last successful preview', async () => fixture(async f => {
  const first = await f.submitAndFinish();
  const abandoned = { ...first, id: randomUUID(), status: 'running', finishedAt: null, pages: null, error: null };
  await f.store.registerBuild(abandoned);
  const restarted = createBuildManager({ config: f.config, store: f.store });
  await restarted.recover();
  assert.equal((await restarted.read(abandoned.id)).status, 'interrupted');
  assert.equal((await restarted.latestForResume(f.doc.id)).id, first.id);
  assert.equal(await f.readPdf(first.id), '%PDF-first');
  assert.match(await readFile(await restarted.logPath(abandoned.id), 'utf8'), /中断/);
  await restarted.shutdown();
}));
test('shutdown interrupts a running compiler and preserves its preceding success', async () => {
  let wait = false;
  let started;
  const running = new Promise(resolve => { started = resolve; });
  await fixture(async f => {
    const first = await f.submitAndFinish();
    wait = true;
    const pending = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    await running;
    await f.manager.shutdown();
    assert.equal((await f.manager.read(pending.id)).status, 'interrupted');
    assert.equal(await f.readPdf(first.id), '%PDF-first');
    await assert.rejects(f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 }), e => e.code === 'BUILDER_SHUTDOWN');
  }, { run: async ({ cwd, signal }) => {
    if (!wait) { await writeFile(join(cwd, 'resume.pdf'), '%PDF-first'); return { exitCode: 0, timedOut: false, aborted: false, log: '' }; }
    started();
    await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
    return { exitCode: null, timedOut: false, aborted: true, log: 'aborted' };
  } });
});
test('publication prunes old versions but preserves foreign files and other resumes', async () => fixture(async f => {
  await writeFile(join(f.dataDir, 'keep.txt'), 'unrelated');
  const otherResume = await f.store.create({ name: '另一份', language: 'zh-CN' });
  const otherBuild = { id: randomUUID(), resumeId: otherResume.id, revision: 0, status: 'running',
    createdAt: '2026-10-01T00:00:00.000Z', finishedAt: null, pages: null, warnings: [], error: null };
  await f.store.registerBuild(otherBuild);
  await writeFile(join(f.store.buildDirectory(otherBuild.id), 'resume.pdf'), '%PDF-other-resume');
  await f.store.publishBuild({ ...otherBuild, status: 'succeeded', finishedAt: '2026-10-01T00:01:00.000Z' });
  const ids = [];
  for (let i = 0; i < 7; i++) { await delay(2); ids.push((await f.submitAndFinish()).id); }
  for (let i = 0; i < 3; i++) await f.submitAndFinish({ outcome: 'failed' });
  assert.equal((await readdir(join(f.dataDir, 'builds'))).length, 7);
  await assert.rejects(f.manager.read(ids[0]), e => e.code === 'NOT_FOUND');
  assert.equal(await readFile(join(f.dataDir, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal(await f.readPdf(ids.at(-1)), '%PDF-first');
  assert.equal(await f.readPdf(otherBuild.id), '%PDF-other-resume');
}));
test('unavailable compiler and snapshot conflicts leave saving usable and release reservation', async () => fixture(async f => {
  await assert.rejects(f.manager.submit({ resumeId: f.doc.id, expectedRevision: 4 }), e => e.code === 'REVISION_CONFLICT');
  const built = await f.submitAndFinish();
  assert.equal(built.status, 'succeeded');
  const absent = createBuildManager({ config: f.config, store: f.store, detect: async () => ({ available: false, executable: null, message: '未找到 XeLaTeX' }) });
  await assert.rejects(absent.submit({ resumeId: f.doc.id, expectedRevision: 0 }), e => e.code === 'COMPILER_UNAVAILABLE');
  assert.equal((await f.store.save(f.doc.id, { expectedRevision: 0, data: f.doc.data })).revision, 1);
  await absent.shutdown();
}));
test('second-pass failure cannot publish the PDF left behind by its first pass', async () => {
  let pass = 0;
  await fixture(async f => {
    const record = await f.submitAndFinish();
    assert.equal(record.status, 'failed');
    assert.equal(await f.latestSuccessfulId(), undefined);
    await assert.rejects(f.manager.pdfPath(record.id), e => e.code === 'PDF_NOT_AVAILABLE');
  }, { run: async ({ cwd }) => {
    pass++;
    await writeFile(join(cwd, 'resume.pdf'), '%PDF-first-pass');
    return { exitCode: pass === 1 ? 0 : 1, timedOut: false, aborted: false, log: `pass ${pass}` };
  } });
});
test('manager shutdown terminates a real compiler child before completing', async () => {
  await fixture(async f => {
    const record = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    const pidFile = join(f.store.buildDirectory(record.id), 'child.pid');
    let pid;
    for (let i = 0; i < 300 && !pid; i++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (!pid) await delay(5);
    }
    assert.ok(pid > 0);
    await f.manager.shutdown();
    assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
    assert.equal((await f.manager.read(record.id)).status, 'interrupted');
  }, { run: args => runProcess({ ...args, executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("child.pid",String(process.pid)); setInterval(()=>{},1000);'] }) });
});
test('PDF signature validation rejects high-bit bytes rather than ASCII masking them', async () => fixture(async f => {
  const record = await f.submitAndFinish();
  assert.equal(record.status, 'failed');
  assert.equal(await f.latestSuccessfulId(), undefined);
}, { run: async ({ cwd }) => {
  await writeFile(join(cwd, 'resume.pdf'), Buffer.from([0xa5, 0x50, 0x44, 0x46, 0x2d]));
  return { exitCode: 0, timedOut: false, aborted: false, log: '' };
} }));
test('publication storage failure is reported instead of leaving a silent endless running task', async () => fixture(async f => {
  const publish = f.store.publishBuild;
  f.store.publishBuild = async () => { throw Object.assign(new Error('private disk path'), { code: 'EACCES' }); };
  try {
    const record = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    await delay(100);
    await assert.rejects(f.manager.read(record.id), e => e.code === 'BUILD_PUBLISH_FAILED' && !e.message.includes('private disk path'));
    assert.equal(await f.latestSuccessfulId(), undefined);
  } finally {
    f.store.publishBuild = publish;
    await f.manager.recover();
  }
}));
test('preparation receives the unified deadline signal and publishes timed_out without running TeX', async () => {
  let release;
  let preparationEnded = false;
  let compileCalls = 0;
  await fixture(async f => {
    const record = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    try {
      await delay(120);
      const terminal = await f.manager.read(record.id);
      assert.equal(terminal.status, 'timed_out');
      assert.equal(terminal.error.code, 'COMPILE_TIMEOUT');
      assert.equal(preparationEnded, true);
      assert.equal(compileCalls, 0);
      assert.equal(await f.latestSuccessfulId(), undefined);
    } finally { release(); }
  }, { config: { compileTimeoutMs: 40 }, prepareBuild: async ({ buildDir, signal }) => {
    try {
      await new Promise(resolve => {
        release = resolve;
        if (signal?.aborted) resolve(); else signal?.addEventListener('abort', resolve, { once: true });
      });
      signal?.throwIfAborted();
      return { cwd: buildDir, entryFile: 'resume.tex' };
    } finally { preparationEnded = true; }
  }, run: async () => { compileCalls++; return { exitCode: 0, timedOut: false, aborted: false, log: '' }; } });
});
test('shutdown cancels preparation and awaits its quiescence before terminal publication', async () => {
  let release;
  let preparationEnded = false;
  await fixture(async f => {
    const record = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    const closing = f.manager.shutdown();
    try {
      const closedPromptly = await Promise.race([closing.then(() => true), delay(200).then(() => false)]);
      assert.equal(closedPromptly, true);
      assert.equal(preparationEnded, true);
      const terminal = await f.manager.read(record.id);
      assert.equal(terminal.status, 'interrupted');
      assert.equal(terminal.error.code, 'INTERRUPTED');
      await assert.rejects(readFile(join(f.store.buildDirectory(record.id), 'late.tex')), e => e.code === 'ENOENT');
    } finally { release(); await closing; }
  }, { prepareBuild: async ({ buildDir, signal }) => {
    try {
      await new Promise(resolve => {
        release = resolve;
        if (signal?.aborted) resolve(); else signal?.addEventListener('abort', resolve, { once: true });
      });
      signal?.throwIfAborted();
      await writeFile(join(buildDir, 'late.tex'), 'must never be written');
      return { cwd: buildDir, entryFile: 'resume.tex' };
    } finally { preparationEnded = true; }
  } });
});
test('read-only snapshot capture cancellation releases busy state and cannot register late work', async () => fixture(async f => {
  const capture = f.store.capture;
  let release;
  f.store.capture = async (...args) => { await new Promise(resolve => { release = resolve; }); return capture(...args); };
  const pending = f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
  try {
    const outcome = await Promise.race([pending.then(() => 'registered', e => e.code), delay(200).then(() => 'still pending')]);
    assert.equal(outcome, 'COMPILE_TIMEOUT');
    f.store.capture = capture;
    release();
    await delay(30);
    assert.deepEqual(await readdir(join(f.dataDir, 'builds')), []);
  } finally { release?.(); f.store.capture = capture; await pending.catch(() => {}); }
}, { config: { compileTimeoutMs: 40 } }));
test('cancelled preparation is drained before shutdown can publish or clear its active slot', async () => {
  let release;
  let observedAbort;
  const aborted = new Promise(resolve => { observedAbort = resolve; });
  await fixture(async f => {
    const record = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    let closed = false;
    const closing = f.manager.shutdown().then(() => { closed = true; });
    try {
      await aborted;
      assert.equal(closed, false);
      assert.equal((await f.manager.read(record.id)).status, 'running');
      release();
      await closing;
      assert.equal((await f.manager.read(record.id)).status, 'interrupted');
      await delay(30);
      await assert.rejects(readFile(join(f.store.buildDirectory(record.id), 'late.tex')), e => e.code === 'ENOENT');
    } finally { release(); await closing; }
  }, { prepareBuild: async ({ buildDir, signal }) => {
    const drained = new Promise(resolve => { release = resolve; });
    if (signal.aborted) observedAbort(); else signal.addEventListener('abort', observedAbort, { once: true });
    await drained;
    signal.throwIfAborted();
    await writeFile(join(buildDir, 'late.tex'), 'must never be written');
    return { cwd: buildDir, entryFile: 'resume.tex' };
  } });
});
test('shutdown during read-only capture rejects submit promptly and discards its late snapshot', async () => fixture(async f => {
  const capture = f.store.capture;
  let release;
  let started;
  const capturing = new Promise(resolve => { started = resolve; });
  f.store.capture = async (...args) => { started(); await new Promise(resolve => { release = resolve; }); return capture(...args); };
  const pending = f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
  const outcome = pending.then(() => 'registered', e => e.code);
  await capturing;
  try {
    await f.manager.shutdown();
    assert.equal(await outcome, 'BUILDER_SHUTDOWN');
    release();
    await delay(30);
    assert.deepEqual(await readdir(join(f.dataDir, 'builds')), []);
  } finally { release(); f.store.capture = capture; await pending.catch(() => {}); }
}));
test('detection receives deadline cancellation before any snapshot or registration', async () => fixture(async f => {
  await assert.rejects(f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 }), e => e.code === 'COMPILE_TIMEOUT');
  assert.deepEqual(await readdir(join(f.dataDir, 'builds')), []);
}, { config: { compileTimeoutMs: 40 }, detect: async (_config, { signal }) => {
  await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
  return { available: false, executable: null, message: 'cancelled' };
} }));
test('cancelled record registration settles before shutdown and never begins preparation', async () => fixture(async f => {
  const register = f.store.registerBuild;
  let release;
  let started;
  let preparations = 0;
  const registering = new Promise(resolve => { started = resolve; });
  f.store.registerBuild = async record => { started(); await new Promise(resolve => { release = resolve; }); return register(record); };
  const originalManager = f.manager;
  const manager = createBuildManager({ config: f.config, store: f.store,
    detect: async () => ({ available: true, executable: 'controlled-compiler', message: 'ready' }),
    prepareBuild: async () => { preparations++; throw Error('must not prepare after cancellation'); } });
  const pending = manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
  await registering;
  let closed = false;
  const closing = manager.shutdown().then(() => { closed = true; });
  try {
    await delay(20);
    assert.equal(closed, false);
    release();
    const record = await pending;
    await closing;
    assert.equal(preparations, 0);
    assert.equal((await manager.read(record.id)).status, 'interrupted');
  } finally { release(); f.store.registerBuild = register; await closing; await originalManager.shutdown(); }
}));

test('successful two-pass build reports final diagnostics while full log retains first pass', async () => {
  let pass=0;
  await fixture(async f => {
    const result=await f.submitAndFinish();
    assert.equal(result.status,'succeeded');
    assert.deepEqual(result.warnings,['LaTeX Warning: final genuine warning']);
    const log=await readFile(await f.manager.logPath(result.id),'utf8');
    assert.match(log,/Rerun to get cross-references right/);
    assert.match(log,/final genuine warning/);
  }, {run:async ({cwd})=>{
    await writeFile(join(cwd,'resume.pdf'),'%PDF-actual controlled build');
    pass++;
    return {exitCode:0,timedOut:false,aborted:false,log:pass===1?'LaTeX Warning: Rerun to get cross-references right.\nOutput written on resume.pdf (1 page).':'LaTeX Warning: final genuine warning\nOutput written on resume.pdf (1 page).'};
  }});
});
