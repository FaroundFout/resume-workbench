const labels = { running: '正在编译', succeeded: '已生成', failed: '编译失败', timed_out: '编译超时', interrupted: '编译中断' };
/** Poll only the captured build ID, never a moving "latest" resource. */
export function mountPreview(container, { api, onStatus = () => {} }) {
  container.replaceChildren(); let current = null; let successful = null; let dirty = false; let timer = null; let generation = 0; let disposed = false; let networkError = null;
  let queryController = null;
  const cancelQuery = () => { queryController?.abort(); queryController = null; };
  const node = (tag, className, text = '') => { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; };
  const heading = node('div', 'preview-heading'); heading.append(node('h2', '', 'PDF 预览'));
  const download = node('a', 'download-link', '下载 PDF'); download.id = 'download-pdf'; heading.append(download);
  const status = node('p', 'build-status'); status.id = 'build-status'; status.setAttribute('role', 'status');
  const stage = node('div', 'preview-stage'); const frame = node('iframe', 'pdf-frame'); frame.id = 'pdf-preview'; frame.title = 'XeLaTeX 生成的实际简历 PDF';
  const empty = node('div', 'preview-empty'); empty.append(node('span', 'paper-corner', 'PDF'), node('h3', '', '让内容落在纸上'), node('p', '', '填写左侧模块，更新预览后查看实际 PDF。'));
  stage.append(frame, empty);
  const fallback = node('a', 'pdf-fallback', '查看器无法显示时，在新标签打开 PDF'); fallback.target = '_blank'; fallback.rel = 'noopener';
  const pages = node('p', 'preview-note'); pages.id = 'pdf-pages';
  const warnings = node('p', 'preview-note'); warnings.id = 'build-warnings';
  const logLink = node('a', 'pdf-fallback'); logLink.id = 'build-log'; logLink.target = '_blank'; logLink.rel = 'noopener';
  container.append(heading, status, pages, warnings, stage, fallback, logLink, node('p', 'preview-note', '预览与下载使用同一份编译产物。'));
  function render() {
    const available = !!successful;
    frame.hidden = !available; empty.hidden = available; download.hidden = !available; fallback.hidden = !available;
    download.setAttribute('aria-disabled', String(!available));
    if (available) {
      const url = `/api/builds/${encodeURIComponent(successful.id)}/pdf`;
      if (frame.getAttribute('src') !== url) frame.src = url;
      download.href = `${url}?download=1`; fallback.href = url;
    } else { frame.removeAttribute('src'); download.removeAttribute('href'); fallback.removeAttribute('href'); }
    const old = successful && (dirty || current?.revision !== successful.revision || current?.status !== 'succeeded');
    status.textContent = current ? `${labels[current.status]} · 修订 ${current.revision}${current.error?.message ? ` · ${current.error.message}` : ''}` : '尚未生成 PDF';
    if (old) status.textContent += ` · 当前 PDF 为旧内容（修订 ${successful.revision}）`;
    if (networkError) status.textContent += ` · ${networkError.message || '查询失败，将重试'}`;
    pages.hidden = !successful?.pages;
    pages.textContent = successful?.pages ? `当前 PDF：${successful.pages} 页${successful.pages > 1 ? ' · 多页简历，请检查每页内容；可精简文字或调整字号、间距和页边距。' : ''}` : '';
    const messages = current?.warnings || [];
    warnings.hidden = messages.length === 0;
    warnings.textContent = messages.length ? `本次编译提示：${messages.slice(0, 3).map(message => message.slice(0, 240)).join('；')}${messages.length > 3 ? `；另有 ${messages.length - 3} 条，请查看日志。` : ''}` : '';
    logLink.hidden = !current;
    if (current) {
      logLink.href = `/api/builds/${encodeURIComponent(current.id)}/log`;
      logLink.textContent = `${['failed', 'timed_out', 'interrupted'].includes(current.status) ? '查看本次失败日志' : '查看本次编译日志'}（修订 ${current.revision}）`;
    } else logLink.removeAttribute('href');
  }
  function schedule(token) {
    if (disposed || token !== generation || current?.status !== 'running') return;
    timer = setTimeout(async () => {
      timer = null;
      const controller = new AbortController(); queryController = controller;
      try {
        const result = await api.readBuild(current.id, { signal: controller.signal });
        if (disposed || token !== generation) return;
        current = result; networkError = null; if (result.status === 'succeeded') successful = result;
        render(); onStatus({ state: result.status, build: structuredClone(result) });
      } catch (error) { if (disposed || token !== generation) return; networkError = error; render(); }
      finally { if (queryController === controller) queryController = null; }
      schedule(token);
    }, 1000);
  }
  render();
  return {
    show(value) {
      if (disposed) return; generation++; cancelQuery(); if (timer !== null) clearTimeout(timer); timer = null; networkError = null;
      current = structuredClone(value); if (current?.status === 'succeeded') successful = current;
      render(); onStatus({ state: current?.status || 'idle', ...(current ? { build: structuredClone(current) } : {}) }); schedule(generation);
    },
    setDirty(value) { dirty = !!value; if (!disposed) render(); },
    destroy() { disposed = true; generation++; cancelQuery(); if (timer !== null) clearTimeout(timer); timer = null; container.replaceChildren(); },
  };
}
