import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { validateResumeData } from '../../web/shared/model.mjs';
import { AppError } from '../errors.mjs';
import { renderResume } from './render.mjs';

const FONTS = ['Lato/Lato-Regular.ttf', 'Lato/Lato-Bold.ttf', 'Lato/Lato-Italic.ttf', 'Lato/Lato-BoldItalic.ttf', 'Simsun/SourceHanSerifCN-Regular.ttf', 'Simsun/SourceHanSerifCN-Bold.ttf'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function cachedFonts(projectRoot, cacheDir, signal) {
  for (const name of FONTS) {
    signal?.throwIfAborted();
    const source = await readFile(join(projectRoot, 'font', name), { signal });
    const target = join(cacheDir, name);
    let cached;
    try { cached = await readFile(target, { signal }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    signal?.throwIfAborted();
    if (!cached || digest(cached) !== digest(source)) {
      await mkdir(dirname(target), { recursive: true });
      signal?.throwIfAborted();
      await writeFile(target, source, { signal });
    }
  }
}

/**
 * Caller supplies controlled paths and a saved snapshot. Internal custom
 * preparers must honor signal and settle all their writes before rejecting;
 * the manager deliberately drains preparation before publication/cleanup.
 */
export async function prepareBuild({ projectRoot, dataDir, buildDir, snapshot, signal }) {
  signal?.throwIfAborted();
  const { data } = snapshot;
  const checked = validateResumeData(data);
  if (!checked.ok) throw new AppError('INVALID_DATA', '简历数据无效', 400, { issues: checked.issues });
  let logoFile = null;
  let logoBytes = null;
  if (data.logo.mode === 'custom') {
    const image = snapshot.logoImage;
    if (!image || !Buffer.isBuffer(image.bytes) || !image.bytes.length || !['image/png', 'image/jpeg'].includes(image.mime)) {
      throw new AppError('INVALID_IMAGE', '自定义校徽快照不可用');
    }
    logoFile = image.mime === 'image/png' ? 'resources/logo.png' : 'resources/logo.jpg';
    logoBytes = image.bytes;
  } else if (data.logo.mode === 'default') {
    logoFile = 'resources/logo.png';
    logoBytes = await readFile(join(projectRoot, data.language === 'zh-CN' ? 'resume_zh' : 'resume', 'uestc.png'), { signal });
  }
  const cacheDir = resolve(dataDir, 'resources/font');
  const cwd = resolve(buildDir);
  const fontDir = `${relative(cwd, cacheDir).replace(/\\/gu, '/')}/`;
  const folder = data.language === 'zh-CN' ? 'purecv-zh' : 'purecv-en';
  const main = await readFile(join(projectRoot, 'templates', folder, 'main.tex'), { encoding: 'utf8', signal });
  const macros = await readFile(join(projectRoot, 'templates/shared/macros.tex'), { encoding: 'utf8', signal });
  signal?.throwIfAborted();
  const rendered = renderResume(data, { fontDir, logoFile }, { main, macros });
  await cachedFonts(projectRoot, cacheDir, signal);
  signal?.throwIfAborted();
  await mkdir(join(cwd, 'resources'), { recursive: true });
  signal?.throwIfAborted();
  if (logoFile) await writeFile(join(cwd, logoFile), logoBytes, { signal });
  signal?.throwIfAborted();
  await writeFile(join(cwd, 'macros.tex'), rendered.macrosTex, { encoding: 'utf8', signal });
  signal?.throwIfAborted();
  await writeFile(join(cwd, 'resume.tex'), rendered.mainTex, { encoding: 'utf8', signal });
  signal?.throwIfAborted();
  return { cwd, entryFile: 'resume.tex' };
}
