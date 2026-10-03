import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../../server/storage.mjs';
import { createBuildManager } from '../../server/compiler/builds.mjs';

export async function finish(manager, id) {
  for (let i = 0; i < 1000; i++) {
    const record = await manager.read(id);
    if (record.status !== 'running') return record;
    await delay(5);
  }
  throw new Error('Build never finished');
}
export async function createBuildFixture(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'PureCV 构建 '));
  const store = await createStore({ dataDir });
  const doc = await store.create({ name: '示例', language: 'en' });
  let outcome = 'succeeded';
  let pdfText = '%PDF-first';
  const config = { projectRoot: dataDir, dataDir, compileTimeoutMs: 90000, xelatexPath: null };
  Object.assign(config, options.config);
  const run = async ({ cwd }) => {
    if (outcome === 'succeeded') await writeFile(join(cwd, 'resume.pdf'), pdfText);
    if (outcome === 'invalid_pdf') await writeFile(join(cwd, 'resume.pdf'), 'invalid');
    return { exitCode: outcome === 'failed' ? 1 : 0, timedOut: false, aborted: false, log: 'Output written on resume.pdf (1 page).\nLaTeX Warning: test warning' };
  };
  const prepareBuild = async ({ buildDir, snapshot }) => {
    await writeFile(join(buildDir, 'resume.tex'), snapshot.data.profile.name || 'first');
    return { cwd: buildDir, entryFile: 'resume.tex' };
  };
  const manager = createBuildManager({ store, prepareBuild, run, detect: async () => ({ available: true, executable: 'controlled-compiler', message: 'ready' }), ...options, config });
  return { dataDir, store, doc, config, manager,
    async submitAndFinish({ outcome: selected = 'succeeded', text = '%PDF-first' } = {}) {
      outcome = selected;
      pdfText = text;
      const record = await manager.submit({ resumeId: doc.id, expectedRevision: (await store.read(doc.id)).revision });
      return finish(manager, record.id);
    },
    latestSuccessfulId: async () => (await manager.latestForResume(doc.id))?.id,
    readPdf: async id => readFile(await manager.pdfPath(id), 'utf8'),
    close: async () => { await manager.shutdown(); await rm(dataDir, { recursive: true, force: true }); },
  };
}
