import { readdir } from 'node:fs/promises';
import { join, delimiter, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { probeCompiler } from './process.mjs';

async function commonExecutables(env) {
  if (process.platform !== 'win32') return ['/Library/TeX/texbin/xelatex', '/usr/bin/xelatex', '/usr/local/bin/xelatex'];
  const paths = [];
  for (const root of [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
    paths.push(join(root, 'MiKTeX', 'miktex', 'bin', 'x64', 'xelatex.exe'));
    paths.push(join(root, 'MiKTeX', 'miktex', 'bin', 'xelatex.exe'));
  }
  const texlive = join(env.SystemDrive || 'C:', 'texlive');
  try {
    for (const item of (await readdir(texlive, { withFileTypes: true })).filter(x => x.isDirectory() && /^\d{4}$/.test(x.name)).sort((a,b) => b.name.localeCompare(a.name))) {
      paths.push(join(texlive, item.name, 'bin', 'windows', 'xelatex.exe'));
      paths.push(join(texlive, item.name, 'bin', 'win32', 'xelatex.exe'));
    }
  } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  return paths;
}
/** Optional collaborators keep discovery deterministic and cancellation bounded. */
export async function discoverCompiler(config, { env = process.env, commonPaths, probe = probeCompiler, timeoutMs = 5000, signal } = {}) {
  const deadline = performance.now() + Math.min(5000, timeoutMs);
  let timedOut = false;
  const interrupted = () => ({ available: false, executable: null, message: 'XeLaTeX 检测已中断，简历仍可保存。' });
  if (signal?.aborted) return interrupted();
  const explicit = config.xelatexPath;
  const executableName = process.platform === 'win32' ? 'xelatex.exe' : 'xelatex';
  const pathValue = env.PATH ?? env.Path ?? '';
  const pathDirectories = pathValue.split(delimiter).map(entry => entry.trim().replace(/^"|"$/g, '').trim()).filter(Boolean);
  const candidates = explicit ? [resolve(config.projectRoot || '.', explicit)] : [
    ...pathDirectories.map(directory => resolve(directory, executableName)),
    ...(commonPaths ?? await commonExecutables(env)).map(executable => resolve(executable)),
  ];
  for (const executable of new Set(candidates)) {
    if (signal?.aborted) return interrupted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) { timedOut = true; break; }
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    const childEnv = { ...env, [pathKey]: `${dirname(resolve(executable))}${delimiter}${env[pathKey] || ''}` };
    const result = await probe(executable, { timeoutMs: remaining, signal, env: childEnv });
    timedOut ||= result.timedOut === true;
    if (signal?.aborted || result.aborted) return interrupted();
    if (result.flavour) return { available: true, executable, flavour: result.flavour, version: result.log.trim(), env: childEnv,
      message: `XeLaTeX 可用 (${result.flavour === 'miktex' ? 'MiKTeX' : 'TeX Live'})` };
  }
  return { available: false, executable: null, timedOut, message: explicit
    ? '配置的 XeLaTeX 无法执行或不是支持的 MiKTeX/TeX Live，请检查本地编译器路径。简历仍可保存。'
    : '未找到 XeLaTeX，请安装 MiKTeX/TeX Live 或在 config.local.json 设置 xelatexPath。简历仍可保存。' };
}
export function detectCompiler(config, options) { return discoverCompiler(config, options); }
