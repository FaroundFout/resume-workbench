import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AppError } from './errors.mjs';

const invalid = () => new AppError('CONFIG_INVALID', '本地配置无效，请检查数据目录、端口、编译器路径和超时设置', 500);
/** Paths are local administrator configuration, never request parameters. */
export async function loadConfig(projectRoot) {
  projectRoot = resolve(projectRoot);
  let local = {};
  try { local = JSON.parse(await readFile(join(projectRoot, 'config.local.json'), 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw invalid();
    if (error.code !== 'ENOENT') throw error;
  }
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw invalid();
  const { dataDir = '.purecv', port = 3000, xelatexPath = null, compileTimeoutMs = 90000 } = local;
  if (typeof dataDir !== 'string' || !dataDir.trim() ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !(xelatexPath === null || (typeof xelatexPath === 'string' && xelatexPath.trim())) ||
      !Number.isSafeInteger(compileTimeoutMs) || compileTimeoutMs < 1 || compileTimeoutMs > 2147483647) throw invalid();
  return { projectRoot, dataDir: resolve(projectRoot, dataDir), port,
    xelatexPath: xelatexPath === null ? null : resolve(projectRoot, xelatexPath), compileTimeoutMs };
}
