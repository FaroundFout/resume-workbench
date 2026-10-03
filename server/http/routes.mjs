import { putAsset, readAsset, inspectImage } from '../assets.mjs';
import { exportBackup, importBackup } from '../backups.mjs';
import { AppError } from '../errors.mjs';
import { readJson, readBody, requireContentType, IMAGE_LIMIT, BACKUP_LIMIT } from './body.mjs';
import { sendJson, sendBytes, sendFile } from './files.mjs';

const invalid = message => new AppError('VALIDATION_ERROR', message, 400);
function id(value) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw invalid('无效的记录 ID');
  return value;
}
// Select controlled diagnostics instead of serializing internal discovery objects.
function publicEnvironment(environment) {
  const available = environment.available === true;
  return { available, message: available ? 'XeLaTeX 可用，可以编译简历。' : '未找到可用的 XeLaTeX，请检查安装及 config.local.json 中的 xelatexPath。简历仍可编辑、保存和备份。' };
}
export async function route(request, response, url, { store, builds, environment }) {
  const method = request.method;
  const path = url.pathname;
  if (method === 'GET' && path === '/api/environment') { sendJson(response, 200, publicEnvironment(environment)); return; }
  if (path === '/api/resumes') {
    if (method === 'GET') {
      sendJson(response, 200, { resumes: (await store.list()).map(doc => ({ id: doc.id, name: doc.name, language: doc.data.language, revision: doc.revision, updatedAt: doc.updatedAt })) }); return;
    }
    if (method === 'POST') {
      const { name, language } = await readJson(request); sendJson(response, 201, await store.create({ name, language })); return;
    }
  }
  if (method === 'POST' && path === '/api/backups/import') {
    requireContentType(request, ['application/json']); sendJson(response, 201, await importBackup(store, await readBody(request, BACKUP_LIMIT))); return;
  }
  const resumeRoute = /^\/api\/resumes\/([^/]+)(?:\/(copy|assets|backup|builds)(?:\/([^/]+))?)?$/.exec(path);
  if (resumeRoute) {
    const resumeId = id(resumeRoute[1]); const action = resumeRoute[2]; const assetId = resumeRoute[3];
    if (!action && method === 'GET') { sendJson(response, 200, { ...await store.read(resumeId), latestBuild: await builds.latestForResume(resumeId) }); return; }
    if (!action && method === 'PUT') { const { expectedRevision, name, data } = await readJson(request); sendJson(response, 200, await store.save(resumeId, { expectedRevision, name, data })); return; }
    if (action === 'copy' && !assetId && method === 'POST') { const { name, language, draft } = await readJson(request); sendJson(response, 201, await store.copy(resumeId, { name, language, draft })); return; }
    if (action === 'assets' && !assetId && method === 'POST') {
      const mime = requireContentType(request, ['image/png', 'image/jpeg']); const bytes = await readBody(request, IMAGE_LIMIT);
      if (inspectImage(bytes).mime !== mime) throw invalid('图片内容与 Content-Type 不匹配');
      sendJson(response, 201, await putAsset(store, resumeId, bytes)); return;
    }
    if (action === 'assets' && assetId && method === 'GET') { const bytes = await readAsset(store, resumeId, id(assetId)); sendBytes(response, bytes, inspectImage(bytes).mime); return; }
    if (action === 'backup' && !assetId && method === 'GET') { sendBytes(response, await exportBackup(store, resumeId), 'application/json; charset=utf-8', `attachment; filename="resume-${resumeId}.json"`); return; }
    if (action === 'builds' && !assetId && method === 'POST') { const { expectedRevision } = await readJson(request); sendJson(response, 202, await builds.submit({ resumeId, expectedRevision })); return; }
  }
  const buildRoute = /^\/api\/builds\/([^/]+)(?:\/(pdf|log))?$/.exec(path);
  if (buildRoute && method === 'GET') {
    const buildId = id(buildRoute[1]);
    if (!buildRoute[2]) { sendJson(response, 200, await builds.read(buildId)); return; }
    if (buildRoute[2] === 'pdf') {
      await sendFile(request, response, await builds.pdfPath(buildId), { mime: 'application/pdf', disposition: `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="resume-${buildId}.pdf"`, range: true }); return;
    }
    await sendFile(request, response, await builds.logPath(buildId), { mime: 'text/plain; charset=utf-8' }); return;
  }
  throw new AppError('NOT_FOUND', '接口不存在', 404);
}
