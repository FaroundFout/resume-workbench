"""QA only: inspect real PDF native text, fonts, links, geometry and image boxes."""
import json, sys
from pypdf import PdfReader
import pdfplumber
reader = PdfReader(sys.argv[1])
fonts, uris, boxes, images, sizes, body_markers = {}, [], [], [], [], []
for page in reader.pages:
    boxes.append([float(page.mediabox.width), float(page.mediabox.height)])
    for ref in page.get('/Annots', []):
        action = ref.get_object().get('/A', {})
        if action.get('/URI'): uris.append(str(action['/URI']))
    for ref in page.get('/Resources', {}).get('/Font', {}).values():
        font = ref.get_object()
        for child in font.get('/DescendantFonts', [font]):
            child = child.get_object()
            desc = child.get('/FontDescriptor', {}).get_object() if child.get('/FontDescriptor') else {}
            fonts[str(child.get('/BaseFont', font.get('/BaseFont', 'unknown')))] = any(key in desc for key in ['/FontFile', '/FontFile2', '/FontFile3'])
with pdfplumber.open(sys.argv[1]) as pdf:
    for page_number, page in enumerate(pdf.pages, 1):
        images.append([{key: im[key] for key in ['x0', 'x1', 'top', 'bottom', 'srcsize']} for im in page.images])
        sizes.extend(float(c['size']) for c in page.chars if c['text'].strip())
        text = ''.join(c['text'] for c in page.chars)
        offset = 0
        while (start := text.find('BODY_MARKER', offset)) >= 0:
            end = start + len('BODY_MARKER')
            glyphs, position = [], 0
            for char in page.chars:
                next_position = position + len(char['text'])
                if position < end and next_position > start:
                    glyphs.append({key: char[key] for key in ['text', 'size', 'x0', 'top']})
                position = next_position
            body_markers.append({'page': page_number, 'glyphs': glyphs})
            offset = end
print(json.dumps({'pages': len(reader.pages), 'text': '\n'.join(p.extract_text() or '' for p in reader.pages), 'fonts': fonts, 'uris': uris, 'boxes': boxes, 'images': images, 'sizes': sizes, 'bodyMarkers': body_markers}, ensure_ascii=False))
