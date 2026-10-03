import { AppError } from '../errors.mjs';

const ESCAPES = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$',
  '&': '\\&', '#': '\\#', '%': '\\%', '_': '\\_',
  '^': '\\textasciicircum{}', '~': '\\textasciitilde{}',
};

/** Escape untrusted plain text in one pass, including native hard line breaks. */
export function escapeLatex(text) {
  if (typeof text !== 'string') throw new AppError('INVALID_TEXT', '正文必须为字符串');
  return text.replace(/\r\n?/gu, '\n').replace(/[\\{}$&#%_^~\n]/gu, character =>
    character === '\n' ? '\\newline{}' : ESCAPES[character]);
}

/** Render the shared limited-format contract; never accept raw TeX or HTML. */
export function renderRichText(runs) {
  return runs.map(run => {
    let content = escapeLatex(run.text);
    if (run.bold) content = `\\textbf{${content}}`;
    if (run.url !== null) {
      let url;
      try { url = new URL(run.url); } catch { throw new AppError('INVALID_URL', '链接格式无效'); }
      const http = /^https?:\/\//iu.test(run.url) && ['http:', 'https:'].includes(url.protocol) && url.hostname;
      const mailto = url.protocol === 'mailto:' && url.pathname;
      if ((!http && !mailto) || /[\u0000-\u0020\u007f]/u.test(run.url)) {
        throw new AppError('INVALID_URL', '链接仅支持 http、https 和 mailto');
      }
      content = `\\href{${escapeLatex(run.url)}}{${content}}`;
    }
    return content;
  }).join('');
}
