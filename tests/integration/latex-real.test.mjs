import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../../server/config.mjs';
import { detectCompiler } from '../../server/compiler/environment.mjs';
import { createStore } from '../../server/storage.mjs';
import { createBuildManager } from '../../server/compiler/builds.mjs';
import { createEmptyData } from '../../web/shared/model.mjs';
import { protectedHashes } from '../helpers/originals.mjs';
import { resolveQaTools } from '../helpers/qa-tools.mjs';
const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const artifacts = join(root, 'docs/verification/artifacts');
const { python, pdftoppm } = resolveQaTools();
const normalize = s => s.replace(/\s/gu, '');
async function inspect(path) {
  const out = await exec(python, ['-X', 'utf8', join(root, 'tests/integration/inspect_pdf.py'), path], { windowsHide: true, maxBuffer: 8*1024*1024 });
  return JSON.parse(out.stdout);
}
async function setup(t) {
  const originalHashes=await protectedHashes(root);
  t.after(async()=>assert.deepEqual(await protectedHashes(root),originalHashes,'Original source/fonts/logos/PDFs preserved after actual compile'));
  await mkdir(artifacts, { recursive: true });
  const config = await loadConfig(root);
  const env = await detectCompiler(config);
  assert.equal(env.available, true, 'Real integration requires an actual supported XeLaTeX; configure config.local.json (never silently skipped).');
  const workspace = join(artifacts, `实际编译 空格 ${process.pid}`);
  await rm(workspace, { recursive: true, force: true });
  const projectRoot = join(workspace, '中文项目 路径');
  const dataDir = join(workspace, '中文数据 路径');
  for (const name of ['font','templates','resume','resume_zh']) await cp(join(root,name), join(projectRoot,name), { recursive:true });
  const store = await createStore({ dataDir });
  const manager = createBuildManager({ config: { ...config,projectRoot,dataDir }, store });
  t.after(async () => { await manager.shutdown(); await rm(workspace,{recursive:true,force:true}); });
  return { projectRoot,dataDir,store,manager, async compile(data, image, priorDoc=null) {
    let doc = priorDoc ?? await store.create({ name:'公开虚构验收',language:data.language,seed:{...data,logo:{...data.logo,mode:'hidden',assetId:null}} });
    if (image) { const id = await store.writeAsset(doc.id, image); data.logo = {...data.logo,mode:'custom',assetId:id}; }
    doc = await store.save(doc.id,{expectedRevision:doc.revision,data});
    const submitted = await manager.submit({resumeId:doc.id,expectedRevision:doc.revision});
    let record;
    const deadline = Date.now()+100000;
    while ((record = await manager.read(submitted.id)).status === 'running') { assert.ok(Date.now()<deadline,'Actual build exceeded bounded wait'); await delay(25); }
    const log = await readFile(await manager.logPath(record.id),'utf8');
    assert.equal(record.status,'succeeded',`Actual compiler failed: ${log}`);
    assert.doesNotMatch(log,/Missing character:|Fatal error|not loadable/iu,'Missing glyph/font must fail actual QA');
    const pdf = await manager.pdfPath(record.id);
    const info = await inspect(pdf);
    assert.equal(record.pages,info.pages,'Published page count must match actual PDF');
    assert.ok(Object.keys(info.fonts).length>0);
    assert.ok(Object.values(info.fonts).every(Boolean),'Every native font must be embedded');
    const paper = data.layout.paper==='auto' ? (data.language==='zh-CN'?'a4':'letter') : data.layout.paper;
    const wanted = paper==='a4'?[595.28,841.89]:[612,792];
    assert.ok(info.boxes.every(box=>box.every((n,i)=>Math.abs(n-wanted[i])<0.5)),'Actual paper dimensions');
    await writeFile(join(artifacts,`${data.profile.name.startsWith('EN')?'en':'zh'}-last-inspection.json`),JSON.stringify(info,null,2));
    return { record,pdf,info,log,doc };
  }};
}

test('actual PDF preserves encoded email URI and contact icons add no garbage native text', {timeout:120000}, async t => {
  const f=await setup(t);
  const data=createEmptyData('en');
  data.logo.mode='hidden';data.profile.name='EN QA 示例';
  data.profile.contacts=[
    {id:'phone',type:'phone',label:'Phone',value:'123456'},
    {id:'email',type:'email',label:'Email',value:'student+qa#tag@example.com'},
    {id:'wechat',type:'wechat',label:'WeChat',value:'wechat_qa'},
    {id:'url',type:'url',label:'Website',value:'https://example.com/qa'},
  ];
  const {info,pdf,log}=await f.compile(data);
  assert.doesNotMatch(log,/size unavailable/,'All vector icon strokes must be renderable');
  assert.ok(info.uris.includes('mailto:student%2Bqa%23tag@example.com'),JSON.stringify(info.uris));
  assert.equal(normalize(info.text),'ENQA示例123456student+qa#tag@example.comwechat_qahttps://example.com/qa','Decoration must add no garbage native characters');
  await exec(pdftoppm,['-f','1','-singlefile','-scale-to','1200','-png',pdf,join(artifacts,'contact-icons')],{windowsHide:true});
});

// Wrong resources, wrong paper/body size, dropped symbols/Chinese/bold/URI,
// squashed logos, truncated long content and non-native fonts all fail below.
test('actual bilingual matrix covers Chinese spaced paths image proportions rich text and multi-page content', {timeout:240000}, async t=>{
  const f=await setup(t);
  const logoDir=join(artifacts,'test logos');await mkdir(logoDir,{recursive:true});
  await exec(python,['-X','utf8','-c',`from PIL import Image, ImageDraw
import sys, pathlib
out=pathlib.Path(sys.argv[1])
for ext in ['png','jpg']:
 for name,size in [('square',(180,180)),('wide',(500,100)),('tall',(100,500))]:
  im=Image.new('RGB',size,'#d7e9ee');d=ImageDraw.Draw(im);d.rectangle((3,3,size[0]-4,size[1]-4),outline='#155a76',width=4);d.line((0,0,*size),fill='#b43838',width=5);im.save(out/f'{name}.{ext}')`,logoDir],{windowsHide:true});
  const cases=[['zh-CN','square','png',12,'standard','a4'],['en','wide','jpg',11,'compact','auto'],['zh-CN','tall','png',10,'compact','auto'],['en','square','jpg',12,'standard','a4'],['zh-CN','wide','png',11,'standard','letter'],['en','tall','jpg',10,'compact','auto']];
  const report=[];
  let first;
  for(const [language,shape,extension,fontSizePt,density,paper] of cases) {
    const data=JSON.parse(await readFile(join(root,'examples',language==='en'?'resume.en.json':'resume.zh.json'),'utf8'));
    data.profile.name=language==='en'?'EN QA Example 示例':'中文验收 示例';
    data.layout={paper,fontSizePt,density,marginMm:12};
    data.logo.widthCm=3.2;
    data.profile.contacts.push({id:'phone',type:'phone',label:'电话',value:'123456789'}, {id:'wechat',type:'wechat',label:'微信',value:'qa_example'});
    data.sections.projects.items[0].name='A genuinely long wrapping project title with 中文内容 and multiple meaningful words '.repeat(3);
    data.sections.projects.items[0].period='September 2024 – September 2026';
    data.sections.projects.items[0].summary=[{text:'特殊符号 & _ % $ # { } \\ ^ ~\nSecond native line 中文混排',bold:true,url:'https://example.com/qa?a=1&b=2#fragment'}];
    data.sections.skills.items[0].content=[{text:'BODY_MARKER Java SQL 中文字符',bold:false,url:null}];
    if(language==='zh-CN' && shape==='square') data.sections.projects.items[0].bullets=Array.from({length:65},(_,i)=>[{text:`Long bullet ${i+1}: Chinese 中文内容 and English; data consistency for a complete saved snapshot with sufficient words to wrap within the page.`,bold:false,url:null}]);
    const image=await readFile(join(logoDir,`${shape}.${extension}`));
    const result=await f.compile(data,image);
    const {info,record,pdf,log}=result;
    const compact=normalize(info.text);
    assert.ok(compact.includes('中文字符'),'Chinese body must be native text');
    assert.ok(compact.includes('特殊符号&_%$#{}\\^~'),'Escaped punctuation must remain literal');
    assert.ok(compact.includes('Secondnativeline中文混排'),'Native hard line break must preserve both lines');
    assert.ok(compact.includes('Agenuinelylongwrappingprojecttitlewith中文内容'),'Long title native text');
    assert.ok(info.uris.includes('mailto:student@example.com'));
    assert.ok(info.uris.includes('https://example.com/qa?a=1&b=2#fragment'));
    assert.ok(Object.keys(info.fonts).some(x=>x.includes('SourceHanSerifCN-Regular')),'Bundled Chinese body font');
    assert.ok(Object.keys(info.fonts).some(x=>x.includes('Lato-Bold')),'Bold native font');
    assert.equal(info.bodyMarkers.length, 1, 'Body marker must exist exactly once');
    assert.equal(info.bodyMarkers[0].glyphs.map(glyph => glyph.text).join(''), 'BODY_MARKER');
    assert.ok(info.bodyMarkers[0].glyphs.every(glyph => Math.abs(glyph.size-fontSizePt)<0.3),
      'Every actual BODY_MARKER glyph must use the selected body size (TeX/PDF point tolerance)');
    assert.doesNotMatch(log,/Overfull \\hbox/,'Long title/header must not overflow');
    const im=info.images.flat()[0];assert.ok(im,'Custom logo must be present');
    const ratio=(im.x1-im.x0)/(im.bottom-im.top);
    const expected=shape==='square'?1:shape==='wide'?5:0.2;
    assert.ok(Math.abs(ratio-expected)<0.02,'Preserved image aspect ratio');
    assert.ok(im.x1-im.x0<=3.2/2.54*72+0.3 && im.bottom-im.top<=3.2/2.54*72+0.3,'Logo bounded both dimensions');
    if(language==='zh-CN'&&shape==='square') {assert.ok(info.pages>=2);assert.ok(compact.includes('Longbullet65:'));first={...result,data};}
    const name=`${language==='en'?'en':'zh'}-${shape}-${extension}`;
    await exec(pdftoppm,['-f','1','-singlefile','-scale-to','1200','-png',pdf,join(artifacts,name)],{windowsHide:true});
    if(info.pages>=2) await exec(pdftoppm,['-f',String(info.pages),'-singlefile','-scale-to','1200','-png',pdf,join(artifacts,`${name}-last`)],{windowsHide:true});
    await cp(pdf,join(artifacts,`${name}.pdf`));
    report.push({name,status:record.status,pages:info.pages,paper:info.boxes[0],body:fontSizePt,logo:im,warnings:record.warnings});
  }
  // Same resume: hidden retains its custom image reference; default resets it.
  const savedAsset=first.data.logo.assetId;
  first.data.logo.mode='hidden';
  const hidden=await f.compile(first.data,null,first.doc);
  assert.equal(hidden.doc.data.logo.assetId,savedAsset);
  assert.equal(hidden.info.images.flat().length,0);
  await cp(hidden.pdf,join(artifacts,'zh-hidden.pdf'));
  first.data.logo={mode:'default',assetId:null,widthCm:2.4};
  const restored=await f.compile(first.data,null,hidden.doc);
  assert.equal(restored.doc.data.logo.assetId,null);
  assert.equal(restored.info.images.flat().length,1);
  await exec(pdftoppm,['-f','1','-singlefile','-scale-to','1200','-png',restored.pdf,join(artifacts,'zh-restored-default')],{windowsHide:true});
  for(const language of ['zh-CN','en']) {
    const data=createEmptyData(language);data.profile.name=language==='en'?'EN Title Only 示例':'仅标题 示例';data.logo.mode='hidden';
    const minimal=await f.compile(data);
    assert.equal(minimal.info.pages,1);assert.equal(normalize(minimal.info.text),normalize(data.profile.name));
    await exec(pdftoppm,['-f','1','-singlefile','-scale-to','1200','-png',minimal.pdf,join(artifacts,`${language}-title-only`)],{windowsHide:true});
    report.push({name:`${language}-title-only`,pages:minimal.info.pages,paper:minimal.info.boxes[0]});
  }
  report.push({name:'same-resume-hidden',pages:hidden.info.pages,logoImages:0},{name:'same-resume-restored-default',pages:restored.info.pages,logoImages:1});
  await writeFile(join(artifacts,'actual-matrix.json'),JSON.stringify(report,null,2));
});

test('real integration fails explicitly on missing compiler missing font and actual TeX failure', {timeout:120000}, async t=>{
  const f=await setup(t);
  const config=await loadConfig(root);
  const missing=createBuildManager({config:{...config,projectRoot:f.projectRoot,dataDir:f.dataDir,xelatexPath:join(f.dataDir,'does-not-exist.exe')},store:f.store});
  t.after(()=>missing.shutdown());
  const doc=await f.store.create({name:'公开故障测试',language:'en'});
  await assert.rejects(missing.submit({resumeId:doc.id,expectedRevision:0}),e=>e.code==='COMPILER_UNAVAILABLE');
  // Deliberately remove ONLY a copied test resource. No product templates/fonts change.
  await rm(join(f.projectRoot,'font/Lato/Lato-Regular.ttf'));
  const record=await f.manager.submit({resumeId:doc.id,expectedRevision:0});
  let failed;while((failed=await f.manager.read(record.id)).status==='running')await delay(25);
  assert.equal(failed.status,'failed');
  assert.equal(await f.manager.latestForResume(doc.id),null);
  await assert.rejects(f.manager.pdfPath(failed.id),e=>e.code==='PDF_NOT_AVAILABLE');
  await cp(join(root,'font/Lato/Lato-Regular.ttf'),join(f.projectRoot,'font/Lato/Lato-Regular.ttf'));
  const broken=join(f.projectRoot,'templates/purecv-en/main.tex');
  await writeFile(broken,(await readFile(broken,'utf8')).replace('\\begin{document}','\\begin{document}\n\\UndefinedControlledCommand'));
  const brokenRecord=await f.manager.submit({resumeId:doc.id,expectedRevision:0});
  while((failed=await f.manager.read(brokenRecord.id)).status==='running')await delay(25);
  assert.equal(failed.status,'failed');
  const log=await readFile(await f.manager.logPath(failed.id),'utf8');
  assert.match(log,/Undefined control sequence/);
  assert.equal(await f.manager.latestForResume(doc.id),null);
});
