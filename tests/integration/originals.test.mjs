import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStore } from '../helpers/store.mjs';
import { protectedHashes } from '../helpers/originals.mjs';
import { prepareBuild } from '../../server/latex/resources.mjs';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
test('preparing both language adapters never modifies original TeX fonts logos or existing PDFs',async()=>{
  const before=await protectedHashes(root);
  assert.ok(Object.keys(before).some(name=>name.endsWith('.tex')));
  assert.ok(Object.keys(before).some(name=>name.endsWith('.ttf')));
  assert.equal(Object.keys(before).filter(name=>name.endsWith('uestc.png')).length,2);
  await withStore(async(store,dataDir)=>{
    for(const language of ['zh-CN','en']) {
      const doc=await store.create({name:'公开保护测试',language});
      const buildDir=join(dataDir,'builds',randomUUID()); await mkdir(buildDir);
      await prepareBuild({projectRoot:root,dataDir,buildDir,snapshot:await store.capture(doc.id,0)});
    }
  });
  assert.deepEqual(await protectedHashes(root),before);
});
