import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateSmokePdf } from '../server/environment/pdf-smoke.mjs';
import { verifyPdfEnvironment } from '../server/environment/verify.mjs';
import { runProcess } from '../server/compiler/process.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pdf = Buffer.from('%PDF-1.5\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const output = 'Output written on resume.pdf (1 page, 400 bytes).';
const toolchain = { flavour: 'miktex', executable: process.execPath, version: 'fixture', manager: null, lookup: null, scope: 'user', env: { FIXTURE: 'yes' } };
const inspected = { editorReady: true, pdfReady: false, state: 'verification-required', checks: [], toolchain, fingerprint: 'resource-fingerprint', verifiedAt: null, task: null };
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'purecv-verify-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
for (const [name, bytes, log, code] of [
  ['wrong PDF header', Buffer.from('x%PDF-1.5\n%%EOF'), output, 'PDF_INVALID'],
  ['binary bytes imitating ASCII header', Buffer.from([0xa5,0x50,0x44,0x46,0x2d,10,37,37,69,79,70]), output, 'PDF_INVALID'],
  ['truncated PDF trailer', Buffer.from('%PDF-1.5\n%%EO'), output, 'PDF_INVALID'],
  ['PDF trailer followed by garbage', Buffer.from('%PDF-1.5\n%%EOF\nBAD'), output, 'PDF_INVALID'],
  ['zero pages', pdf, 'Output written on resume.pdf (0 pages, 400 bytes).', 'PDF_INVALID'],
  ['no output statement', pdf, 'Compilation finished', 'PDF_INVALID'],
  ['another PDF output name', pdf, 'Output written on other.pdf (1 page, 400 bytes).', 'PDF_INVALID'],
  ['final zero output after earlier success', pdf, `${output}\nOutput written on resume.pdf (0 pages, 0 bytes).`, 'PDF_INVALID'],
  ['missing glyph', pdf, `${output}\nMissing character: There is no 中 in font Lato!`, 'FONT_MISSING_GLYPH'],
  ['font load failure', pdf, `${output}\nFont TU/Lato/m/n/10 not loadable: Metric file not found.`, 'FONT_LOAD_FAILED'],
  ['fontspec failure', pdf, `${output}\nPackage fontspec Error: The font "Lato" cannot be found.`, 'FONT_LOAD_FAILED'],
  ['LaTeX error despite zero exit', pdf, `${output}\n./resume.tex:2: Undefined control sequence.`, 'LATEX_ERROR'],
  ['fatal compile error', pdf, `${output}\nFatal error occurred, no output PDF file produced!`, 'LATEX_ERROR'],
]) test(`smoke validation rejects ${name}`, async t => {
  const path = join(await workspace(t), 'resume.pdf'); await writeFile(path, bytes);
  await assert.rejects(validateSmokePdf({ path, log }), error => error.code === code);
});
test('smoke validation accepts regular binary PDF and trailing whitespace', async t => {
  const path = join(await workspace(t), 'resume.pdf'); await writeFile(path, Buffer.concat([pdf, Buffer.from('\t \r\n')]));
  assert.deepEqual(await validateSmokePdf({ path, log: output }), { pages: 1 });
});
test('smoke validation rejects absent file and directory', async t => {
  const dir = await workspace(t);
  for (const path of [join(dir, 'absent.pdf'), dir]) await assert.rejects(validateSmokePdf({ path, log: output }), e => e.code === 'PDF_INVALID');
});
test('smoke validation rejects a directory symbolic link', async t => {
  const dir = await workspace(t), link = join(dir, 'resume.pdf');
  await symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateSmokePdf({ path: link, log: output }), e => e.code === 'PDF_INVALID');
});
async function verify(t, options = {}) {
  const temporaryRoot = await workspace(t), dataDir = join(temporaryRoot, 'real-data');
  await mkdir(dataDir); await writeFile(join(dataDir, 'protected'), 'existing private document');
  const report = await verifyPdfEnvironment({ projectRoot: root, dataDir }, toolchain, {
    temporaryRoot, inspect: async () => inspected, acquireLease: async () => ({ release() {} }),
    runXeLaTeX: async ({ cwd }) => { await writeFile(join(cwd, 'resume.pdf'), pdf); return { exitCode: 0, log: output }; }, ...options,
  });
  assert.equal(await readFile(join(dataDir, 'protected'), 'utf8'), 'existing private document');
  assert.deepEqual(await readdir(temporaryRoot), ['real-data'], 'private smoke directory is always removed');
  return report;
}
test('both languages use actual product build default logos and all bundled fonts in isolated directories', async t => {
  const langs = [], budgets = [], paths = [];
  const result = await verify(t, { runXeLaTeX: async ({ cwd, entryFile, timeoutMs, env }) => {
    const tex = await readFile(join(cwd, entryFile), 'utf8');
    langs.push(tex.includes('pdflang=zh-CN') ? 'zh-CN' : 'en'); budgets.push(timeoutMs); paths.push(cwd);
    assert.ok(tex.includes('SourceHanSerifCN-Bold') && tex.includes('Lato-BoldItalic'));
    assert.ok(tex.includes(String.raw`\textit{\textbf{SMOKE\_BOLD\_ITALIC}}`));
    assert.ok((await lstat(join(cwd, 'resources/logo.png'))).isFile());
    assert.equal(env.FIXTURE, 'yes');
    await writeFile(join(cwd, 'resume.pdf'), pdf); return { exitCode: 0, log: output };
  } });
  assert.equal(result.pdfReady, true); assert.equal(result.state, 'ready'); assert.equal(result.fingerprint, 'resource-fingerprint');
  assert.deepEqual(langs, ['zh-CN','zh-CN','en','en']);
  assert.ok(budgets[1] <= budgets[0] && budgets[3] <= budgets[2]);
  assert.equal(new Set(paths).size, 2); assert.ok(result.verifiedAt); assert.equal(result.task.status, 'succeeded');
});
test('a failed first language still evaluates the second language and cannot report ready', async t => {
  const calls = []; const report = await verify(t, { runXeLaTeX: async ({ cwd }) => {
    const tex = await readFile(join(cwd, 'resume.tex'), 'utf8'); const zh = tex.includes('pdflang=zh-CN'); calls.push(zh ? 'zh' : 'en');
    if (zh) return { exitCode: 1, log: "! LaTeX Error: File `geometry.sty' not found." };
    await writeFile(join(cwd,'resume.pdf'),pdf); return { exitCode:0,log:output };
  } });
  assert.equal(report.pdfReady,false); assert.deepEqual(calls,['zh','en','en']);
  assert.deepEqual(report.missingTexFiles,['geometry.sty']);
  assert.ok(report.checks.some(c=>c.id==='geometry.sty'&&c.code==='TEX_PACKAGE_MISSING'));
});
test('a stale first-pass PDF cannot make an empty second pass succeed', async t => {
  let count=0; const result=await verify(t,{runXeLaTeX:async({cwd})=>{
    if(++count%2===1)await writeFile(join(cwd,'resume.pdf'),pdf);
    return {exitCode:0,log:output};
  }});
  assert.equal(result.pdfReady,false); assert.equal(count,4);
});
test('missing project fonts are detected before any compiler starts', async t => {
  let calls=0;const result=await verify(t,{inspect:async()=>({...inspected,state:'repair-required',checks:[{id:'Lato-Regular.ttf',status:'failed',code:'PROJECT_RESOURCE_MISSING',message:'missing'}]}),runXeLaTeX:async()=>{calls++;}});
  assert.equal(result.pdfReady,false);assert.equal(calls,0);
});
test('owned lease is released after failure and a supplied nested lease remains owned by caller', async t => {
  let releases=0,acquisitions=0;const lease={release(){releases++;}};
  await verify(t,{acquireLease:async()=>{acquisitions++;return lease;}});
  assert.equal(acquisitions,1);assert.equal(releases,1);
  await verify(t,{lease,acquireLease:async()=>{throw Error('must not reacquire');}});
  assert.equal(releases,1);
});
test('a supplied inspection preserves its fingerprint and avoids rediscovery of the selected installation', async t => {
  const report=await verify(t,{inspection:inspected,inspect:async()=>{throw Error('must not reinspect');}});
  assert.equal(report.pdfReady,true);assert.equal(report.fingerprint,'resource-fingerprint');
});
test('an inspection for another compiler cannot grant readiness to the selected installation', async t => {
  let calls=0;const report=await verify(t,{inspection:{...inspected,toolchain:{...toolchain,executable:'foreign.exe'}},runXeLaTeX:async()=>{calls++;}});
  assert.equal(report.pdfReady,false);assert.equal(calls,0);
  assert.ok(report.checks.some(c=>c.code==='TEX_TOOLCHAIN_CHANGED'));
});
test('already-cancelled verification does not acquire a lease or compile', async t => {
  const controller=new AbortController();controller.abort();
  const result=await verify(t,{signal:controller.signal,acquireLease:async()=>{throw Error('must not acquire');},runXeLaTeX:async()=>{throw Error('must not start');}});
  assert.equal(result.pdfReady,false);assert.equal(result.task.status,'cancelled');
});
for(const mode of ['timeout','abort'])test(`${mode} drains real compiler child and descendants before private directory cleanup`,async t=>{
  const controller=new AbortController();let pids=[];
  const result=await verify(t,{signal:controller.signal,timeoutMs:600,runXeLaTeX:async({cwd,signal,timeoutMs})=>{
    if(mode==='abort')setTimeout(()=>controller.abort(),300);
    const outcome=await runProcess({executable:process.execPath,cwd,signal,timeoutMs,args:['-e','const{spawn}=require("node:child_process");console.log(process.pid);const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(child.pid);setInterval(()=>{},1000);']});
    pids.push(...outcome.log.trim().split(/\s+/u).map(Number));return outcome;
  }});
  assert.equal(result.pdfReady,false);assert.equal(result.task.status,mode==='abort'?'cancelled':'failed');
  assert.ok(pids.length>=2);for(const pid of pids)assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});
