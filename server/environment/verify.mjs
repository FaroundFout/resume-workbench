import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { prepareBuild as productPrepareBuild } from '../latex/resources.mjs';
import { runXeLaTeX as productRunXeLaTeX } from '../compiler/process.mjs';
import { createEmptyData } from '../../web/shared/model.mjs';
import { validateSmokePdf } from './pdf-smoke.mjs';
import { AppError } from '../errors.mjs';

// Exercise each bundled font face through the actual adapter, including the
// otherwise uncommon Latin bold-italic face. Fixed source contains no user data.
const fontExercise = String.raw`\par
SMOKE\_REGULAR 中文验收
\textbf{SMOKE\_BOLD 中文粗体}
\textit{SMOKE\_ITALIC}
\textit{\textbf{SMOKE\_BOLD\_ITALIC}}
\href{https://example.com/smoke}{SMOKE\_LINK}\par
`;
function smokeData(language) {
  const data = createEmptyData(language);
  data.profile.name = language === 'zh-CN' ? '中文验收示例' : 'Environment Smoke Example';
  data.profile.alternateName = language === 'en' ? '中文备用姓名' : 'Smoke Example';
  data.profile.contacts = [
    { id: 'email', type: 'email', label: '', value: 'smoke@example.com' },
    { id: 'phone', type: 'phone', label: '', value: '123456789' },
    { id: 'wechat', type: 'wechat', label: '', value: 'smoke_example' },
    { id: 'site', type: 'url', label: '', value: 'https://example.com/smoke' },
  ];
  data.sections.skills.items = [{ id: 'smoke-skill', category: language === 'en' ? 'Skills' : '技能', content: [
    { text: 'BODY_MARKER English 中文正文 ', bold: false, url: null },
    { text: '中文粗体 Bold', bold: true, url: 'https://example.com/smoke' },
  ] }];
  return data;
}
const failedCheck = (id, code, message) => ({ id, status: 'failed', code, message });
function missingFiles(log) {
  return [...new Set([...log.matchAll(/(?:LaTeX Error:\s*)?File\s+[`'"]([^`'"\s]+\.(?:sty|cls))[`'"]\s+not found/giu)].map(m => m[1]))];
}
/** Real two-language product smoke build. Collaborators are local test seams. */
export async function verifyPdfEnvironment(config, toolchain, options = {}) {
  const { signal, log = () => {}, lease, temporaryRoot = tmpdir(), timeoutMs = 90000,
    prepareBuild = productPrepareBuild, runXeLaTeX = productRunXeLaTeX } = options;
  let ownLease = null, directory = null;
  let report = { editorReady: true, pdfReady: false, state: 'verification-required', checks: [],
    toolchain, fingerprint: null, verifiedAt: null, task: { id: randomUUID(), phase: 'verify', status: 'running' } };
  const finish = status => {
    report.pdfReady = status === 'succeeded';
    report.state = report.pdfReady ? 'ready' : report.checks.some(c => c.code === 'PROJECT_RESOURCE_MISSING') ? 'missing-resources'
      : report.checks.some(c => c.code === 'TEX_PACKAGE_MISSING') ? 'missing-packages'
        : toolchain ? 'verification-failed' : 'missing-compiler';
    report.verifiedAt = report.pdfReady ? new Date().toISOString() : null;
    report.task.status = status;
    return report;
  };
  try {
    signal?.throwIfAborted();
    if (!toolchain) { report.checks.push(failedCheck('compiler', 'COMPILER_UNAVAILABLE', '未找到支持的 XeLaTeX。')); return finish('failed'); }
    if (!lease) {
      const acquire = options.acquireLease ?? (await import('./lease.mjs')).acquireEnvironmentLease;
      ownLease = await acquire(toolchain, { mode: 'verify', signal });
    }
    let initial = options.inspection;
    if (!initial) {
      const inspect = options.inspect ?? (await import('./check.mjs')).inspectEnvironment;
      initial = await inspect(config, { signal, toolchain });
    }
    if (initial.toolchain && (initial.toolchain.executable !== toolchain.executable || initial.toolchain.flavour !== toolchain.flavour)) {
      throw new AppError('TEX_TOOLCHAIN_CHANGED', '检查结果与所选 LaTeX 环境不匹配，请重新检查。', 409);
    }
    report = { ...report, checks: [...initial.checks], fingerprint: initial.fingerprint };
    if (report.checks.some(c => c.status === 'failed')) return finish('failed');
    directory = await mkdtemp(join(temporaryRoot, 'purecv-pdf-smoke-'));
    // No store, history registration, user configuration or user data access.
    const dataDir = join(directory, 'data');
    for (const language of ['zh-CN', 'en']) {
      signal?.throwIfAborted();
      const id = `pdf-${language}`;
      report.task.phase = id;
      options.onProgress?.(id);
      log(`开始 ${language} 样例编译验收。\n`);
      const started = performance.now();
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(90000, timeoutMs));
      try {
        const buildDir = join(dataDir, 'builds', language);
        await mkdir(buildDir, { recursive: true });
        const prepared = await prepareBuild({ projectRoot: config.projectRoot, dataDir, buildDir,
          snapshot: { data: smokeData(language), logoImage: null }, signal: controller.signal });
        const texPath = join(prepared.cwd, prepared.entryFile);
        const tex = await readFile(texPath, { encoding: 'utf8', signal: controller.signal });
        if (!tex.includes('\\end{document}')) throw new AppError('INVALID_TEMPLATE', '样例模板缺少文档结束标记。', 500);
        await writeFile(texPath, tex.replace('\\end{document}', `${fontExercise}\\end{document}`), { encoding: 'utf8', signal: controller.signal });
        for (let pass = 0; pass < 2; pass++) {
          controller.signal.throwIfAborted();
          // Auxiliary files are intentionally retained for cross references;
          // a PDF must be freshly generated by every pass.
          const path = join(prepared.cwd, 'resume.pdf');
          await rm(path, { force: true });
          const remaining = Math.min(90000, timeoutMs) - (performance.now() - started);
          const result = await runXeLaTeX({ executable: toolchain.executable, env: toolchain.env,
            cwd: prepared.cwd, entryFile: prepared.entryFile, timeoutMs: remaining, signal: controller.signal });
          log(result.log ?? '');
          if (signal?.aborted) signal.throwIfAborted();
          if (timedOut || result.timedOut) throw new AppError('ENVIRONMENT_TIMEOUT', '样例编译超时，请检查环境后重试。', 500);
          if (result.aborted) throw new AppError('ENVIRONMENT_CANCELLED', '样例编译已取消。', 500);
          const missing = missingFiles(result.log ?? '');
          if (missing.length) {
            report.missingTexFiles = [...new Set([...(report.missingTexFiles ?? []), ...missing])];
            for (const file of missing) report.checks.push(failedCheck(file, 'TEX_PACKAGE_MISSING', `样例缺少 ${file}。`));
          }
          if (result.exitCode !== 0) {
            // A release warning is an additional diagnosis, not proof of the
            // fatal error's cause. Repair a known missing file first; retain
            // the compilation error and never reject a PDF for this alone.
            const format = !missing.length && (result.log ?? '').match(/LaTeX Warning:\s*You have requested release\s+[`'"](?<required>\d{4}[/-]\d{2}[/-]\d{2})[`'"]\s+of LaTeX,\s*but only release\s+[`'"](?<available>\d{4}[/-]\d{2}[/-]\d{2})[`'"]\s+is available/iu);
            if (format) {
              const action = toolchain.flavour === 'miktex'
                ? '请运行 repair.cmd --update 同步已安装宏包并重建 XeLaTeX 格式；也可在 MiKTeX Console 的 Updates 中更新后重建该格式。'
                : '请使用所选 TeX Live 的管理工具更新宏包并重建 XeLaTeX 格式。';
              report.checks.push(failedCheck(`${id}-format`, 'TEX_FORMAT_OUTDATED',
                `日志同时提示宏包要求 LaTeX ${format.groups.required}，当前格式为 ${format.groups.available}。${action}完成后运行 doctor.cmd；具体编译错误仍见日志。`));
            }
            throw new AppError('LATEX_ERROR', '样例编译失败，请查看本地诊断日志。', 500);
          }
          await validateSmokePdf({ path, log: result.log });
        }
        report.checks.push({ id, status: 'passed', code: 'PDF_SMOKE_PASSED', message: `${language} 样例两遍编译通过。` });
      } catch (error) {
        if (signal?.aborted) throw error;
        report.checks.push(failedCheck(id, timedOut ? 'ENVIRONMENT_TIMEOUT' : error.code ?? 'PDF_VERIFICATION_FAILED',
          error instanceof AppError ? error.message : '样例准备或编译失败，请恢复项目资源后重试。'));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    }
    return finish(report.checks.some(c => c.status === 'failed') ? 'failed' : 'succeeded');
  } catch (error) {
    const cancelled = signal?.aborted || error.name === 'AbortError';
    report.checks.push(failedCheck('verify', cancelled ? 'ENVIRONMENT_CANCELLED' : error.code ?? 'PDF_VERIFICATION_FAILED',
      cancelled ? '环境验收已取消。' : error instanceof AppError ? error.message : '环境验收失败，请查看本地诊断日志。'));
    return finish(cancelled ? 'cancelled' : 'failed');
  } finally {
    // All awaited preparers and process runners settle before reaching cleanup.
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { await ownLease?.release(); }
  }
}
