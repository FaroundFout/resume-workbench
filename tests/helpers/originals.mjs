import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Portable: discover preserved originals in this checkout, including existing
// PDFs when present. Never refer to another user's external source directory.
export async function protectedHashes(root) {
  const hashes={};
  async function walk(folder) {
    for(const entry of await readdir(join(root,folder),{withFileTypes:true})) {
      const name=join(folder,entry.name);
      if(entry.isDirectory()) await walk(name);
      else hashes[name]=createHash('sha256').update(await readFile(join(root,name))).digest('hex');
    }
  }
  for(const folder of ['font','resume','resume_zh']) await walk(folder);
  return hashes;
}
