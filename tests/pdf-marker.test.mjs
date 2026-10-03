import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveQaTools } from './helpers/qa-tools.mjs';
const exec = promisify(execFile);
test('PDF inspector ties every body marker glyph and position to its size, not unrelated headings', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'purecv-marker-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'marker.pdf'); const { python } = resolveQaTools();
  await exec(python, ['-c', `from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
import sys
w=PdfWriter(); p=w.add_blank_page(300,300)
font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
p[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):w._add_object(font)})})
s=DecodedStreamObject(); s.set_data(b'BT /F1 11 Tf 10 260 Td (Heading) Tj /F1 8 Tf 0 -30 Td (BODY_MARKER) Tj ET')
p[NameObject('/Contents')]=w._add_object(s)
w.write(sys.argv[1])`, path], { windowsHide: true });
  const { stdout } = await exec(python, ['-X', 'utf8', fileURLToPath(new URL('./integration/inspect_pdf.py', import.meta.url)), path], { windowsHide: true });
  const info = JSON.parse(stdout);
  assert.ok(info.sizes.some(size => Math.abs(size - 11) < 0.3), 'A heading would fool the old any-glyph assertion');
  assert.equal(info.bodyMarkers?.length, 1, 'Marker-specific inspection is required');
  const marker = info.bodyMarkers[0]; assert.equal(marker.page, 1);
  assert.equal(marker.glyphs.map(g => g.text).join(''), 'BODY_MARKER');
  assert.ok(marker.glyphs.every(g => Math.abs(g.size - 8) < 0.01 && Number.isFinite(g.x0) && Number.isFinite(g.top)));
  assert.equal(marker.glyphs.every(g => Math.abs(g.size - 11) < 0.3), false, 'Wrong body size must fail even when heading is correct');
});
