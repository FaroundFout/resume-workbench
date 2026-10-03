import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyData, validateResumeData } from '../web/shared/model.mjs';
import { mountSections } from '../web/forms/sections.mjs';
import { installDom, TestNode } from './helpers/dom.mjs';
import { withStore } from './helpers/store.mjs';
import { exportBackup, importBackup } from '../server/backups.mjs';
const education = {id:'e',school:'Example University',degree:'BSc',major:'Software',period:'2024–2028',bullets:[]};
test('optional education location survives validation save and portable schema1 backup in both languages', async () => {
  for (const language of ['zh-CN','en']) for (const location of [undefined,'成都 & Chengdu']) {
    const data=createEmptyData(language); data.logo.mode='hidden';
    data.sections.education.items=[{...education,...(location===undefined?{}:{location})}];
    assert.deepEqual(validateResumeData(data),{ok:true,value:data});
    await withStore(async store=>{
      const doc=await store.create({name:'Fictional',language,seed:data});
      const saved=await store.save(doc.id,{expectedRevision:0,data});
      assert.equal(saved.schemaVersion,1);
      const imported=await importBackup(store,await exportBackup(store,doc.id));
      assert.deepEqual(imported.data.sections.education.items,data.sections.education.items);
    });
  }
});
test('optional education location has strict type length and unknown-field validation',()=>{
  for(const [field,value] of [['location',null],['location',23],['location','x'.repeat(2001)],['campus','unknown']]){
    const data=createEmptyData('en');data.sections.education.items=[{...education,[field]:value}];
    const result=validateResumeData(data);assert.equal(result.ok,false);
    assert.ok(result.issues.some(i=>i.path===`sections.education.items[0].${field}`));
  }
});
test('education location field edits an old record without changing its original bullets',async t=>{
  const container=installDom(t);const make=document.createElement;document.createElement=tag=>{const n=make(tag);n.ownerDocument=document;return n;};document.createTextNode=text=>{const n=new TestNode('#text');n.textContent=text;return n;};
  let data=createEmptyData('zh-CN');data.sections.education.items=[{...education,bullets:[[{text:'Existing course',bold:false,url:null}]]}];
  mountSections(container,{data,sectionKey:'education',onChange:next=>data=next});
  const label=container.all().find(n=>n.tagName==='label'&&n.children.some(c=>c.textContent==='地点'));
  assert.ok(label,'Education must offer an editable location');
  const input=label.all().find(n=>n.tagName==='input');assert.equal(input.value,'');input.value='成都';await input.fire('input');
  assert.equal(data.sections.education.items[0].location,'成都');
  assert.equal(data.sections.education.items[0].bullets[0][0].text,'Existing course');
  assert.equal(validateResumeData(data).ok,true);
});
