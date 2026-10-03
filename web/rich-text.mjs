/** Coalesces controlled runs without altering their text. */
export function normalizeRuns(runs) {
  const result = [];
  for (const [index, run] of runs.entries()) {
    const url = run.url ?? null;
    if (url !== null) {
      if (typeof url === 'string' && url.length > 2000) throw { code: 'VALIDATION_ERROR', status: 400, message: '链接不得超过 2000 字符', fields: { [`runs[${index}].url`]: '链接不得超过 2000 字符' } };
      let valid = false;
      try {
        const parsed = new URL(url);
        valid = !/[\u0000-\u0020\u007f]/u.test(url) &&
          ((/^https?:\/\//iu.test(url) && ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname) ||
          (parsed.protocol === 'mailto:' && !!parsed.pathname));
      } catch { /* Invalid links are returned as a public field error below. */ }
      if (!valid) throw { code: 'VALIDATION_ERROR', status: 400, message: '链接必须为完整的 http、https 或 mailto URL', fields: { [`runs[${index}].url`]: '请输入有效的链接地址' } };
    }
    if (!run.text) continue;
    const previous = result.at(-1);
    if (previous && previous.bold === !!run.bold && previous.url === url) previous.text += run.text;
    else result.push({ text: run.text, bold: !!run.bold, url });
  }
  return result.flatMap(run => {
    const chunks = [];
    for (let offset = 0; offset < run.text.length; offset += 10000) chunks.push({ ...run, text: run.text.slice(offset, offset + 10000) });
    return chunks;
  });
}

/** Reads only text, bold and validated links; arbitrary DOM attributes never enter data. */
export function parseRuns(domRoot) {
  const runs = [];
  function visit(node, bold = false, url = null) {
    if (node.nodeType === 3) { runs.push({ text: node.nodeValue, bold, url }); return; }
    if (node.nodeType !== 1 && node !== domRoot) return;
    const tag = node.tagName?.toLowerCase();
    if (['script', 'style', 'iframe', 'object'].includes(tag)) return;
    if (tag === 'br') { runs.push({ text: '\n', bold, url }); return; }
    const block = node !== domRoot && ['div', 'p', 'li'].includes(tag);
    if (block && runs.length && !runs.at(-1).text.endsWith('\n')) runs.push({ text: '\n', bold, url });
    for (const child of node.childNodes) visit(child, bold || ['strong', 'b'].includes(tag), tag === 'a' ? node.getAttribute('href') : url);
  }
  visit(domRoot);
  return normalizeRuns(runs);
}

export function mountRichText(container, { value, onChange }) {
  const doc = container.ownerDocument;
  const root = doc.createElement('div'); root.className = 'rich-text';
  const toolbar = doc.createElement('div'); toolbar.className = 'rich-toolbar'; toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '文字格式');
  const editor = doc.createElement('div'); editor.className = 'rich-editor'; editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox'); editor.setAttribute('aria-multiline', 'true'); editor.setAttribute('aria-label', container.dataset.label || '描述文字');
  const error = doc.createElement('p'); error.className = 'field-error'; error.setAttribute('role', 'alert');
  const makeButton = text => { const button = doc.createElement('button'); button.type = 'button'; button.textContent = text; return button; };
  const bold = makeButton('加粗'); const link = makeButton('链接');
  const linkBox = doc.createElement('div'); linkBox.className = 'link-controls'; linkBox.hidden = true;
  const urlInput = doc.createElement('input'); urlInput.type = 'url'; urlInput.maxLength = 2000; urlInput.placeholder = 'https:// 或 mailto:'; urlInput.setAttribute('aria-label', '链接地址');
  const apply = makeButton('应用链接'); const remove = makeButton('移除链接'); const cancel = makeButton('取消');
  toolbar.append(bold, link); linkBox.append(urlInput, apply, remove, cancel); root.append(toolbar, linkBox, editor, error); container.append(root);
  let savedRange = null;
  const listeners = [];
  const listen = (target, event, handler) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
  const emit = () => { try { const runs = parseRuns(editor); error.textContent = ''; onChange(runs); } catch (cause) { error.textContent = cause.message; } };
  const remember = () => {
    const selection = doc.getSelection();
    if (selection.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) savedRange = selection.getRangeAt(0).cloneRange();
  };
  const restore = () => { if (!savedRange || !editor.contains(savedRange.commonAncestorContainer)) return false; editor.focus(); const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(savedRange); return true; };
  listen(editor, 'input', emit); listen(editor, 'keyup', remember); listen(editor, 'mouseup', remember);
  listen(editor, 'keydown', event => { if ((event.ctrlKey || event.metaKey) && ['i', 'u'].includes(event.key.toLowerCase())) event.preventDefault(); });
  listen(editor, 'beforeinput', event => { if (event.inputType.startsWith('format') && event.inputType !== 'formatBold') event.preventDefault(); });
  listen(bold, 'mousedown', event => { event.preventDefault(); remember(); });
  listen(bold, 'click', () => { if (restore()) { doc.execCommand('bold'); remember(); emit(); } });
  listen(link, 'mousedown', remember);
  listen(link, 'click', () => { linkBox.hidden = false; urlInput.focus(); });
  listen(cancel, 'click', () => { linkBox.hidden = true; restore(); });
  listen(apply, 'click', () => {
    try {
      normalizeRuns([{ text: 'link', bold: false, url: urlInput.value }]);
      if (!restore() || savedRange.collapsed) { error.textContent = '请先选中要添加链接的文字'; return; }
      const fragment = savedRange.extractContents();
      for (const oldLink of fragment.querySelectorAll('a')) oldLink.replaceWith(...oldLink.childNodes);
      const anchor = doc.createElement('a'); anchor.setAttribute('href', urlInput.value); anchor.append(fragment); savedRange.insertNode(anchor);
      savedRange.selectNodeContents(anchor); linkBox.hidden = true; emit();
    } catch (cause) { error.textContent = cause.message; }
  });
  listen(remove, 'click', () => { if (restore()) { doc.execCommand('unlink'); emit(); } linkBox.hidden = true; });
  listen(editor, 'paste', event => {
    event.preventDefault();
    const selection = doc.getSelection(); if (!selection.rangeCount || !editor.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0); range.deleteContents();
    const text = doc.createTextNode(event.clipboardData.getData('text/plain')); range.insertNode(text); range.setStartAfter(text); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range); remember(); emit();
  });
  // Drop HTML is rejected; only pasted plain text enters this limited editor.
  listen(editor, 'drop', event => event.preventDefault());
  function setValue(next) {
    editor.replaceChildren(); savedRange = null;
    for (const run of normalizeRuns(next)) {
      let node = doc.createTextNode(run.text);
      if (run.bold) { const strong = doc.createElement('strong'); strong.append(node); node = strong; }
      if (run.url) { const anchor = doc.createElement('a'); anchor.href = run.url; anchor.append(node); node = anchor; }
      editor.append(node);
    }
  }
  setValue(value);
  return { setValue, destroy() { listeners.forEach(removeListener => removeListener()); root.remove(); } };
}
