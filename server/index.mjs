import { open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { createStore } from './storage.mjs';
import { inspectEnvironment } from './environment/check.mjs';
import { applyEnvironmentRecord } from './environment/record.mjs';
import { environmentMessage } from './environment/diagnostics.mjs';
import { createBuildManager } from './compiler/builds.mjs';
import { createApp } from './app.mjs';
import { AppError } from './errors.mjs';
import { acquireDataDirectory } from './ownership.mjs';

async function initializeLibrary(config, store) {
  const marker = join(config.dataDir, '.library-initialized');
  try { await readFile(marker); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if ((await store.list()).length === 0) {
    const examples = await Promise.all([
      ['zh-CN', 'resume.zh.json', '中文虚构示例'], ['en', 'resume.en.json', 'English fictional example'],
    ].map(async ([language, file, name]) => ({ name, language,
      seed: JSON.parse(await readFile(join(config.projectRoot, 'examples', file), 'utf8')) })));
    const created = [];
    try {
      for (const example of examples) created.push((await store.create(example)).id);
    } catch (cause) {
      // Only UUIDs returned by successful creations in this empty library are ours.
      await Promise.allSettled(created.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        .map(id => rm(join(config.dataDir, 'resumes', id), { recursive: true, force: true })));
      throw cause;
    }
  }
  const temporary = `${marker}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile('1\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, marker);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

function openUrl(url) {
  return new Promise((resolveOpen, reject) => {
    const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
    execFile(command, args, { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolveOpen());
  });
}
export async function startServer(projectRoot, { openBrowser = true } = {}) {
  const config = await loadConfig(projectRoot);
  const owner = await acquireDataDirectory(config.dataDir);
  config.dataDir = owner.dataDir;
  let builds;
  let server;
  let environment;
  try {
    const store = await createStore(config);
    await initializeLibrary(config, store);
    environment = await applyEnvironmentRecord(projectRoot, await inspectEnvironment(config));
    builds = createBuildManager({ config, store });
    await builds.recover();
    server = createApp({ config, store, builds, environment });
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolveListen); });
  } catch (cause) {
    try { await builds?.shutdown(); } finally { await owner.release(); }
    if (cause.code === 'EADDRINUSE') throw new AppError('PORT_IN_USE', '端口已被占用，请在 config.local.json 修改 port 后重新启动', 500);
    throw cause;
  }
  let closing;
  server.shutdown = () => closing ??= (async () => {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { await builds.shutdown(); }
    finally {
      try { await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }
      finally { await owner.release(); }
    }
  })();
  const stop = () => { server.shutdown().catch(() => { console.error('服务关闭时发生错误，请重新启动后检查构建状态。'); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const url = `http://127.0.0.1:${config.port}`;
  console.log(`Resume Workbench: ${url}`);
  console.log(environmentMessage(environment));
  console.log('使用与环境说明：docs/local-editor.md；网页侧栏可打开“环境与使用帮助”。');
  if (openBrowser) {
    try { await openUrl(url); } catch { console.error(`无法自动打开浏览器，请手动访问 ${url}`); }
  }
  return { server, url };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(fileURLToPath(new URL('../', import.meta.url)), { openBrowser: !process.argv.includes('--no-open') }).catch(cause => {
    console.error(cause instanceof AppError ? cause.message : '无法启动本地服务，请检查本地配置与数据目录权限。'); process.exitCode = 1;
  });
}
