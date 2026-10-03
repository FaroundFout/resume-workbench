import { resolve, dirname, join, win32 } from 'node:path';
import { existsSync } from 'node:fs';
export function resolveQaTools({ env = process.env, platform = process.platform, execPath = process.execPath, exists = existsSync } = {}) {
  const paths = platform === 'win32' ? win32 : { resolve, dirname, join };
  const bundle = paths.resolve(paths.dirname(execPath), '../..');
  const candidate = (override, relative, fallback) => {
    if (override) return override;
    const path = paths.join(bundle, relative);
    return platform === 'win32' && exists(path) ? path : fallback;
  };
  return { python: candidate(env.PURECV_PYTHON, 'python/python.exe', platform === 'win32' ? 'python' : 'python3'),
    pdftoppm: candidate(env.PURECV_PDFTOPPM, 'native/poppler/Library/bin/pdftoppm.exe', 'pdftoppm') };
}
