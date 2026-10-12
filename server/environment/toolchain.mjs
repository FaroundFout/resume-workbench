import { stat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { discoverCompiler } from '../compiler/environment.mjs';

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, file) => {
  if (!root) return false;
  const rel = relative(resolve(root), file);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
};
async function sibling(bin, name) {
  try {
    const path = await realpath(join(bin, name));
    return samePath(dirname(path), bin) && (await stat(path)).isFile() ? path : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
}

/** Select once; companions never independently search PATH or another distribution. */
export async function resolveToolchain(config, { signal, env = process.env, onDiscovery, ...options } = {}) {
  signal?.throwIfAborted();
  const result = await discoverCompiler(config, { ...options, env, signal });
  onDiscovery?.(result);
  signal?.throwIfAborted();
  if (!result.available) return null;
  let executable;
  try {
    executable = await realpath(resolve(config.projectRoot || '.', result.executable));
    if (!(await stat(executable)).isFile()) return null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
  const identity = dirname(executable);
  const extension = process.platform === 'win32' ? '.exe' : '';
  const [manager, lookup] = await Promise.all([
    sibling(identity, `${result.flavour === 'miktex' ? 'miktex' : 'tlmgr'}${extension}`),
    sibling(identity, `${result.flavour === 'miktex' ? 'findtexmf' : 'kpsewhich'}${extension}`),
  ]);
  signal?.throwIfAborted();
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const childEnv = { ...env, [pathKey]: `${identity}${delimiter}${env[pathKey] || ''}` };
  const scope = inside(config.projectRoot, executable) ? 'project'
    : [env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE, env.HOME].some(root => inside(root, executable)) ? 'user' : 'shared';
  return { flavour: result.flavour, executable, version: result.version, manager, lookup, scope, identity, env: childEnv };
}
