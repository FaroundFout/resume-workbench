import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const compilerFlavours = new Map();

/** Bounded shell-free child lifetime, including TeX's PDF-driver descendants. */
export function runProcess({ executable, cwd, args, timeoutMs, signal }) {
  if (signal?.aborted) return Promise.resolve({ exitCode: null, timedOut: false, aborted: true, log: '' });
  if (!(timeoutMs > 0)) return Promise.resolve({ exitCode: null, timedOut: true, aborted: false, log: '' });
  return new Promise(resolve => {
    let log = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let timer;
    let killer = Promise.resolve();
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const ended = new Set();
    const flush = index => { if (!ended.has(index)) { log += decoders[index].end(); ended.add(index); } };
    const append = (chunk, index = 0) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const left = MAX_LOG_BYTES - bytes;
      if (left > 0) { const part = data.subarray(0, left); log += decoders[index].write(part); bytes += part.length; }
      if (data.length > left && !truncated) { flush(0); flush(1); log += '\n[日志超过 2MiB，后续输出已省略]\n'; truncated = true; }
    };
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const terminate = reason => {
      if (timedOut || aborted) return;
      timedOut = reason === 'timeout';
      aborted = reason === 'abort';
      if (!child.pid) return;
      if (process.platform === 'win32') {
        killer = new Promise(done => {
          const kill = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          const fallback = setTimeout(() => { child.kill('SIGKILL'); kill.kill(); }, 2000);
          kill.once('error', () => { clearTimeout(fallback); child.kill('SIGKILL'); done(); });
          kill.once('close', () => { clearTimeout(fallback); child.kill('SIGKILL'); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => terminate('abort');
    child.stdout.on('data', chunk => append(chunk, 0));
    child.stderr.on('data', chunk => append(chunk, 1));
    child.stdout.once('end', () => flush(0));
    child.stderr.once('end', () => flush(1));
    child.once('error', error => append(`无法启动编译进程 (${error.code || 'PROCESS_ERROR'})\n`));
    child.once('close', async exitCode => {
      flush(0); flush(1);
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await killer;
      resolve({ exitCode: timedOut || aborted ? null : exitCode, timedOut, aborted, log });
    });
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function compilerFlavour(version) {
  if (!/XeTeX|XeLaTeX/i.test(version)) return null;
  if (/MiKTeX/i.test(version)) return 'miktex';
  if (/TeX Live/i.test(version)) return 'texlive';
  return null;
}
export async function probeCompiler(executable, { timeoutMs = 5000, signal, cwd } = {}) {
  const result = await runProcess({ executable, cwd, args: ['--version'], timeoutMs, signal });
  const flavour = result.exitCode === 0 && !result.timedOut && !result.aborted ? compilerFlavour(result.log) : null;
  if (flavour) compilerFlavours.set(executable, flavour);
  return { ...result, flavour };
}
export function xelatexArguments(entryFile, flavour) {
  return ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error',
    ...(flavour === 'miktex' ? ['--disable-installer'] : []), entryFile];
}
export async function runXeLaTeX({ executable, cwd, entryFile, timeoutMs, signal }) {
  const started = performance.now();
  let flavour = compilerFlavours.get(executable);
  if (!flavour) {
    const probe = await probeCompiler(executable, { cwd, timeoutMs: Math.min(5000, timeoutMs), signal });
    if (!probe.flavour) return { exitCode: probe.exitCode === 0 ? 1 : probe.exitCode,
      timedOut: probe.timedOut, aborted: probe.aborted, log: `${probe.log}\n无法识别 XeLaTeX 发行版，请配置 MiKTeX 或 TeX Live。\n` };
    flavour = probe.flavour;
  }
  return runProcess({ executable, cwd, args: xelatexArguments(entryFile, flavour),
    timeoutMs: timeoutMs - (performance.now() - started), signal });
}
