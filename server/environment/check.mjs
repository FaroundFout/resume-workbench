import { readFile, stat, realpath } from 'node:fs/promises';
import { join, basename, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { requiredProjectFiles, requiredTexFiles, packageIdsByFlavour } from './manifest.mjs';
import { resolveToolchain } from './toolchain.mjs';
import { runProcess } from '../compiler/process.mjs';

const check = (id, status, code, message) => ({ id, status, code, message });
const timeoutCheck = () => check('environment', 'failed', 'ENVIRONMENT_TIMEOUT', '环境检测超时，请稍后重试');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Read-only resource and direct-dependency inspection; only real compilation can grant ready. */
export async function inspectEnvironment(config, { signal, toolchain: selected, run = runProcess, timeoutMs = 15000, onFile, ...options } = {}) {
  signal?.throwIfAborted();
  const deadline = performance.now() + Math.min(15000, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - performance.now()));
  const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const report = { editorReady: true, pdfReady: false, state: 'verification-required', checks: [], toolchain: null,
    fingerprint: null, verifiedAt: null, task: null };
  const hash = createHash('sha256').update(JSON.stringify({ requiredProjectFiles, requiredTexFiles, packageIdsByFlavour }));
  const addFile = async (id, path) => {
    const info = await stat(path);
    if (!info.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'NOT_FILE' });
    const bytes = await readFile(path, { signal: boundedSignal });
    if (!bytes.length) throw Object.assign(new Error('empty resource'), { code: 'EMPTY_FILE' });
    hash.update(JSON.stringify(id)).update(createHash('sha256').update(bytes).digest());
    onFile?.({ id, path, stat: info });
  };
  try {
    for (const file of requiredProjectFiles) {
      boundedSignal.throwIfAborted();
      try {
        await addFile(file, join(config.projectRoot, file));
        report.checks.push(check(file, 'passed', 'PROJECT_RESOURCE_PRESENT', `项目资源 ${file} 已找到`));
      } catch (error) {
        if (boundedSignal.aborted) throw error;
        const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
        report.checks.push(check(file, 'failed', missing ? 'PROJECT_RESOURCE_MISSING' : 'PROJECT_RESOURCE_INVALID',
          `${missing ? '缺少' : '无法读取有效'}项目资源 ${file}`));
      }
    }
    if (report.checks.some(item => item.status === 'failed')) { report.state = 'missing-resources'; return report; }
    let discovery;
    report.toolchain = selected === undefined ? await resolveToolchain(config, { ...options, signal: boundedSignal,
      timeoutMs: deadline - performance.now(), onDiscovery: result => { discovery = result; } }) : selected;
    boundedSignal.throwIfAborted();
    const toolchain = report.toolchain;
    if (!toolchain) {
      if (discovery?.timedOut) {
        report.state = 'verification-failed'; report.checks.push(timeoutCheck()); return report;
      }
      report.state = 'missing-compiler';
      report.checks.push(check('compiler', 'failed', config.xelatexPath ? 'COMPILER_CONFIG_INVALID' : 'COMPILER_MISSING',
        config.xelatexPath ? '配置的 XeLaTeX 不可用，请检查编译器路径' : '未找到 XeLaTeX，请安装 MiKTeX 或 TeX Live'));
      return report;
    }
    hash.update(JSON.stringify({ executable: toolchain.executable, flavour: toolchain.flavour, version: toolchain.version, identity: toolchain.identity }));
    await addFile('compiler', toolchain.executable);
    report.checks.push(check('compiler', 'passed', 'COMPILER_IDENTIFIED', `已识别 ${toolchain.flavour === 'miktex' ? 'MiKTeX' : 'TeX Live'} XeLaTeX`));
    if (!toolchain.lookup) {
      report.state = 'verification-failed';
      report.checks.push(check('lookup', 'failed', 'TEX_LOOKUP_UNAVAILABLE', '所选发行版缺少同源只读查询工具'));
      return report;
    }
    if (!samePath(dirname(await realpath(toolchain.lookup)), dirname(await realpath(toolchain.executable)))) {
      report.state = 'verification-failed';
      report.checks.push(check('lookup', 'failed', 'TEX_LOOKUP_UNAVAILABLE', '查询工具与所选编译器不属于同一安装'));
      return report;
    }
    for (const file of requiredTexFiles) {
      boundedSignal.throwIfAborted();
      const remaining = deadline - performance.now();
      if (remaining <= 0) { report.checks.push(timeoutCheck()); break; }
      const args = toolchain.flavour === 'miktex'
        ? ['--miktex-disable-installer', '--miktex-disable-maintenance', '--miktex-disable-diagnose', file] : [file];
      const result = await run({ executable: toolchain.lookup, cwd: config.projectRoot, args, env: toolchain.env,
        timeoutMs: remaining, signal: boundedSignal });
      signal?.throwIfAborted();
      if (result.timedOut || controller.signal.aborted) { report.checks.push(timeoutCheck()); break; }
      if (result.aborted) throw new DOMException('环境检测已取消', 'AbortError');
      const output = typeof result.stdout === 'string' ? result.stdout : result.log || '';
      const errorOutput = typeof result.stderr === 'string' ? result.stderr : result.log || '';
      if (/unknown option|unrecogni[sz]ed option|unsupported option|invalid option|未知.*选项/i.test(errorOutput)) {
        report.checks.push(check(file, 'failed', 'TEX_LOOKUP_UNSUPPORTED', '所选查询工具不支持禁用安装和维护的只读参数')); break;
      }
      if (![0, 1].includes(result.exitCode) || (result.exitCode !== 0 && errorOutput.trim()) ||
          (typeof result.stderr === 'string' && /\b(?:error|fatal|failed|cannot|denied)\b/i.test(result.stderr))) {
        report.checks.push(check(file, 'failed', 'TEX_LOOKUP_FAILED', '只读 TeX 依赖查询失败，请检查权限和发行版配置')); break;
      }
      if (!output.trim()) {
        if (errorOutput.trim()) { report.checks.push(check(file, 'failed', 'TEX_LOOKUP_FAILED', '只读 TeX 依赖查询报告错误')); break; }
        report.checks.push(check(file, 'failed', 'TEX_PACKAGE_MISSING', `缺少 TeX 依赖 ${file}`)); continue;
      }
      const paths = output.trim().split(/\r?\n/u).map(line => line.trim());
      if (paths.length !== 1 || !isAbsolute(paths[0]) || basename(paths[0]) !== file || result.exitCode !== 0) {
        report.checks.push(check(file, 'failed', 'TEX_LOOKUP_INVALID_RESULT', `查询 ${file} 未返回匹配的文件路径`)); break;
      }
      try {
        await addFile([file, paths[0]], paths[0]);
        report.checks.push(check(file, 'passed', 'TEX_PACKAGE_PRESENT', `TeX 依赖 ${file} 已找到`));
      } catch (error) {
        if (boundedSignal.aborted) throw error;
        report.checks.push(check(file, 'failed', 'TEX_LOOKUP_INVALID_RESULT', `查询 ${file} 返回的文件无法读取`)); break;
      }
    }
    const failed = report.checks.filter(item => item.status === 'failed');
    report.state = failed.some(item => item.code !== 'TEX_PACKAGE_MISSING') ? 'verification-failed'
      : failed.length ? 'missing-packages' : 'verification-required';
    report.fingerprint = hash.digest('hex');
    return report;
  } catch (error) {
    signal?.throwIfAborted();
    if (controller.signal.aborted) {
      report.state = 'verification-failed'; report.checks.push(timeoutCheck()); return report;
    }
    if (error.name === 'AbortError') throw error;
    report.state = 'verification-failed';
    report.checks.push(check('environment', 'failed', 'ENVIRONMENT_CHECK_FAILED', '环境检测失败，请检查发行版和资源读取权限'));
    return report;
  } finally { clearTimeout(timer); }
}
