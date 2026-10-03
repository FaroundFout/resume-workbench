import { open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors.mjs';

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };
const notFound = () => new AppError('NOT_FOUND', '文件不存在', 404);
export function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length });
  response.end(bytes);
}
export function sendBytes(response, bytes, mime, disposition) {
  response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, ...(disposition ? { 'Content-Disposition': disposition } : {}) });
  response.end(bytes);
}
export async function sendFile(request, response, path, { mime, disposition, range = false } = {}) {
  let handle;
  try {
    try { handle = await open(path, 'r'); } catch (cause) { if (cause.code === 'ENOENT') throw notFound(); throw cause; }
    const info = await handle.stat(); if (!info.isFile()) throw notFound();
    let start = 0; let end = info.size - 1; let status = 200;
    const headers = { 'Content-Type': mime ?? 'application/octet-stream', ...(disposition ? { 'Content-Disposition': disposition } : {}) };
    if (range) {
      headers['Accept-Ranges'] = 'bytes';
      if (request.headers.range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        let valid = !!match && (match[1] !== '' || match[2] !== '');
        if (valid && match[1] === '') {
          const suffix = Number(match[2]); valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, info.size - suffix);
        } else if (valid) {
          start = Number(match[1]); end = match[2] === '' ? end : Number(match[2]);
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < info.size;
          end = Math.min(end, info.size - 1);
        }
        if (!valid || info.size === 0) {
          response.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 }); response.end(); return;
        }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      }
    }
    headers['Content-Length'] = info.size === 0 ? 0 : end - start + 1;
    response.writeHead(status, headers);
    if (info.size === 0) { response.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
  } finally { if (handle) await handle.close(); }
}
export async function serveStatic(request, response, projectRoot, pathname) {
  const webRoot = await realpath(join(projectRoot, 'web'));
  const path = join(webRoot, pathname === '/' ? 'index.html' : pathname.slice(1));
  let resolved;
  try { resolved = await realpath(path); } catch (cause) { if (['ENOENT', 'ENOTDIR'].includes(cause.code)) throw notFound(); throw cause; }
  const rel = relative(webRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) throw notFound();
  await sendFile(request, response, resolved, { mime: mimeTypes[extname(resolved)] });
}
