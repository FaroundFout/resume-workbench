import http from 'node:http';
import { AppError } from './errors.mjs';
import { route } from './http/routes.mjs';
import { sendJson, serveStatic } from './http/files.mjs';

export function createApp({ config, store, builds, environment }) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'");
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(request.headers.host)) throw new AppError('HOST_FORBIDDEN', '只允许本机服务地址', 403);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !allowedHosts.map(host => `http://${host}`).includes(request.headers.origin)) {
        throw new AppError('ORIGIN_FORBIDDEN', '写操作必须来自本机同源页面', 403);
      }
      let pathname;
      try { pathname = decodeURIComponent(request.url.split('?')[0]); } catch { throw new AppError('PATH_INVALID', '无效的请求路径', 400); }
      if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(pathname) || pathname.split('/').some(part => part === '..' || part === '.')) throw new AppError('PATH_INVALID', '无效的请求路径', 400);
      const url = new URL(request.url, `http://${request.headers.host}`); url.pathname = pathname;
      if (pathname.startsWith('/api/')) await route(request, response, url, { store, builds, environment });
      else if (request.method === 'GET') await serveStatic(request, response, config.projectRoot, pathname);
      else throw new AppError('NOT_FOUND', '页面不存在', 404);
    } catch (cause) {
      if (response.headersSent) { response.destroy(); return; }
      const error = cause instanceof AppError ? cause : new AppError('INTERNAL_ERROR', '本地服务发生错误，请检查数据目录或重启服务', 500);
      sendJson(response, error.status, { error: { code: error.code, message: error.message, ...(error.fields === undefined ? {} : { fields: error.fields }) } });
      request.resume();
    }
  });
  return server;
}
