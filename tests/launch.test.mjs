import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm, readFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { createStore } from '../server/storage.mjs';
import { createBuildManager } from '../server/compiler/builds.mjs';
import { finish } from './helpers/builds.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { acquireDataDirectory } from '../server/ownership.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
async function availablePort() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
async function launchRoot(t, deferCleanup = false) {
  const temp = await mkdtemp(join(tmpdir(), 'PureCV 中文 空格-')); if (!deferCleanup) t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, '项目'); await mkdir(root);
  for (const path of ['server', 'web', 'examples', 'start.cmd', 'start.sh']) await cp(join(project, path), join(root, path), { recursive: true });
  const port = await availablePort(); await writeFile(join(root, 'config.local.json'), JSON.stringify({ port, dataDir: '数据 目录', xelatexPath: 'missing-xelatex.exe' }));
  return { temp, root, port };
}

test('same-port and different-port second startup cannot interrupt a live build or release its owner', async t => {
  const f = await launchRoot(t); const first = await startServer(f.root, { openBrowser: false });
  const dataDir = join(f.root, '数据 目录'); const store = await createStore({ dataDir });
  let release; const held = new Promise(resolve => release = resolve);
  const manager = createBuildManager({ config: { projectRoot: f.root, dataDir, compileTimeoutMs: 10000 }, store,
    detect: async () => ({ available: true, executable: 'controlled' }),
    prepareBuild: async ({ buildDir }) => { await held; return { cwd: buildDir, entryFile: 'resume.tex' }; },
    run: async ({ cwd }) => { await writeFile(join(cwd, 'resume.pdf'), '%PDF-test'); return { exitCode: 0, log: 'Output written on resume.pdf (1 page).' }; } });
  try {
    const doc = (await store.list())[0];
    const record = await manager.submit({ resumeId: doc.id, expectedRevision: doc.revision });
    for (const port of [f.port, await availablePort()]) {
      await writeFile(join(f.root, 'config.local.json'), JSON.stringify({ port, dataDir, xelatexPath: 'missing.exe' }));
      let accidental;
      try { await assert.rejects(async () => { accidental = await startServer(f.root, { openBrowser: false }); }, e => e.code === 'DATA_DIRECTORY_IN_USE'); }
      finally { if (accidental) await accidental.server.shutdown(); }
      assert.equal((await store.readBuild(record.id)).status, 'running');
      assert.equal((await fetch(first.url)).status, 200);
    }
    release(); assert.equal((await finish(manager, record.id)).status, 'succeeded');
  } finally { release(); await manager.shutdown(); await first.server.shutdown(); }
  const restarted = await startServer(f.root, { openBrowser: false }); await restarted.server.shutdown();
});

test('canonical data-directory alias cannot obtain a second owner', async t => {
  const f = await launchRoot(t); const first = await startServer(f.root, { openBrowser: false });
  try {
    const alias = join(f.root, 'alias'); await symlink(join(f.root, '数据 目录'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(f.root, 'config.local.json'), JSON.stringify({ port: await availablePort(), dataDir: alias, xelatexPath: 'missing.exe' }));
    let accidental;
    try { await assert.rejects(async () => { accidental = await startServer(f.root, { openBrowser: false }); }, e => e.code === 'DATA_DIRECTORY_IN_USE'); }
    finally { if (accidental) await accidental.server.shutdown(); }
  } finally { await first.server.shutdown(); }
});

test('real abandoned child owner is released by OS and startup recovers its interrupted record', async t => {
  const f = await launchRoot(t);
  const child = spawn(process.execPath, [join(f.root, 'server/index.mjs'), '--no-open'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Child startup timeout')), 10000);
      let output = ''; child.stdout.on('data', bytes => { output += bytes; if (output.includes('Resume Workbench:')) { clearTimeout(timeout); resolve(); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(Error('Child exited before startup')); });
    });
    const store = await createStore({ dataDir: join(f.root, '数据 目录') }); const doc = (await store.list())[0];
    const record = await store.registerBuild({ id: randomUUID(), resumeId: doc.id, revision: doc.revision, status: 'running', createdAt: new Date().toISOString(), finishedAt: null, pages: null, warnings: [], error: null });
    await assert.rejects(startServer(f.root, { openBrowser: false }), e => e.code === 'DATA_DIRECTORY_IN_USE');
    assert.equal((await store.readBuild(record.id)).status, 'running');
    child.kill('SIGKILL'); await exited;
    const restarted = await startServer(f.root, { openBrowser: false });
    try { assert.equal((await store.readBuild(record.id)).status, 'interrupted'); }
    finally { await restarted.server.shutdown(); }
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
});
test('startServer seeds fictional documents once and missing compiler permits save and backup', async t => {
  const f = await launchRoot(t);
  for (let run = 0; run < 2; run++) {
    const { server, url } = await startServer(f.root, { openBrowser: false });
    try {
      assert.equal((await fetch(url)).status, 200);
      assert.equal((await (await fetch(url + '/api/environment')).json()).available, false);
      const { resumes } = await (await fetch(url + '/api/resumes')).json(); assert.equal(resumes.length, 2); assert.deepEqual(resumes.map(r => r.language).sort(), ['en', 'zh-CN']);
      const doc = await (await fetch(url + `/api/resumes/${resumes[0].id}`)).json();
      const saved = await fetch(url + `/api/resumes/${doc.id}`, { method: 'PUT', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: doc.revision, data: doc.data }) }); assert.equal(saved.status, 200);
      assert.equal((await fetch(url + `/api/resumes/${doc.id}/backup`)).status, 200);
    } finally { await server.shutdown(); }
  }
});
test('port collision supplies configuration advice', async t => {
  const f = await launchRoot(t); const blocker = http.createServer(); await new Promise(r => blocker.listen(f.port, '127.0.0.1', r));
  try { await assert.rejects(startServer(f.root, { openBrowser: false }), e => e.code === 'PORT_IN_USE' && /config.local.json/.test(e.message)); }
  finally { await new Promise(r => blocker.close(r)); }
  const restarted = await startServer(f.root, { openBrowser: false }); await restarted.server.shutdown();
});

test('occupied ownership port fails closed with accurate advice and no store mutation', async t => {
  const f = await launchRoot(t); const dataDir = join(f.root, '数据 目录'); await mkdir(dataDir);
  const canonical = await realpath(dataDir);
  const port = 20000 + createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest().readUInt32BE(0) % 20000;
  const foreign = http.createServer(); await new Promise(r => foreign.listen(port, '127.0.0.1', r));
  try {
    await assert.rejects(startServer(f.root, { openBrowser: false }), e => e.code === 'DATA_DIRECTORY_IN_USE' && /其他程序.*系统/.test(e.message));
    await assert.rejects(readFile(join(dataDir, 'resumes')), { code: 'ENOENT' });
    assert.equal(foreign.listening, true);
  } finally { await new Promise(r => foreign.close(r)); }
});

test('early seeding failure releases ownership and old release cannot close new owner', async t => {
  const f = await launchRoot(t); const example = join(f.root, 'examples/resume.zh.json'); const bytes = await readFile(example);
  await rm(example);
  await assert.rejects(startServer(f.root, { openBrowser: false }), { code: 'ENOENT' });
  await writeFile(example, bytes);
  const server = await startServer(f.root, { openBrowser: false }); await server.server.shutdown();
  const old = await acquireDataDirectory(join(f.root, '数据 目录')); await old.release();
  const next = await acquireDataDirectory(join(f.root, '数据 目录'));
  try { await old.release(); await assert.rejects(acquireDataDirectory(join(f.root, '数据 目录')), e => e.code === 'DATA_DIRECTORY_IN_USE'); }
  finally { await next.release(); }
});

test('concurrent startup attempts acquire exactly one owner before seeding', async t => {
  const f = await launchRoot(t);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => startServer(f.root, { openBrowser: false })));
  const winners = results.filter(result => result.status === 'fulfilled');
  try {
    assert.equal(winners.length, 1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'DATA_DIRECTORY_IN_USE'));
    const { resumes } = await (await fetch(winners[0].value.url + '/api/resumes')).json();
    assert.equal(resumes.length, 2);
  } finally { await Promise.all(winners.map(result => result.value.server.shutdown())); }
});

test('startup explains compiler status and points to local help without private paths', async t => {
  const f = await launchRoot(t); const messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  const { server, url } = await startServer(f.root, { openBrowser: false });
  try {
    assert.ok(messages.some(message => message.includes(url)));
    assert.ok(messages.some(message => /XeLaTeX/.test(message) && /config.local.json/.test(message) && /保存和备份/.test(message)));
    assert.ok(messages.some(message => /docs\/local-editor.md/.test(message)));
    assert.doesNotMatch(messages.join(' '), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { await server.shutdown(); }
});
test('actual platform launcher resolves its own directory from another cwd', async t => {
  const f = await launchRoot(t, true);
  const windows = process.platform === 'win32';
  const child = windows ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${join(f.root, 'start.cmd')}" --no-open"`], { cwd: f.temp, env: { ...process.env, PATH: dirname(process.execPath) + ';' + (process.env.SystemRoot || 'C:/Windows') + '/System32' }, windowsHide: true, windowsVerbatimArguments: true })
    : spawn('sh', [join(f.root, 'start.sh'), '--no-open'], { cwd: f.temp, env: { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH } });
  t.after(async () => {
    if (child.exitCode === null) {
      if (windows) await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 });
      else child.kill('SIGTERM');
      await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
    }
    await rm(f.temp, { recursive: true, force: true });
  });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(Error('launcher timeout: ' + output)); }, 10000);
    const poll = setInterval(() => { if (output.includes(`http://127.0.0.1:${f.port}`)) { clearTimeout(deadline); clearInterval(poll); resolve(); } else if (child.exitCode !== null) { clearTimeout(deadline); clearInterval(poll); reject(Error('launcher exited: ' + output)); } }, 20);
  });
  const url = `http://127.0.0.1:${f.port}`; assert.equal((await fetch(url)).status, 200); assert.equal((await (await fetch(url + '/api/resumes')).json()).resumes.length, 2);
});

test('Windows launcher reports missing Node without starting a server', { skip: process.platform !== 'win32' }, async t => {
  const f = await launchRoot(t);
  await assert.rejects(promisify(execFile)(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${join(f.root, 'start.cmd')}" --no-open"`], { cwd: f.temp,
    env: { ...process.env, PATH: (process.env.SystemRoot || 'C:/Windows') + '/System32' }, windowsHide: true, windowsVerbatimArguments: true }), e => e.code === 1 && /Node.js 22/.test(e.stdout));
});

test('browser launch failure retains the URL and a working server', { skip: process.platform !== 'win32' }, async t => {
  const f = await launchRoot(t);
  const previousComSpec = process.env.ComSpec; const previousError = console.error; const messages = [];
  let server;
  try {
    process.env.ComSpec = join(f.root, 'missing-browser-command.exe'); console.error = message => messages.push(message);
    const started = await startServer(f.root, { openBrowser: true }); server = started.server;
    assert.equal((await fetch(started.url)).status, 200);
    assert.ok(messages.some(message => message.includes(started.url)));
  } finally {
    if (previousComSpec === undefined) delete process.env.ComSpec; else process.env.ComSpec = previousComSpec;
    console.error = previousError; if (server) await server.shutdown();
  }
});
