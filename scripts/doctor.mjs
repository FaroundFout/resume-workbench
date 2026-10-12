import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { saveEnvironmentRecord, clearEnvironmentRecord, applyEnvironmentRecord } from '../server/environment/record.mjs';

const modes = new Set(['--check', '--verify', '--prepare', '--editor-only']);
export async function runDoctor({ projectRoot, args = [], signal, writeLine = console.log,
  inspect, prepare, verify } = {}) {
  let mode = '--prepare';
  let fullCheckStarted = false;
  try {
    const selectedModes = args.filter(arg => modes.has(arg));
    const update = args.includes('--update');
    if (selectedModes.length > 1 || new Set(args).size !== args.length || args.some(arg => !modes.has(arg) && arg !== '--update')
      || (update && selectedModes[0] !== '--prepare')) throw Error('参数或模式无效：使用 --check、--verify、--prepare 或 --editor-only 中的一种；--update 只能与 --prepare 一起使用。');
    mode = selectedModes[0] ?? mode;
    signal?.throwIfAborted();
    const config = await loadConfig(projectRoot);
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22 or newer is required.');
    writeLine('Node and editor are ready.');
    if (mode === '--editor-only') {
      writeLine('编辑环境已就绪；PDF 环境未准备 (--editor-only)。Run start.cmd to open the editor.');
      return { exitCode: 0, report: null };
    }
    const { redactEnvironmentLog } = await import('../server/environment/diagnostics.mjs');
    const log = line => writeLine(redactEnvironmentLog(String(line)));
    let report;
    fullCheckStarted = mode !== '--check';
    if (mode === '--prepare') {
      if (update) writeLine('将同步所选 MiKTeX 的已安装宏包并重建 XeLaTeX 格式，随后重新验收中英文 PDF。');
      const prepareEnvironment = prepare ?? (await import('../server/environment/prepare.mjs')).preparePdfEnvironment;
      report = await prepareEnvironment(config, { signal, log, update });
    } else {
      const inspectEnvironment = inspect ?? (await import('../server/environment/check.mjs')).inspectEnvironment;
      report = await inspectEnvironment(config, { signal });
      if (mode === '--verify' && report.state === 'verification-required') {
        const verifyEnvironment = verify ?? (await import('../server/environment/verify.mjs')).verifyPdfEnvironment;
        report = await verifyEnvironment(config, report.toolchain, { signal, log, inspection: report });
      } else if (mode === '--check') report = await applyEnvironmentRecord(projectRoot, report);
    }
    signal?.throwIfAborted();
    for (const check of report.checks) if (check.status === 'failed') log(`[${check.code}] ${check.message}`);
    if (report.state === 'ready' && report.pdfReady === true) {
      if (mode !== '--check') await saveEnvironmentRecord(projectRoot, report);
      writeLine('Setup complete: editor and PDF are ready. 中文、英文样例编译通过。Run start.cmd to open the editor.');
      return { exitCode: 0, report };
    }
    if (mode !== '--check') await clearEnvironmentRecord(projectRoot);
    writeLine(`PDF 环境尚未通过验收 (${report.state})。简历仍可编辑、保存和备份。`);
    if (report.state === 'missing-compiler') writeLine('MiKTeX: https://miktex.org/download — 安装后重新运行 setup.cmd。');
    else if (report.state === 'verification-required') writeLine('运行 doctor.cmd 验证，或运行 repair.cmd 补齐依赖并验证。');
    else writeLine('核对以上诊断后运行 repair.cmd 重试；可用 setup.cmd --editor-only 仅准备编辑环境。');
    writeLine('Environment guide: docs/local-editor.md');
    return { exitCode: 1, report };
  } catch (error) {
    if (fullCheckStarted) {
      try { await clearEnvironmentRecord(projectRoot); }
      catch { writeLine('旧验收记录无法清理，请检查 .runtime 目录权限后重试。'); }
    }
    const code = error.name === 'AbortError' || signal?.aborted ? 'ENVIRONMENT_CANCELLED' : error.code || 'ENVIRONMENT_FAILED';
    let message = error.message;
    try { message = (await import('../server/environment/diagnostics.mjs')).redactEnvironmentLog(message); } catch {}
    writeLine(`Environment check failed (${code}): ${message}`);
    writeLine('Environment guide: docs/local-editor.md');
    return { exitCode: 1, report: null };
  }
}

export async function doctorMain(args = process.argv.slice(2)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40 * 60 * 1000)]);
  try {
    const result = await runDoctor({ projectRoot: fileURLToPath(new URL('../', import.meta.url)), args, signal });
    process.exitCode = result.exitCode;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await doctorMain();
