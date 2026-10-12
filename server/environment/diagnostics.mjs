const states = new Set(['checking', 'verification-required', 'missing-compiler', 'missing-packages', 'missing-resources', 'verification-failed', 'ready']);
const statuses = new Set(['passed', 'failed', 'pending']);
const taskStatuses = new Set(['running', 'succeeded', 'failed', 'cancelled']);

/** Logs may contain spaces in paths; conservatively redact their remainder of a line. */
export function redactEnvironmentLog(log) {
  return String(log ?? '').replace(/(?:[A-Za-z]:[\\/]|\\\\[^\r\n]+|(?<![\w.])\/(?:[^\s/]+\/)+)[^\r\n]*/gu, '[本地路径已隐藏]');
}
const publicText = value => redactEnvironmentLog(typeof value === 'string' ? value : '').slice(0, 2000);
export function environmentMessage(report) {
  if (report.pdfReady === true && report.state === 'ready') return 'PDF 已就绪，中文、英文样例验收通过。';
  const messages = {
    'missing-compiler': '未找到可用的 XeLaTeX，请安装 MiKTeX/TeX Live 或检查 config.local.json 中的 xelatexPath。',
    'missing-resources': '项目字体、模板或图片缺失，请恢复完整项目文件后运行 doctor.cmd。',
    'missing-packages': 'PDF 宏包不完整，请运行 repair.cmd 补齐依赖。',
    'verification-required': 'PDF 环境待验收，请运行 doctor.cmd。',
    'verification-failed': 'PDF 环境验收失败，请运行 doctor.cmd 查看诊断，按提示运行 repair.cmd。',
    checking: '正在检测 PDF 环境。',
  };
  return `${messages[report.state] || messages['verification-failed']} 完成后重新启动服务。简历仍可编辑、保存和备份。`;
}
export function toPublicEnvironment(report) {
  const state = states.has(report?.state) ? report.state : 'verification-failed';
  return {
    available: !!report?.toolchain?.executable,
    editorReady: report?.editorReady === true,
    pdfReady: state === 'ready' && report?.pdfReady === true,
    state,
    checks: Array.isArray(report?.checks) ? report.checks.map(check => ({ id: publicText(check.id),
      status: statuses.has(check.status) ? check.status : 'failed', code: publicText(check.code), message: publicText(check.message) })) : [],
    task: report?.task ? { id: publicText(report.task.id), phase: publicText(report.task.phase),
      status: taskStatuses.has(report.task.status) ? report.task.status : 'failed' } : null,
  };
}
