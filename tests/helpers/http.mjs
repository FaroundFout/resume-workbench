import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../server/storage.mjs';
import { createBuildManager } from '../../server/compiler/builds.mjs';
import { createApp } from '../../server/app.mjs';

export async function createHttpFixture({ available = true, environment, prepareGate } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'purecv-http-'));
  const config = { projectRoot: fileURLToPath(new URL('../../', import.meta.url)), dataDir, port: 0, compileTimeoutMs: 5000 };
  const store = await createStore(config);
  const builds = createBuildManager({ config, store,
    detect: async () => ({ available, executable: 'controlled-compiler', message: '缺少编译器，仍可保存。' }),
    prepareBuild: async ({ buildDir, snapshot }) => {
      if (prepareGate) await prepareGate;
      await writeFile(join(buildDir, 'resume.pdf'), `%PDF-1.7\nrevision=${snapshot.revision}\n%%EOF`);
      return { cwd: buildDir, entryFile: 'resume.tex' };
    },
    run: async () => ({ exitCode: 0, log: 'Output written on resume.pdf (1 page).', aborted: false, timedOut: false }),
  });
  const server = createApp({ config, store, builds, environment: environment ?? { available, message: '编译器诊断', executable: 'C:/private/compiler.exe' } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, server, store, builds,
    request: (path, { method = 'GET', body, headers = {} } = {}) => fetch(url + path, { method,
      headers: { ...(method === 'GET' ? {} : { Origin: url, 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) }) }),
    close: async () => { await builds.shutdown(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); },
  };
}
