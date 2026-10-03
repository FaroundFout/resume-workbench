import { AppError } from '../errors.mjs';

export const JSON_LIMIT = 2 * 1024 * 1024;
export const IMAGE_LIMIT = 5 * 1024 * 1024;
export const BACKUP_LIMIT = 10 * 1024 * 1024;
export function requireContentType(request, allowed) {
  const mime = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!allowed.includes(mime)) throw new AppError('CONTENT_TYPE_INVALID', '请求内容类型不受支持', 400);
  return mime;
}
export function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let exceeded = Number(request.headers['content-length']) > limit;
    const chunks = [];
    const tooLarge = () => reject(new AppError('BODY_TOO_LARGE', '请求内容超过允许大小', 413));
    if (exceeded) tooLarge();
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        if (!exceeded) { exceeded = true; chunks.length = 0; tooLarge(); }
      } else if (!exceeded) chunks.push(chunk);
    });
    request.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    request.on('error', () => reject(new AppError('BODY_INVALID', '无法读取请求内容', 400)));
    request.on('aborted', () => reject(new AppError('BODY_INVALID', '请求内容传输中断', 400)));
  });
}
export async function readJson(request) {
  requireContentType(request, ['application/json']);
  const bytes = await readBody(request, JSON_LIMIT);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw new AppError('JSON_INVALID', '请求须为有效的 JSON 对象', 400); }
}
