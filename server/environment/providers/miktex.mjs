import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError } from '../../errors.mjs';
import { runProcess } from '../../compiler/process.mjs';

const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
function failed(code, message, diagnostic = '') {
  const error = new AppError(code, message, code === 'TEX_PACKAGE_TIMEOUT' ? 408 : 503);
  Object.defineProperty(error, 'diagnostics', { value: diagnostic });
  return error;
}
async function requireWritableManager(toolchain) {
  if (toolchain.flavour !== 'miktex' || !toolchain.manager) throw failed('TEX_MANAGER_UNAVAILABLE', '所选 MiKTeX 安装缺少包管理器，请修复该安装后重试。');
  if (toolchain.scope === 'shared' && toolchain.userRepair !== true) throw failed('TEX_PERMISSION_DENIED', '所选共享 MiKTeX 未确认当前用户修复能力，请在该安装中人工补齐依赖。');
  try {
    const bin = normalize(dirname(await realpath(toolchain.executable)));
    for (const executable of [toolchain.manager, toolchain.lookup].filter(Boolean)) {
      if (normalize(dirname(await realpath(executable))) !== bin) throw failed('TEX_TOOLCHAIN_MISMATCH', '编译器与管理工具不属于同一 LaTeX 安装，请检查所选环境。');
    }
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    if (['ENOENT', 'ENOTDIR'].includes(cause.code)) throw failed('TEX_MANAGER_UNAVAILABLE', '所选 MiKTeX 管理工具不可用，请修复该安装后重试。');
    if (['EACCES', 'EPERM'].includes(cause.code)) throw failed('TEX_PERMISSION_DENIED', '当前用户无法访问 MiKTeX 管理工具，请检查权限。');
    throw cause;
  }
}

// Commands are constructed below, never from diagnostic text or user input.
async function runManagementCommands(toolchain, commands, { signal, log = () => {}, run = runProcess,
  timeoutMs = 600000, failureCode = 'TEX_PACKAGE_INSTALL_FAILED' } = {}) {
  signal?.throwIfAborted();
  await requireWritableManager(toolchain);
  const budget = Math.min(600000, timeoutMs);
  const deadline = performance.now() + budget;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), Math.max(1, budget));
  const transcript = [];
  try {
    for (const { args, message } of commands) {
      log(message);
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw failed('TEX_PACKAGE_TIMEOUT', '宏包准备超过 10 分钟限制，请检查网络后重试。', transcript.join('\n'));
        const result = await run({ executable: toolchain.manager, cwd: dirname(toolchain.executable), args,
          timeoutMs: Math.max(1, Math.floor(remaining)), signal: controller.signal, ...(toolchain.env ? { env: toolchain.env } : {}) });
        transcript.push(result.log || '');
        signal?.throwIfAborted();
        if (result.timedOut || controller.signal.aborted || performance.now() >= deadline) throw failed('TEX_PACKAGE_TIMEOUT', '宏包准备超时，请检查网络后重试。', transcript.join('\n'));
        if (result.aborted) throw failed('TEX_PACKAGE_CANCELLED', '宏包准备已取消，可稍后重试。', transcript.join('\n'));
        if (result.exitCode === 0) break;
        const output = result.log || '';
        if (/permission denied|access.*denied|not permitted|requires? administrator|EACCES|EPERM|权限|拒绝访问/i.test(output)) throw failed('TEX_PERMISSION_DENIED', '当前用户无权安装所选 MiKTeX 的宏包，请检查用户范围和目录权限。', transcript.join('\n'));
        if (/ENOENT|ENOTDIR/.test(output)) throw failed('TEX_MANAGER_UNAVAILABLE', '所选 MiKTeX 包管理器无法启动，请修复该安装后重试。', transcript.join('\n'));
        const transient = /network|connection|repository|download|timeout|timed out|could not resolve|couldn't resolve|server.*(?:error|unavailable)|网络|仓库|下载/i.test(output);
        if (transient && attempt < 2) { log(`宏包下载失败，重试 ${attempt + 1}/2`); continue; }
        throw failed(transient ? 'TEX_REPOSITORY_UNAVAILABLE' : failureCode, transient
          ? 'MiKTeX 仓库或下载不可用，已用尽两次重试。请检查网络后重新运行 repair.cmd。'
          : failureCode === 'TEX_FORMAT_BUILD_FAILED' ? 'XeLaTeX 格式重建失败，请查看诊断并在 MiKTeX Console 中检查该格式。'
            : failureCode === 'TEX_UPDATE_FAILED' ? 'MiKTeX 已安装宏包更新失败，请查看诊断后重试 repair.cmd --update。'
              : 'MiKTeX 宏包安装失败，请查看本地诊断并重新运行 repair.cmd。', transcript.join('\n'));
      }
    }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Append known dependencies without upgrading the existing package set. */
export async function installMissingPackages(toolchain, packageIds, options = {}) {
  options.signal?.throwIfAborted();
  const { packageIdsByFlavour } = await import('../manifest.mjs');
  const allowed = new Set(Object.values(packageIdsByFlavour.miktex));
  if (!Array.isArray(packageIds) || packageIds.some(id => typeof id !== 'string' || !allowed.has(id))) {
    throw failed('TEX_PACKAGE_UNKNOWN', '发现未列入清单的宏包，请人工检查模板依赖。');
  }
  const ids = [...new Set(packageIds)];
  if (!ids.length) return;
  return runManagementCommands(toolchain, [
    { args: ['packages', 'update-package-database'], message: '更新 MiKTeX 宏包数据库' },
    { args: ['packages', 'install', ...ids], message: `安装缺少的宏包：${ids.join(', ')}` },
  ], options);
}

/** Explicit repair --update or a new private installation only. No admin mode. */
export async function updateInstalledPackages(toolchain, options = {}) {
  return runManagementCommands(toolchain, [
    { args: ['packages', 'update-package-database'], message: '更新 MiKTeX 宏包数据库' },
    { args: ['packages', 'update'], message: '同步所选 MiKTeX 的已安装宏包（包括 LaTeX 内核）' },
  ], { ...options, failureCode: 'TEX_UPDATE_FAILED' });
}

export async function rebuildXeLaTeXFormat(toolchain, options = {}) {
  return runManagementCommands(toolchain, [
    { args: ['--disable-installer', 'fndb', 'refresh'], message: '刷新所选 MiKTeX 的文件名数据库' },
    { args: ['--disable-installer', 'formats', 'build', 'xelatex'], message: '重建所选 MiKTeX 的 XeLaTeX 格式' },
  ], { ...options, failureCode: 'TEX_FORMAT_BUILD_FAILED' });
}
