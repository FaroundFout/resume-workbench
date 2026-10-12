import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from '../errors.mjs';
import { acquireEnvironmentLease } from './lease.mjs';
import { installMissingPackages, updateInstalledPackages, rebuildXeLaTeXFormat } from './providers/miktex.mjs';

const missingFiles = report => [...new Set([
  ...report.checks.filter(check => check.status === 'failed' && check.code === 'TEX_PACKAGE_MISSING').map(check => check.id),
  ...(report.missingTexFiles || []),
])];
// A failed/pending lookup cannot establish absence, even if another lookup
// already found a missing package. Only a complete quick inspection is trusted.
const trustworthyInspection = report => report.editorReady && report.toolchain
  && (missingFiles(report).length ? report.state === 'missing-packages' : ['verification-required', 'ready'].includes(report.state))
  && report.checks.every(check => check.status === 'passed' || (check.status === 'failed' && check.code === 'TEX_PACKAGE_MISSING'));
const addFailure = (report, code, message) => ({ ...report, pdfReady: false,
  state: report.state === 'ready' || report.state === 'verification-required' ? 'verification-failed' : report.state,
  checks: [...report.checks, { id: 'prepare', status: 'failed', code, message }] });

/** Fix known MiKTeX dependencies and require both real template smoke builds.
 * Collaborators are internal deterministic test seams; defaults are production.
 */
export async function preparePdfEnvironment(config, { signal, log = () => {}, inspect, install = installMissingPackages,
  verify, acquireLease = acquireEnvironmentLease, update = false,
  synchronize = updateInstalledPackages, rebuild = rebuildXeLaTeXFormat } = {}) {
  inspect ??= (await import('./check.mjs')).inspectEnvironment;
  const { packageIdsByFlavour } = await import('./manifest.mjs');
  let environment;
  let lease;
  const id = randomUUID();
  let phase = 'check';
  let packageBudget = 600000;
  const task = status => ({ id, phase, status });
  const finish = report => ({ ...report, task: task(report.pdfReady ? 'succeeded' : 'failed') });
  const packages = (report, extra = []) => {
    const missing = [...new Set([...missingFiles(report), ...extra])];
    const mapping = packageIdsByFlavour.miktex;
    if (missing.some(file => !Object.hasOwn(mapping, file))) return null;
    return [...new Set(missing.map(file => mapping[file]))];
  };
  try {
    signal?.throwIfAborted();
    environment = await inspect(config, { signal });
    signal?.throwIfAborted();
    if (!trustworthyInspection(environment)) return finish(environment);
    let selected = environment.toolchain;
    if (update && selected.flavour !== 'miktex') return finish(addFailure(environment, 'TEXLIVE_REPAIR_REQUIRED', '自动版本同步仅支持所选 MiKTeX；请使用所选 TeX Live 的管理工具更新并重建格式，再运行 doctor.cmd。'));
    if (missingFiles(environment).length) {
      if (selected.flavour !== 'miktex') return finish(addFailure(environment, 'TEXLIVE_REPAIR_REQUIRED', '请使用所选 TeX Live 安装的包管理器人工补齐依赖，再运行 doctor.cmd。'));
      if (packages(environment) === null) return finish(addFailure(environment, 'TEX_PACKAGE_UNKNOWN', '模板请求了未列入清单的宏包，请人工检查依赖；未知文件不会自动安装。'));
    }
    phase = 'lease';
    lease = await acquireLease(selected, { mode: 'prepare', signal });
    signal?.throwIfAborted();
    const assertSelected = checked => {
      if (!checked.toolchain || checked.toolchain.executable !== selected.executable || checked.toolchain.flavour !== selected.flavour) throw new AppError('TEX_TOOLCHAIN_CHANGED', '准备期间所选 LaTeX 环境发生变化，请重新检查。', 409);
    };
    async function maintenance(action, nextPhase) {
      phase = nextPhase;
      if (packageBudget <= 0) throw new AppError('TEX_PACKAGE_TIMEOUT', '宏包准备已超过 10 分钟限制，请检查网络后重试。', 408);
      const started = performance.now();
      try { await action(selected, { signal, log, timeoutMs: Math.max(1, Math.floor(packageBudget)) }); }
      finally { packageBudget -= performance.now() - started; }
      signal?.throwIfAborted();
    }
    if (update) {
      await maintenance(synchronize, 'update');
      // An update can change executable identity and package content. Probe the
      // same explicit path again rather than reusing the old --version result.
      environment = await inspect({ ...config, xelatexPath: selected.executable }, { signal, env: selected.env });
      signal?.throwIfAborted();
      if (!trustworthyInspection(environment)) return finish(environment);
      assertSelected(environment);
      selected = environment.toolchain;
    }
    async function repair(report, extra = []) {
      if (!trustworthyInspection(report)) return report;
      assertSelected(report);
      const ids = packages(report, extra);
      if (ids === null) return addFailure(report, 'TEX_PACKAGE_UNKNOWN', '发现未列入清单的宏包，请人工检查模板依赖。');
      if (!ids.length) return report;
      if (selected.flavour !== 'miktex') return addFailure(report, 'TEXLIVE_REPAIR_REQUIRED', '请在所选 TeX Live 安装中人工补齐依赖，再重新验收。');
      phase = 'packages';
      if (packageBudget <= 0) throw new AppError('TEX_PACKAGE_TIMEOUT', '宏包准备已超过 10 分钟限制，请检查网络后重试。', 408);
      const started = performance.now();
      try { await install(selected, ids, { signal, log, timeoutMs: Math.max(1, Math.floor(packageBudget)) }); }
      finally { packageBudget -= performance.now() - started; }
      signal?.throwIfAborted();
      const checked = await inspect(config, { signal, toolchain: selected });
      signal?.throwIfAborted();
      if (!trustworthyInspection(checked)) return checked;
      // The selected compiler remains fixed throughout one repair operation.
      assertSelected(checked);
      return checked;
    }
    if (missingFiles(environment).length) {
      environment = await repair(environment);
      if (!trustworthyInspection(environment) || missingFiles(environment).length) return finish(environment);
    }
    if (update) await maintenance(rebuild, 'format');
    for (let round = 0; ; round++) {
      phase = 'verify';
      verify ??= (await import('./verify.mjs')).verifyPdfEnvironment;
      environment = await verify(config, selected, { signal, log, lease });
      signal?.throwIfAborted();
      if (environment.pdfReady) return finish(environment);
      if (!missingFiles(environment).length) return finish(environment);
      if (round >= 2) return finish(addFailure(environment, 'TEX_REPAIR_LIMIT', '已完成两轮额外依赖修复，请检查编译诊断后人工处理。'));
      // Smoke failures contain LaTeX diagnostics as well as missing filenames.
      // Re-establish the read-only environment facts before using those names
      // as a repair request; never authorize mutation from smoke errors alone.
      const verification = environment;
      phase = 'check';
      const checked = await inspect(config, { signal, toolchain: selected });
      signal?.throwIfAborted();
      if (!trustworthyInspection(checked)) return finish({ ...checked, checks: [...checked.checks, ...verification.checks] });
      environment = await repair(checked, missingFiles(verification));
      if (environment.checks.some(check => ['TEX_PACKAGE_UNKNOWN', 'TEXLIVE_REPAIR_REQUIRED'].includes(check.code))) {
        return finish({ ...environment, checks: [...environment.checks, ...verification.checks],
          missingTexFiles: [...new Set([...missingFiles(environment), ...missingFiles(verification)])] });
      }
      if (!trustworthyInspection(environment) || missingFiles(environment).length) return finish({ ...environment, checks: [...environment.checks, ...verification.checks] });
    }
  } catch (cause) {
    if (!environment) throw cause;
    if (signal?.aborted || cause.name === 'AbortError') return { ...addFailure(environment, 'ENVIRONMENT_CANCELLED', '环境准备已取消，可稍后重新运行。'), task: task('cancelled') };
    if (!(cause instanceof AppError)) throw cause;
    return { ...finish(addFailure(environment, cause.code, cause.message)), ...(cause.diagnostics ? { diagnostics: cause.diagnostics } : {}) };
  } finally { if (lease) await lease.release(); }
}
