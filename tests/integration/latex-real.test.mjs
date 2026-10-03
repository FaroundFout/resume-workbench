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



function textGlyphs(info, text) {
  const wanted=text.replace(/\s/gu, '');
  for (const glyphs of info.glyphPages) {
    const page=glyphs.filter(g=>g.text.trim());
    const flat=page.map(g=>g.text).join(''); const start=flat.indexOf(wanted);
    if(start>=0) return page.slice(start,start+wanted.length);
  }
  assert.fail(`Missing native text: ${text}`);
}
test('original Chinese primary name uses Huge bold and alternate name uses Large actual glyph sizes', {timeout:120000},async t=>{
  const f=await setup(t);const data=createEmptyData('zh-CN');data.logo.mode='hidden';data.layout.fontSizePt=11;
  data.profile.name='布局示例';data.profile.alternateName='Layout Example';
  const {info}=await f.compile(data);
  assert.ok(textGlyphs(info,'布局示例').every(g=>Math.abs(g.size-24.8)<0.3&&g.fontname.includes('Bold')),'Huge bold primary name');
  assert.ok(textGlyphs(info,'Layout Example').every(g=>Math.abs(g.size-14.35)<0.3),'Large alternate name');
});
test('original Chinese hierarchy phone rows project stack and education location have actual PDF geometry', {timeout:120000},async t=>{
  const f=await setup(t);const data=createEmptyData('zh-CN');data.logo.mode='hidden';data.layout.fontSizePt=11;
  data.profile.name='布局示例';data.profile.alternateName='Layout Example';
  data.profile.contacts=[{id:'email',type:'email',label:'',value:'geometry@example.com'},{id:'phone',type:'phone',label:'',value:'123456789'}];
  data.sections.education.items=[{id:'e',school:'示例大学',degree:'工学学士',major:'软件工程',location:'成都',period:'2024–2028',bullets:[]}];
  data.sections.projects.items=[{id:'p',name:'PROJECT_ALPHA',period:'',role:'Developer',url:'',techStack:'STACK_ALPHA',summary:[{text:'项目概述：内容完整。',bold:false,url:null}],bullets:[]}];
  data.sections.awards.items=[{id:'a',name:'AWARD_ALPHA',period:'2025',issuer:'ISSUER_ALPHA',description:[{text:'DESCRIPTION_ALPHA',bold:false,url:null}]}];
  const {info,log,pdf}=await f.compile(data);
  const name=textGlyphs(info,'布局示例'),alternate=textGlyphs(info,'Layout Example');
  assert.ok(name.every(g=>Math.abs(g.size-24.8)<0.3),'Primary name should have original Huge size');
  assert.ok(name.every(g=>g.fontname.includes('Bold')),'Chinese primary name must be bold as original');
  assert.ok(alternate.every(g=>Math.abs(g.size-14.35)<0.3),'Alternate name should have original Large size');
  assert.ok(textGlyphs(info,'123456789')[0].top<textGlyphs(info,'geometry@example.com')[0].top,'Phone precedes the other contacts row');
  const project=textGlyphs(info,'PROJECT_ALPHA'),stack=textGlyphs(info,'STACK_ALPHA');
  assert.ok(Math.abs(project[0].bottom-stack[0].bottom)<0.5,'Project and stack share a baseline');
  assert.ok(stack.every(g=>g.fontname.includes('Italic')),'Technical stack is italic');
  const degree=textGlyphs(info,'工学学士'),location=textGlyphs(info,'成都');
  assert.ok(Math.abs(degree[0].bottom-location[0].bottom)<0.5,'Degree and location share second row');
  assert.ok(location[0].x0>info.boxes[0][0]*0.75,'Location aligns right');
  assert.ok(textGlyphs(info,'教育经历').every(g=>g.fontname.includes('Regular')),'Chapter title normal weight');
  assert.ok(textGlyphs(info,'AWARD_ALPHA').every(g=>g.fontname.includes('Regular')),'Awards normal weight');
  for(const marker of ['ISSUER_ALPHA','DESCRIPTION_ALPHA','2025'])assert.ok(normalize(info.text).includes(marker));
  assert.doesNotMatch(log,/Overfull \\hbox/);
  await cp(pdf,join(artifacts,'zh-original-layout.pdf'));
  await writeFile(join(artifacts,'zh-original-layout-inspection.json'),JSON.stringify(info,null,2));
});
test('compact Chinese uses full undated project width and dense content while standard stays roomier', {timeout:120000},async t=>{
  const f=await setup(t);const data=createEmptyData('zh-CN');data.logo.mode='hidden';data.layout.fontSizePt=11;
  data.profile.name='密集示例';
  data.sections.projects.items=[{id:'p',name:'WRAPPING_PROJECT with 中文内容 & escaped symbols',period:'',role:'',url:'',techStack:'Java Spring Boot MySQL Redis Redisson Lua Flyway STACK_END',summary:[],bullets:Array.from({length:33},(_,i)=>[{text:`要点${i+1}：完整中文内容与 Java 技术细节；说明数据一致性、事务边界与消息处理的实际行为。`,bold:false,url:null}])}];
  data.sections.skills.items=[{id:'s',category:'技能',content:[{text:'BODY_MARKER Java 中文字符',bold:false,url:null}]}];
  const compact=await f.compile(data);
  assert.equal(compact.info.pages,1,'Dense Chinese case should fit one page at selected 11 pt');
  const firstBullet=textGlyphs(compact.info,'要点1：')[0].top;
  const headingGlyphs=compact.info.glyphPages[0].filter(g=>g.top<firstBullet&&g.top>textGlyphs(compact.info,'项目经历')[0].top+10);
  assert.ok(Math.max(...headingGlyphs.map(g=>g.x1))>compact.info.boxes[0][0]*0.75,'Undated heading may use full width');
  assert.ok(normalize(compact.info.text).includes('要点33：'));
  assert.doesNotMatch(compact.log,/Overfull \\hbox/);
  assert.ok(compact.info.bodyMarkers[0].glyphs.every(g=>Math.abs(g.size-11)<0.3));
  data.layout.density='standard';const standard=await f.compile(data);
  const top=info=>textGlyphs(info,'BODY_MARKER')[0].top;
  assert.ok(standard.info.pages>compact.info.pages||top(standard.info)>top(compact.info)+10,'Standard density retains more spacing');
  await cp(compact.pdf,join(artifacts,'zh-dense-layout.pdf'));
});


test('valid maximum Chinese dated project and education location remain within actual page glyph bounds', {timeout:120000},async t=>{
  const f=await setup(t);const data=createEmptyData('zh-CN');data.logo.mode='hidden';data.layout={fontSizePt:12,marginMm:20,density:'standard',paper:'a4'};
  data.profile.name='分页验收';
  const repeated=(prefix,suffix)=>prefix.repeat(Math.floor((2000-suffix.length)/prefix.length))+suffix;
  const period=repeated('长期日期内容 ', 'PERIOD_END');const location=repeated('地点中文内容 ', 'LOCATION_END');
  const name=repeated('长项目名称中文 ', 'PROJECT_NAME_END');const stack=repeated('技术栈 Java Redis ', 'STACK_END');
  data.sections.education.items=[{id:'e',school:'示例学校',degree:'学士',major:'软件',period:'2024–2028',location,bullets:[]}];
  data.sections.projects.items=[{id:'p',name,period,techStack:stack,role:'ROLE_END',url:'',summary:[{text:'SUMMARY_END',bold:false,url:null}],bullets:[[{text:'FINAL_BULLET',bold:false,url:null}]]}];
  const {info,log,pdf}=await f.compile(data);
  assert.ok(info.pages>1,'Long valid row needs page breaks');
  for(const marker of ['PERIOD_END','LOCATION_END','PROJECT_NAME_END','STACK_END','ROLE_END','SUMMARY_END','FINAL_BULLET'])assert.ok(normalize(info.text).includes(marker),`Native text retains ${marker}`);
  for(const [index,glyphs]of info.glyphPages.entries()){
    const [width,height]=info.boxes[index];
    for(const g of glyphs.filter(g=>g.text.trim())){
      assert.ok(g.top>=0&&g.bottom<=height+0.5,`Page ${index+1}: ${g.text} vertical bounds ${g.top}..${g.bottom} exceed ${height}`);
      assert.ok(g.x0>=0&&g.x1<=width+0.5,`Page ${index+1}: ${g.text} horizontal bounds exceed ${width}`);
    }
  }
  assert.doesNotMatch(log,/Overfull \\[hv]box/);
  await cp(pdf,join(artifacts,'zh-maximum-rows.pdf'));
  await writeFile(join(artifacts,'zh-maximum-rows-inspection.json'),JSON.stringify(info,null,2));
});

// Reducing spacing between project entries must not let the prior CJK bullet
// collide with the next bold heading, even while compact body size is selected.
for (const fontSizePt of [10, 11, 12]) {
  test(`compact Chinese project boundary has clear actual glyph separation at ${fontSizePt} pt`, {timeout:120000}, async t=>{
    const f=await setup(t);const data=createEmptyData('zh-CN');data.logo.mode='hidden';
    data.profile.name='项目间距验收';data.layout.fontSizePt=fontSizePt;
    const preceding='末行内容保留事务边界与一致性保证';
    const following='后续项目中文标题与边界检查';
    data.sections.projects.items=[
      {id:'first',name:'首个项目中文标题',period:'2024–2025',role:'开发成员',url:'',techStack:'Java Redis',summary:[{text:'公开虚构项目说明。',bold:false,url:null}],bullets:[[{text:'BODY_MARKER 公开验收要点。',bold:false,url:null}],[{text:preceding,bold:false,url:null}]]},
      {id:'second',name:following,period:'2025–2026',role:'开发成员',url:'',techStack:'Spring MySQL',summary:[],bullets:[[{text:'后续项目内容完整保留。',bold:false,url:null}]]},
    ];
    const {info,log,pdf}=await f.compile(data);
    assert.equal(info.pages,1,'Small two-project fixture remains compact');
    const tail=textGlyphs(info,preceding),heading=textGlyphs(info,following);
    const lastBottom=Math.max(...tail.map(g=>g.bottom));
    const lastRow=tail.filter(g=>Math.abs(g.bottom-lastBottom)<0.1);
    const firstTop=Math.min(...heading.map(g=>g.top));
    const firstRow=heading.filter(g=>Math.abs(g.top-firstTop)<0.1);
    const pairs=lastRow.flatMap(a=>firstRow.filter(b=>Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)>0.05).map(b=>({clearance:b.top-a.bottom})));
    assert.ok(pairs.length>0,'Fixture must compare horizontally intersecting CJK glyphs');
    const clearance=Math.min(...pairs.map(pair=>pair.clearance));
    const geometry={fontSizePt,horizontallyIntersectingPairs:pairs.length,minimumGlyphClearancePt:clearance};
    t.diagnostic(JSON.stringify(geometry));
    await cp(pdf,join(artifacts,`zh-project-boundary-${fontSizePt}.pdf`));
    await writeFile(join(artifacts,`zh-project-boundary-${fontSizePt}-geometry.json`),JSON.stringify(geometry,null,2));
    assert.ok(clearance>0,`Project boundary glyphs must have positive clearance; actual ${clearance.toFixed(3)} pt`);
    if(fontSizePt===10)assert.ok(clearance>=7&&clearance<=10,'Default compact project boundary should restore roughly 8 pt of clear space');
    assert.ok(tail.every(g=>Math.abs(g.size-fontSizePt)<0.3&&g.fontname.includes('Regular')),'Preceding CJK bullet keeps selected regular body size');
    assert.ok(heading.every(g=>Math.abs(g.size-fontSizePt)<0.3&&g.fontname.includes('Bold')),'Following CJK heading keeps selected bold body size');
    assert.ok(info.bodyMarkers[0].glyphs.every(g=>Math.abs(g.size-fontSizePt)<0.3),'Body marker keeps selected size');
    assert.ok(normalize(info.text).includes('后续项目内容完整保留。'));
    assert.doesNotMatch(log,/Overfull \\[hv]box/);
  });
}

// Catch a factor ignored by either adapter, font resizing, lost final text or clipped pages.
for (const language of ['zh-CN', 'en']) {
  test(`actual ${language} body line spacing preserves fonts and text while increasing baselines at 1.2 and 1.5`, { timeout: 180000 }, async t => {
    const f = await setup(t);
    const data = createEmptyData(language); data.logo.mode = 'hidden'; data.layout.fontSizePt = 11;
    data.profile.name = language === 'en' ? 'EN Spacing Example' : '中文行距验收';
    data.sections.projects.items = [{
      id: 'spacing', name: 'Wrapping project title with 中文内容 and native font metrics '.repeat(3),
      period: '2024–2026', role: 'Developer', techStack: 'Java SQL 中文', url: '', summary: [],
      bullets: [
        [{ text: 'BODY_MARKER FIRST_BASELINE\nSECOND_BASELINE 正文行距中文标记\nTHIRD_BASELINE native content', bold: false, url: null }],
        ...Array.from({ length: 55 }, (_, i) => [{ text: `公开测试要点 ${i + 1}: Native text and 中文内容 describe complete saved data and safe page breaks.`, bold: false, url: null }]),
        [{ text: 'FINAL_SPACING_MARKER 中文末行', bold: false, url: null }],
      ],
    }];
    const metrics = [];
    let defaultGap, defaultFonts, defaultText;
    for (const factor of [1, 1.2, 1.5]) {
      data.layout.lineSpacing = factor;
      const { info, log, pdf } = await f.compile(data);
      const lines = ['FIRST_BASELINE', 'SECOND_BASELINE', 'THIRD_BASELINE'].map(marker => textGlyphs(info, marker));
      const baselines = lines.map(glyphs => glyphs[0].bottom);
      const gaps = [baselines[1] - baselines[0], baselines[2] - baselines[1]];
      const bodyGlyphs = lines.flat();
      assert.ok(bodyGlyphs.every(g => Math.abs(g.size - 11) < 0.3 && g.fontname.includes('Lato-Regular')), 'Spacing must retain selected actual body font and size');
      assert.ok(textGlyphs(info, '正文行距中文标记').every(g => Math.abs(g.size - 11) < 0.3 && g.fontname.includes('SourceHanSerifCN-Regular')));
      assert.ok(normalize(info.text).includes('FINAL_SPACING_MARKER中文末行'), 'Last native text must survive pagination');
      const fonts = [...new Set(bodyGlyphs.map(g => `${g.fontname.replace(/^[A-Z]{6}\+/u, '')}:${g.size.toFixed(2)}`))];
      const plainText = normalize(info.text);
      if (factor === 1) {
        defaultGap = gaps[0]; defaultFonts = fonts; defaultText = plainText;
        assert.ok(Math.abs(defaultGap - 13.549) < 0.01, 'Default retains original 13.6 TeX pt article baseline in PDF points');
      } else {
        assert.deepEqual(fonts, defaultFonts);
        assert.equal(plainText, defaultText, 'Spacing must keep all native text');
        for (const gap of gaps) assert.ok(Math.abs(gap / defaultGap - factor) < 0.015, `Physical baseline ${gap} must scale from ${defaultGap} by ${factor}`);
      }
      for (const [index, glyphs] of info.glyphPages.entries()) {
        const [width, height] = info.boxes[index];
        for (const g of glyphs.filter(g => g.text.trim())) {
          assert.ok(g.top >= 0 && g.bottom <= height + 0.5, `Page ${index + 1}: vertical glyph bounds ${g.top}..${g.bottom}`);
          assert.ok(g.x0 >= 0 && g.x1 <= width + 0.5, `Page ${index + 1}: horizontal glyph bounds ${g.x0}..${g.x1}`);
        }
      }
      if (factor === 1.5) assert.ok(info.pages >= 2, 'Maximum spacing supports real multipage output');
      assert.doesNotMatch(log, /Overfull \\[hv]box/);
      const metric = { language, factor, pages: info.pages, baselines, gaps, fonts, bodySizePt: bodyGlyphs[0].size, finalMarker: true, allGlyphsWithinPage: true };
      t.diagnostic(JSON.stringify(metric)); metrics.push(metric);
      await cp(pdf, join(artifacts, `${language}-line-spacing-${factor}.pdf`));
    }
    await writeFile(join(artifacts, `${language}-line-spacing-metrics.json`), JSON.stringify(metrics, null, 2));
  });
}
