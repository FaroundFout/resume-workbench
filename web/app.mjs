import { createApi } from './api.mjs';
import { mountProfile, element, button, field } from './forms/profile.mjs';
import { mountSections, SECTION_LABELS } from './forms/sections.mjs';
import { mountLayout } from './forms/layout.mjs';
import { mountLogo } from './forms/logo.mjs';
import { createSaveController } from './save-controller.mjs';
import { createEditorState } from './state.mjs';
import { mountPreview } from './preview.mjs';

const modules = { profile: ['基本信息', '01'], ...Object.fromEntries(Object.entries(SECTION_LABELS).map(([key, name], index) => [key, [name, `0${index + 2}`]])), layout: ['页面版式', '08'], logo: ['校徽设置', '09'] };

/** Forms, serial saves and fixed build previews share one page-local draft per resume. */
export function mountWorkspace(container, { api = createApi(), onDraftChange = () => {} } = {}) {
  container.replaceChildren();
  let summaries = []; let current = null; let activeModule = 'profile'; let mounted = null; let disposed = false; let opening = 0;
  const drafts = new Map(); const controllers = new Map(); const states = new Map(); const statuses = new Map();
  let preview = null; let pendingSwitch = null; let compiling = false; let compilingResumeId = null; let environment = null;
  const header = element('header', 'app-header');
  const brand = element('div', 'brand'); brand.append(element('span', 'brand-mark', 'R'), element('strong', 'wordmark', 'Resume Workbench'), element('span', 'local-tag', '简历工作台')); header.append(brand);
  const title = element('label', 'document-title'); title.append(element('span', 'sr-only', '简历名称'));
  const name = element('input'); name.type = 'text'; name.maxLength = 2000; name.placeholder = '选择或创建一份简历'; name.disabled = true; title.append(name); header.append(title);
  const language = element('span', 'language-badge', '—'); header.append(language);
  const topActions = element('div', 'top-actions');
  const save = button('保存', async () => { try { await flushCurrent(); } catch (cause) { error(cause); } }, true); save.id = 'save-button';
  const compile = button('更新预览', updatePreview, true); compile.className = 'primary'; compile.id = 'compile-button'; topActions.append(save, compile); header.append(topActions); container.append(header);
  const statusBar = element('div', 'status-bar');
  const saveStatus = element('p', 'save-status', '选择简历后自动保存'); saveStatus.id = 'save-status'; saveStatus.setAttribute('role', 'status');
  const revision = element('span', 'revision', '本机文件 · 无云端传输'); statusBar.append(saveStatus, revision); container.append(statusBar);
  const alert = element('p', 'app-error'); alert.setAttribute('role', 'alert'); alert.hidden = true; container.append(alert);
  const recovery = element('div', 'recovery-actions'); recovery.hidden = true; container.append(recovery);
  const reload = button('重新载入并放弃本页草稿', () => openResume(current.id, { discardDraft: true, reload: true }));
  const keep = button('保留本页草稿并切换', () => openResume(pendingSwitch, { keepDraft: true }));
  const discard = button('放弃本页草稿并切换', () => openResume(pendingSwitch, { discardDraft: true })); recovery.append(reload, keep, discard);
  const panes = element('div', 'workspace-grid'); container.append(panes);
  const sidebar = element('aside', 'sidebar'); sidebar.setAttribute('aria-label', '简历库与模块导航'); panes.append(sidebar);
  const libraryLabel = element('label', 'library-picker'); libraryLabel.append(element('span', 'eyebrow', '简历库'));
  const library = element('select'); library.setAttribute('aria-label', '选择简历'); libraryLabel.append(library); sidebar.append(libraryLabel);
  const libraryActions = element('div', 'library-actions');
  const create = button('＋ 新建', () => showDocumentDialog('create')); const copy = button('复制', () => showDocumentDialog('copy'), true);
  libraryActions.append(create, copy); sidebar.append(libraryActions);
  const transfer = element('div', 'transfer-actions');
  const backup = button('导出备份', exportCurrent, true); backup.id = 'backup-button';
  const importButton = button('导入备份', () => importFile.click()); importButton.id = 'import-button';
  const importFile = element('input'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.hidden = true; importFile.setAttribute('aria-label', '选择 JSON 简历备份');
  importFile.addEventListener('change', importSelected); transfer.append(backup, importButton, importFile); sidebar.append(transfer);
  const environmentStatus = element('p', 'environment-status', '正在检测 XeLaTeX…'); environmentStatus.setAttribute('role', 'status'); sidebar.append(environmentStatus);
  sidebar.append(button('环境与使用帮助', showEnvironmentHelp));
  const nav = element('nav', 'module-nav'); nav.setAttribute('aria-label', '编辑模块'); sidebar.append(nav);
  sidebar.append(element('p', 'sidebar-note', '从内容到版式，逐项完成。中文与英文各自保存，复制后可分别修改。'));
  const mobileTabs = element('div', 'mobile-tabs'); mobileTabs.setAttribute('role', 'tablist'); mobileTabs.setAttribute('aria-label', '工作区视图');
  const editTab = button('编辑', () => setPane('edit')); const previewTab = button('PDF 预览', () => setPane('preview'));
  for (const [tab, id, controls] of [[editTab, 'edit-tab', 'edit-panel'], [previewTab, 'preview-tab', 'preview-panel']]) { tab.id = id; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', controls); }
  mobileTabs.append(editTab, previewTab); panes.append(mobileTabs);
  const editPanel = element('section', 'edit-panel'); editPanel.id = 'edit-panel'; editPanel.setAttribute('aria-label', '编辑当前模块'); panes.append(editPanel);
  const moduleHeader = element('div', 'module-header'); const moduleNumber = element('span', 'eyebrow', 'MODULE 01'); const heading = element('h1', '', '基本信息'); moduleHeader.append(moduleNumber, heading); editPanel.append(moduleHeader);
  const formHost = element('div', 'form-host'); editPanel.append(formHost);
  const previewPanel = element('section', 'preview-panel'); previewPanel.id = 'preview-panel'; previewPanel.setAttribute('aria-label', '实际 PDF 预览'); panes.append(previewPanel);
  const preparation = element('p', 'build-preparation', '正在更新预览 · 等待最新保存并提交编译…'); preparation.id = 'build-preparation'; preparation.setAttribute('role', 'status'); preparation.hidden = true;
  const previewHost = element('div', 'preview-host'); previewPanel.append(preparation, previewHost);
  const dialog = element('dialog', 'document-dialog'); dialog.setAttribute('aria-label', '创建或复制简历'); container.append(dialog);

  function setPane(view) {
    panes.dataset.pane = view;
    editTab.setAttribute('aria-selected', String(view === 'edit')); previewTab.setAttribute('aria-selected', String(view === 'preview'));
    editTab.tabIndex = view === 'edit' ? 0 : -1; previewTab.tabIndex = view === 'preview' ? 0 : -1;
  }
  mobileTabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const view = event.key === 'Home' ? 'edit' : event.key === 'End' ? 'preview' : panes.dataset.pane === 'edit' ? 'preview' : 'edit'; setPane(view); (view === 'edit' ? editTab : previewTab).focus();
  });
  function error(cause) { alert.textContent = cause.message || '操作失败，请重试'; alert.hidden = false; }
  function emit() {
    if (!current) return;
    current.dirty = true; drafts.set(current.id, current);
    states.get(current.id).setDraft(current.data, { name: current.name });
    controllers.get(current.id).edit(current.data, { name: current.name }); preview?.setDirty(true);
    onDraftChange({ resumeId: current.id, name: current.name, revision: current.revision, data: structuredClone(current.data) });
  }
  function renderStatus() {
    const status = statuses.get(current?.id); const labels = { dirty: '有修改 · 停止输入后自动保存', saving: '正在保存…', saved: '已保存到本机', error: '保存失败 · 本页草稿已保留，请重试保存', conflict: '修订冲突 · 本页草稿已保留，可复制草稿或重新载入' };
    saveStatus.dataset.state = status?.state || 'saved'; saveStatus.textContent = status ? labels[status.state] : current ? labels.saved : '选择简历后自动保存';
    revision.textContent = current ? `内容修订 ${current.revision}` : '本机文件 · 无云端传输';
    recovery.hidden = !status || !['conflict', 'error'].includes(status.state); keep.hidden = discard.hidden = !pendingSwitch;
    save.disabled = !current || status?.state === 'conflict';
    compile.disabled = !current || compiling || current.latestBuild?.status === 'running' || status?.state === 'conflict' || environment?.available === false;
    backup.disabled = !current || status?.state === 'conflict';
    preparation.hidden = !compiling || current?.id !== compilingResumeId || current?.latestBuild?.status === 'running';
  }
  function attachDocument(doc) {
    drafts.set(doc.id, doc);
    if (controllers.has(doc.id)) return;
    states.set(doc.id, createEditorState(doc)); statuses.set(doc.id, { state: 'saved', revision: doc.revision });
    controllers.set(doc.id, createSaveController({ api, resumeId: doc.id, initial: doc, onStatus(status) {
      statuses.set(doc.id, status); doc.revision = status.revision; doc.dirty = status.state !== 'saved';
      if (status.state === 'saved') states.get(doc.id).applySaved(doc);
      if (disposed || current?.id !== doc.id) return;
      renderStatus(); preview?.setDirty(states.get(doc.id).read().previewDirty);
      if (status.error) error(status.error);
      else if (status.state === 'saved') { alert.hidden = true; const summary = summaries.find(item => item.id === doc.id); if (summary) { summary.name = doc.name; summary.revision = doc.revision; } renderLibrary(); }
    } }));
  }
  async function flushCurrent(doc = current) {
    if (!doc) return null;
    const saved = await controllers.get(doc.id).flush();
    states.get(doc.id).applySaved(saved); doc.revision = saved.revision; doc.updatedAt = saved.updatedAt;
    if (!disposed && current?.id === doc.id) { renderStatus(); preview?.setDirty(states.get(doc.id).read().previewDirty); }
    return saved;
  }
  async function updatePreview() {
    const doc = current; if (!doc || compiling || doc.latestBuild?.status === 'running') return;
    compiling = true; compilingResumeId = doc.id; renderStatus(); alert.hidden = true;
    try {
      const saved = await flushCurrent(doc); if (disposed) return;
      const build = await api.submitBuild(doc.id, { expectedRevision: saved.revision }); if (disposed) return;
      doc.latestBuild = build; states.get(doc.id).applyBuild(build);
      if (current?.id === doc.id) { preview.show(build); preview.setDirty(states.get(doc.id).read().previewDirty); }
    } catch (cause) { if (!disposed) error(cause); }
    finally { compiling = false; compilingResumeId = null; if (!disposed) renderStatus(); }
  }
  async function exportCurrent() {
    const doc = current; if (!doc) return;
    try {
      await flushCurrent(doc); if (disposed) return;
      // Same-origin attachment keeps the strict CSP and avoids browser-specific blob navigation.
      const link = element('a'); link.href = `/api/resumes/${encodeURIComponent(doc.id)}/backup`; link.download = `resume-${doc.id}.json`; link.click();
    } catch (cause) { if (!disposed) error(cause); }
  }
  async function importSelected() {
    const file = importFile.files?.[0]; importFile.value = ''; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { error({ message: '备份文件不能超过 10 MiB' }); return; }
    importButton.disabled = true;
    try {
      await flushCurrent(); if (disposed) return;
      const doc = await api.importBackup(file); if (disposed) return;
      summaries = await api.list(); if (disposed) return;
      attachDocument(doc); await openResume(doc.id);
    } catch (cause) { if (!disposed) error(cause); }
    finally { if (!disposed) importButton.disabled = false; }
  }
  name.addEventListener('input', () => { if (current) { current.name = name.value; emit(); } });
  function renderLibrary() {
    library.replaceChildren();
    if (!summaries.length) { const option = element('option', '', '尚无简历'); option.value = ''; library.append(option); }
    for (const summary of summaries) { const option = element('option', '', `${summary.name} · ${summary.language === 'en' ? 'EN' : '中文'}`); option.value = summary.id; library.append(option); }
    library.value = current?.id || summaries[0]?.id || ''; library.disabled = !summaries.length;
  }
  function renderNav() {
    nav.replaceChildren();
    const order = current ? ['profile', ...current.data.sectionOrder, 'layout', 'logo'] : Object.keys(modules);
    for (const key of order) {
      const [label, number] = modules[key]; const node = button('', () => { activeModule = key; renderModule(); renderNav(); });
      node.append(element('span', 'nav-number', number), element('span', 'nav-label', label)); node.disabled = !current;
      if (current?.data.sections[key] && !current.data.sections[key].enabled) node.append(element('span', 'hidden-tag', '隐藏'));
      if (key === activeModule) node.setAttribute('aria-current', 'step'); nav.append(node);
    }
  }
  function renderModule() {
    mounted?.destroy(); mounted = null; formHost.replaceChildren();
    const [label, number] = modules[activeModule]; heading.textContent = label; moduleNumber.textContent = `MODULE ${number}`;
    if (!current) { formHost.append(element('p', 'empty-note', '新建一份中文或英文简历，即可开始。')); return; }
    const onChange = data => { current.data = data; emit(); renderNav(); };
    const options = { data: current.data, onChange, api, resumeId: current.id };
    if (activeModule === 'profile') mounted = mountProfile(formHost, options);
    else if (activeModule === 'layout') mounted = mountLayout(formHost, options);
    else if (activeModule === 'logo') mounted = mountLogo(formHost, options);
    else mounted = mountSections(formHost, { ...options, sectionKey: activeModule });
  }
  function renderDocument() {
    name.value = current?.name || ''; name.disabled = !current; copy.disabled = !current; language.textContent = current ? current.data.language === 'en' ? 'EN · 英文' : '中文' : '—';
    preview?.destroy();
    const doc = current;
    preview = mountPreview(previewHost, { api, onStatus({ build }) {
      if (!doc || !build || disposed) return;
      doc.latestBuild = build; states.get(doc.id).applyBuild(build);
      if (current?.id === doc.id) { preview?.setDirty(states.get(doc.id).read().previewDirty); renderStatus(); }
    } });
    const state = doc && states.get(doc.id).read();
    if (state?.pdfBuild) preview.show(state.pdfBuild);
    preview.show(state?.build || null); preview.setDirty(state?.previewDirty || false); renderStatus();
    renderLibrary(); renderNav(); renderModule();
  }
  async function openResume(id, { keepDraft = false, discardDraft = false, reload: reread = false } = {}) {
    if (!id || disposed) return false;
    const token = ++opening;
    try {
      if (current && !keepDraft && !discardDraft) await flushCurrent();
      if (disposed || token !== opening) return false;
      // Read before discarding, so a failed service request cannot silently erase the draft.
      const doc = reread || !drafts.has(id) ? await api.read(id) : drafts.get(id);
      if (disposed || token !== opening) return false;
      if (discardDraft && current) { const old = current.id; controllers.get(old)?.destroy(); controllers.delete(old); states.delete(old); statuses.delete(old); drafts.delete(old); }
      attachDocument(doc); current = doc; pendingSwitch = null; alert.hidden = true; renderDocument(); return true;
    } catch (cause) { if (!disposed && token === opening) { pendingSwitch = id !== current?.id ? id : null; error(cause); renderStatus(); renderLibrary(); } return false; }
  }
  library.addEventListener('change', () => openResume(library.value));
  function showDocumentDialog(mode) {
    dialog.setAttribute('aria-label', '创建或复制简历');
    dialog.replaceChildren(); const form = element('form'); const heading = element('h2', '', mode === 'copy' ? '复制为独立简历' : '创建一份简历'); form.append(heading);
    form.append(element('p', 'muted', mode === 'copy' ? '复制当前内容和校徽，选择语言后独立修改。' : '选择内容语言。中文自动使用 A4，英文自动使用 Letter。'));
    let documentName = mode === 'copy' ? `${current.name} · 副本` : '我的简历'; let documentLanguage = mode === 'copy' ? current.data.language === 'en' ? 'zh-CN' : 'en' : 'zh-CN';
    const nameInput = field(form, '简历名称', documentName, value => { documentName = value; }); nameInput.required = true;
    field(form, '简历语言', documentLanguage, value => { documentLanguage = value; }, { options: [['zh-CN', '中文 · A4'], ['en', 'English · Letter']] });
    const failure = element('p', 'field-error'); failure.setAttribute('role', 'alert'); form.append(failure);
    const actions = element('div', 'dialog-actions'); actions.append(button('取消', () => dialog.close())); const submit = element('button', 'primary', mode === 'copy' ? '创建副本' : '开始编辑'); submit.type = 'submit'; actions.append(submit); form.append(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!documentName.trim()) { failure.textContent = '请填写简历名称'; return; } submit.disabled = true;
      try {
        const source = current; const conflictCopy = mode === 'copy' && statuses.get(source.id)?.state === 'conflict';
        if (!conflictCopy) await flushCurrent(source); if (disposed) return;
        const doc = mode === 'copy' ? await api.copy(source.id, { name: documentName, language: documentLanguage, draft: controllers.get(source.id).readDraft() }) : await api.create({ name: documentName, language: documentLanguage });
        if (disposed) return; summaries = await api.list(); if (disposed) return;
        attachDocument(doc); current = doc; ++opening; pendingSwitch = null; activeModule = 'profile'; alert.hidden = true; dialog.close(); renderDocument();
      } catch (cause) { failure.textContent = cause.message || '创建失败，请重试'; } finally { submit.disabled = false; }
    });
    dialog.append(form); dialog.showModal(); nameInput.focus(); nameInput.select();
  }
  function showEnvironmentHelp() {
    dialog.replaceChildren(); dialog.setAttribute('aria-label', '环境与使用帮助');
    dialog.append(element('h2', '', '环境与使用帮助'));
    for (const text of [
      'Windows 首次运行 setup.cmd，再运行 start.cmd。setup 首次需要联网，自动准备 .runtime/node 中的项目专用 Node，无需管理员权限或预装系统 Node，也不会修改系统 PATH。Linux/macOS 需要手动安装 Node.js 22 或更新版本。',
      '生成 PDF 还需要安装包含 XeLaTeX 的 MiKTeX 或 TeX Live；未找到编译器时，仍可编辑、保存和备份。找到 XeLaTeX 只确认编译器身份，首次 PDF 编译才验证宏包是否齐全；setup 不安装编译器或宏包，MiKTeX 官方入口为 https://miktex.org/download。',
      '启动时会检测已有编译器。若已安装却未找到，请把 config.example.json 复制为项目根目录的 config.local.json，设置 xelatexPath 为完整的 xelatex.exe（其他系统为 xelatex）路径，再重新启动服务。Windows JSON 路径建议使用正斜杠。',
      '如果编译日志提示缺少 .sty 宏包，请通过发行版管理工具手动补齐，或安装完整发行版后重试。本程序不会自动安装宏包。',
      '内容停止输入后约 800ms 自动保存；更新预览需要手动点击，按钮会等待最新内容保存。编译失败时保留上次成功 PDF，下载前检查修订提示。',
      '中文与英文各自保存。复制为另一种语言只更换模板与自动纸张，内容需要手动翻译；自动纸张为中文 A4、英文 Letter。',
      '校徽可使用默认图片、隐藏或上传 PNG/JPG（最大 5MiB）；宽度 1.2–3.2cm，高度最多 3.2cm。导出备份包含内容、版式和校徽，换机后用导入备份恢复。详细说明见项目 docs/local-editor.md。',
    ]) dialog.append(element('p', 'muted', text));
    const close = button('知道了', () => dialog.close()); dialog.append(close); dialog.showModal(); close.focus();
  }
  async function start() {
    try { summaries = await api.list(); if (disposed) return; renderLibrary(); if (summaries.length) await openResume(summaries[0].id); }
    catch (cause) { if (!disposed) error(cause); }
  }
  if (api.environment) api.environment().then(value => { if (!disposed) { environment = value; environmentStatus.textContent = value.available ? 'XeLaTeX 可用' : value.message; renderStatus(); } }).catch(cause => { if (!disposed) environmentStatus.textContent = cause.message || '编译环境暂时无法查询'; });
  else environmentStatus.textContent = '编译环境由本地服务检测';
  setPane('edit'); renderDocument(); start();
  return { openResume, getDraft() { return current ? structuredClone({ resumeId: current.id, name: current.name, revision: current.revision, data: current.data }) : null; }, destroy() { disposed = true; ++opening; mounted?.destroy(); preview?.destroy(); for (const controller of controllers.values()) controller.destroy(); if (dialog.open) dialog.close(); container.replaceChildren(); } };
}

const workspace = document.getElementById('workspace');
if (workspace) mountWorkspace(workspace);
