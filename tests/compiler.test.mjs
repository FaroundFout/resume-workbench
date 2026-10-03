import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, runXeLaTeX, compilerFlavour, xelatexArguments } from '../server/compiler/process.mjs';
import { discoverCompiler, detectCompiler } from '../server/compiler/environment.mjs';

test('missing PATH and common locations yield an actionable unavailable result', async () => {
  const result = await discoverCompiler({ xelatexPath: null }, { env: {}, commonPaths: [] });
  assert.equal(result.available, false);
  assert.equal(result.executable, null);
  assert.match(result.message, /XeLaTeX/);
});
test('an explicitly unusable executable fails without silently selecting another', async () => {
  const result = await detectCompiler({ xelatexPath: join(tmpdir(), '不存在 xelatex.exe') });
  assert.equal(result.available, false);
  assert.match(result.message, /配置/);
  assert.equal((await detectCompiler({ xelatexPath: process.execPath })).available, false);
});
test('compiler identity controls installer suppression and required safe flags', () => {
  assert.equal(compilerFlavour('MiKTeX-XeTeX 4.22'), 'miktex');
  assert.equal(compilerFlavour('XeTeX 3.141592653 (TeX Live 2026)'), 'texlive');
  assert.equal(compilerFlavour('v24.19.0'), null);
  const miktex = xelatexArguments('resume.tex', 'miktex');
  const texlive = xelatexArguments('resume.tex', 'texlive');
  for (const args of [miktex, texlive]) {
    for (const flag of ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error']) assert.ok(args.includes(flag));
    assert.equal(args.at(-1), 'resume.tex');
  }
  assert.ok(miktex.includes('--disable-installer'));
  assert.equal(texlive.includes('--disable-installer'), false);
});
test('real Node subprocess exits and captures stdout and stderr without shell expansion', async () => {
  const result = await runProcess({ executable: process.execPath, cwd: tmpdir(), args: ['-e', 'console.log("stdout $()"); console.error("stderr");'], timeoutMs: 3000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.match(result.log, /stdout \$\(\)/);
  assert.match(result.log, /stderr/);
});
test('real long-running Node subprocess is killed on timeout and cannot keep running', async () => {
  const result = await runProcess({ executable: process.execPath, cwd: tmpdir(), args: ['-e', 'console.log(process.pid); setInterval(()=>{},1000);'], timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  const pid = Number(result.log.trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
});
test('abort kills the real child and an already-aborted signal starts no child', async () => {
  const controller = new AbortController();
  const pending = runProcess({ executable: process.execPath, cwd: tmpdir(), args: ['-e', 'console.log(process.pid); setInterval(()=>{},1000);'], timeoutMs: 3000, signal: controller.signal });
  setTimeout(() => controller.abort(), 400);
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.throws(() => process.kill(Number(result.log.trim()), 0), e => e.code === 'ESRCH');
  const second = await runProcess({ executable: process.execPath, cwd: tmpdir(), args: ['-e', 'throw new Error("must not start")'], timeoutMs: 3000, signal: controller.signal });
  assert.equal(second.aborted, true);
  assert.equal(second.log, '');
});
test('a non-TeX executable cannot execute a compile request', async () => {
  const result = await runXeLaTeX({ executable: process.execPath, cwd: tmpdir(), entryFile: 'resume.tex', timeoutMs: 3000 });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.log, /无法识别/);
});
test('compiler discovery probes share a total bound and stop when aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await discoverCompiler({ xelatexPath: process.execPath }, { env: {}, commonPaths: [], signal: controller.signal });
  assert.equal(result.available, false);
  assert.match(result.message, /中断/);
  assert.ok(Date.now() - started < 1000);
});
test('PATH discovery accepts a recognized compiler and shares its probe budget', async () => {
  const budgets = [];
  const result = await discoverCompiler({ xelatexPath: null }, {
    env: {}, commonPaths: ['first', 'second'], timeoutMs: 100,
    probe: async (executable, options) => {
      budgets.push(options.timeoutMs);
      if (executable === 'first') { await new Promise(done => setTimeout(done, 25)); return { exitCode: 1, timedOut: false, aborted: false, log: '', flavour: null }; }
      return { exitCode: 0, timedOut: false, aborted: false, log: 'MiKTeX-XeTeX', flavour: 'miktex' };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.executable, 'second');
  assert.ok(budgets[1] < budgets[0] - 15);
});
test('timeout kills child-process descendants as well as the parent', async () => {
  const script = 'const {spawn}=require("node:child_process"); console.log(process.pid); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(child.pid); setInterval(()=>{},1000);';
  const result = await runProcess({ executable: process.execPath, cwd: tmpdir(), args: ['-e', script], timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  const pids = result.log.trim().split(/\s+/).map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
});
