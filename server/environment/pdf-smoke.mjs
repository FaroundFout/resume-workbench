import { lstat, readFile } from 'node:fs/promises';
import { AppError } from '../errors.mjs';

const fail = (code, message) => new AppError(code, message, 500);
/** Light installation check only; this does not parse the complete PDF structure. */
export async function validateSmokePdf({ path, log = '' }) {
  if (/Missing character:/iu.test(log)) throw fail('FONT_MISSING_GLYPH', '样例包含无法显示的字符，请检查项目字体。');
  if (/not loadable|fontspec[^\n]*Error|font[^\n]*(?:cannot be found|could not be loaded)/iu.test(log)) {
    throw fail('FONT_LOAD_FAILED', '样例字体无法加载，请恢复项目字体后重新验收。');
  }
  if (/Fatal error|^\s*!|(?:LaTeX|Package\s+\S+)\s+Error:|Undefined control sequence|^.*\.tex:\d+:\s*(?!Warning)[^\n]+/imu.test(log)) {
    throw fail('LATEX_ERROR', '样例编译出现 LaTeX 错误，请查看本地诊断日志。');
  }
  let stat, bytes;
  try { stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('not regular'); bytes = await readFile(path); }
  catch { throw fail('PDF_INVALID', '样例没有生成普通 PDF 文件。'); }
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw fail('PDF_INVALID', '样例 PDF 文件头无效。');
  let end = bytes.length;
  while (end && [9, 10, 12, 13, 32].includes(bytes[end - 1])) end--;
  if (end < 5 || !bytes.subarray(end - 5, end).equals(Buffer.from('%%EOF'))) throw fail('PDF_INVALID', '样例 PDF 文件尾缺失或不完整。');
  const outputs = [...String(log).matchAll(/Output written on\s+([^\r\n]+?)\s*\((\d+)\s+pages?\b[^)]*\)/giu)];
  const final = outputs.at(-1);
  const name = final?.[1].trim().replace(/^"|"$/gu, '').replace(/\\/gu, '/');
  const pages = Number(final?.[2]);
  if (!final || !/(?:^|\/)resume\.pdf$/u.test(name) || !Number.isSafeInteger(pages) || pages < 1) {
    throw fail('PDF_INVALID', '编译日志没有报告 resume.pdf 的有效页数。');
  }
  return { pages };
}
