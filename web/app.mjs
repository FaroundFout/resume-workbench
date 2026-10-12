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
export function mountWorkspace(container, { api = createApi(), onDraftChange = () => {}, environmentPollMs = 700 } = {}) {
  container.replaceChildren();
  let summaries = []; let current = null; let activeModule = 'profile'; let mounted = null; let disposed = false; let opening = 0;
  const drafts = new Map(); const controllers = new Map(); const states = new Map(); const statuses = new Map();
  let preview = null; let pendingSwitch = null; let compiling = false; let compilingResumeId = null; let deleting = false; let importing = false; let creating = false; let environment = null;
  let environmentTimer = null; let environmentRequest = 0; let environmentSubmitting = false;
  const libraryBusy = () => deleting || importing || creating;
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
  const remove = button('删除', showDeleteDialog, true); remove.id = 'delete-button'; remove.className = 'danger'; remove.setAttribute('aria-label', '删除当前简历');
  libraryActions.append(create, copy, remove); sidebar.append(libraryActions);
  const transfer = element('div', 'transfer-actions');
  const backup = button('导出备份', exportCurrent, true); backup.id = 'backup-button';
  const importButton = button('导入备份', () => importFile.click()); importButton.id = 'import-button';
  const importFile = element('input'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.hidden = true; importFile.setAttribute('aria-label', '选择 JSON 简历备份');
  importFile.addEventListener('change', importSelected); transfer.append(backup, importButton, importFile); sidebar.append(transfer);
  const environmentStatus = element('p', 'environment-status', '正在检测 XeLaTeX…'); environmentStatus.setAttribute('role', 'status'); sidebar.append(environmentStatus);
  const recheck = button('重新检测环境', recheckEnvironment); recheck.id = 'environment-check-button'; sidebar.append(recheck);
  const environmentDetails = element('details', 'environment-status');
  const environmentSteps = element('ul'); environmentDetails.append(element('summary', '', '检测步骤'), environmentSteps);
  environmentDetails.hidden = true; sidebar.append(environmentDetails);
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
  dialog.addEventListener('cancel', event => { if (deleting || creating) event.preventDefault(); });

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
    if (!current || deleting) return;
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
    save.disabled = !current || deleting || status?.state === 'conflict';
    compile.disabled = !current || deleting || compiling || current.latestBuild?.status === 'running' || status?.state === 'conflict' || environment?.available === false || environment?.pdfReady === false;
    backup.disabled = !current || deleting || status?.state === 'conflict';
    remove.disabled = !current || libraryBusy() || (compiling && compilingResumeId === current.id) || current.latestBuild?.status === 'running' || status?.state === 'conflict';
    create.disabled = importButton.disabled = libraryBusy(); copy.disabled = !current || libraryBusy();
    name.disabled = !current || deleting; library.disabled = !summaries.length || libraryBusy(); formHost.inert = deleting;
    for (const item of nav.children) item.disabled = !current || deleting;
    preparation.hidden = !compiling || current?.id !== compilingResumeId || current?.latestBuild?.status === 'running';
    recheck.disabled = environmentSubmitting || environment?.task?.status === 'running' || !api.checkEnvironment;
  }
  function renderEnvironment(value) {
    environment = value;
    const messages = {
      'missing-compiler': '未找到可用的 XeLaTeX，请运行 setup.cmd 或检查编译器配置。简历仍可编辑、保存和备份。',
      'missing-packages': 'PDF 宏包不完整，请在项目目录运行 repair.cmd，完成后点击“重新检测环境”。简历仍可编辑、保存和备份。',
      'missing-resources': '字体、模板或图片缺失，请恢复完整项目后重新检测。简历仍可编辑、保存和备份。',
      'verification-required': 'PDF 环境待验收，请点击“重新检测环境”。简历仍可编辑、保存和备份。',
      'verification-failed': 'PDF 环境验收失败，请查看检测步骤；运行 doctor.cmd 查看诊断，按提示运行 repair.cmd 后重新检测。简历仍可编辑、保存和备份。',
    };
    const phases = { inspect: '检查编译器、宏包与项目资源', 'acquire-lease': '等待所选环境的验收租约',
      'pdf-zh-CN': '编译中文样例', 'pdf-en': '编译英文样例', verify: '验收中英文样例' };
    environmentStatus.textContent = value.task?.status === 'running'
      ? `正在检测 PDF 环境 · ${phases[value.task.phase] || '正在验收'}…`
      : value.pdfReady && value.state === 'ready' ? 'PDF 已就绪，中文、英文样例编译通过。'
        : messages[value.state] || value.message || 'PDF 环境待验收，请重新检测。';
    if (value.task?.status === 'cancelled') environmentStatus.textContent += ' 本次检测已取消，可重新检测。';
    if (value.checks?.some(item => item.code === 'TEX_FORMAT_OUTDATED')) environmentStatus.textContent += ' 版本过旧时请运行 repair.cmd --update，更新后重新检测。';
    environmentSteps.replaceChildren();
    for (const item of value.checks || []) environmentSteps.append(element('li', '', `${item.status === 'passed' ? '通过' : item.status === 'pending' ? '待检查' : '未通过'} · ${item.message} [${item.code}]`));
    environmentDetails.hidden = !environmentSteps.children.length;
    renderStatus();
  }
  function scheduleEnvironmentPoll() {
    clearTimeout(environmentTimer);
    if (!disposed && api.environment) environmentTimer = setTimeout(refreshEnvironment,
      environment?.task?.status === 'running' ? environmentPollMs : 15000);
  }
  async function refreshEnvironment() {
    if (disposed || !api.environment || environmentSubmitting) return;
    const request = ++environmentRequest;
    try { const value = await api.environment(); if (!disposed && request === environmentRequest) renderEnvironment(value); }
    catch (cause) { if (!disposed && request === environmentRequest) environmentStatus.textContent = cause.message || '编译环境暂时无法查询，请重新检测'; }
    finally { if (!disposed && request === environmentRequest) scheduleEnvironmentPoll(); }
  }
  async function recheckEnvironment() {
    if (disposed || environmentSubmitting || !api.checkEnvironment) return;
    clearTimeout(environmentTimer); const request = ++environmentRequest;
    environmentSubmitting = true; renderStatus();
    try {
      const started = await api.checkEnvironment(); if (disposed || request !== environmentRequest) return;
      renderEnvironment({ ...environment, ...started });
    } catch (cause) { if (!disposed && request === environmentRequest) environmentStatus.textContent = cause.message || '环境检测未启动，请稍后重试'; }
    finally { environmentSubmitting = false; if (!disposed && request === environmentRequest) { renderStatus(); scheduleEnvironmentPoll(); } }
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
    const doc = current; if (!doc || deleting || compiling || doc.latestBuild?.status === 'running') return;
    compiling = true; compilingResumeId = doc.id; renderStatus(); alert.hidden = true;
    try {
      const saved = await flushCurrent(doc); if (disposed) return;
      const build = await api.submitBuild(doc.id, { expectedRevision: saved.revision }); if (disposed) return;
      doc.latestBuild = build; states.get(doc.id).applyBuild(build);
      if (current?.id === doc.id) { preview.show(build); preview.setDirty(states.get(doc.id).read().previewDirty); }
    } catch (cause) { if (!disposed) error(cause); }
    finally { compiling = false; compilingResumeId = null; if (!disposed) { renderStatus(); refreshEnvironment(); } }
  }
  async function exportCurrent() {
    const doc = current; if (!doc || deleting) return;
    try {
      await flushCurrent(doc); if (disposed) return;
      // Same-origin attachment keeps the strict CSP and avoids browser-specific blob navigation.
      const link = element('a'); link.href = `/api/resumes/${encodeURIComponent(doc.id)}/backup`; link.download = `resume-${doc.id}.json`; link.click();
    } catch (cause) { if (!disposed) error(cause); }
  }
  async function importSelected() {
    if (libraryBusy()) return;
    const file = importFile.files?.[0]; importFile.value = ''; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { error({ message: '备份文件不能超过 10 MiB' }); return; }
    importing = true; renderStatus();
    try {
      await flushCurrent(); if (disposed) return;
      const doc = await api.importBackup(file); if (disposed) return;
      summaries = await api.list(); if (disposed) return;
      attachDocument(doc); await openResume(doc.id);
    } catch (cause) { if (!disposed) error(cause); }
    finally { importing = false; if (!disposed) renderStatus(); }
  }
  name.addEventListener('input', () => { if (current) { current.name = name.value; emit(); } });
  function renderLibrary() {
    library.replaceChildren();
    if (!summaries.length) { const option = element('option', '', '尚无简历'); option.value = ''; library.append(option); }
    for (const summary of summaries) { const option = element('option', '', `${summary.name} · ${summary.language === 'en' ? 'EN' : '中文'}`); option.value = summary.id; library.append(option); }
    library.value = current?.id || summaries[0]?.id || ''; library.disabled = !summaries.length || libraryBusy();
  }
  function renderNav() {
    nav.replaceChildren();
    const order = current ? ['profile', ...current.data.sectionOrder, 'layout', 'logo'] : Object.keys(modules);
    for (const key of order) {
      const [label, number] = modules[key]; const node = button('', () => { activeModule = key; renderModule(); renderNav(); });
      node.append(element('span', 'nav-number', number), element('span', 'nav-label', label)); node.disabled = !current || deleting;
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
      if (build.status !== 'running') refreshEnvironment();
    } });
    const state = doc && states.get(doc.id).read();
    if (state?.pdfBuild) preview.show(state.pdfBuild);
    preview.show(state?.build || null); preview.setDirty(state?.previewDirty || false); renderStatus();
    renderLibrary(); renderNav(); renderModule();
  }
  async function openResume(id, { keepDraft = false, discardDraft = false, reload: reread = false } = {}) {
    if (!id || disposed || deleting || creating) return false;
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
  function showDeleteDialog() {
    if (!current || remove.disabled) return;
    const doc = current;
    dialog.replaceChildren(); dialog.setAttribute('aria-label', '删除当前简历');
    const form = element('form'); form.append(element('h2', '', '删除这份简历？'));
    form.append(element('p', 'muted', `将删除“${doc.name}”的内容、上传图片及 PDF 编译记录，未保存的修改也会丢弃。此操作无法撤销，需要保留时请先取消并导出备份。`));
    const failure = element('p', 'field-error'); failure.setAttribute('role', 'alert'); form.append(failure);
    const actions = element('div', 'dialog-actions'); const cancel = button('取消', () => dialog.close());
    const submit = element('button', 'danger', '确认删除'); submit.type = 'submit'; actions.append(cancel, submit); form.append(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (deleting || disposed || current?.id !== doc.id) return;
      deleting = true; ++opening; cancel.disabled = submit.disabled = true; failure.textContent = ''; renderStatus();
      try {
        const saved = await controllers.get(doc.id).pause(); if (disposed) return;
        await api.remove(doc.id, { expectedRevision: saved.revision }); if (disposed) return;
        controllers.get(doc.id).destroy(); controllers.delete(doc.id); states.delete(doc.id); statuses.delete(doc.id); drafts.delete(doc.id);
        summaries = summaries.filter(item => item.id !== doc.id); current = null; pendingSwitch = null; activeModule = 'profile'; alert.hidden = true;
        dialog.close(); deleting = false; renderDocument();
        if (summaries.length) await openResume(summaries[0].id);
      } catch (cause) {
        if (!disposed) { failure.textContent = cause.message || '删除失败，简历和本页草稿已保留，请重试'; controllers.get(doc.id)?.resume(cause); }
      } finally {
        deleting = false; cancel.disabled = submit.disabled = false;
        if (!disposed) { renderStatus(); renderLibrary(); }
      }
    });
    dialog.append(form); dialog.showModal(); cancel.focus();
  }
  function showDocumentDialog(mode) {
    if (libraryBusy()) return;
    dialog.setAttribute('aria-label', '创建或复制简历');
    dialog.replaceChildren(); const form = element('form'); const heading = element('h2', '', mode === 'copy' ? '复制为独立简历' : '创建一份简历'); form.append(heading);
    form.append(element('p', 'muted', mode === 'copy' ? '复制当前内容和校徽，选择语言后独立修改。' : '选择内容语言。中文自动使用 A4，英文自动使用 Letter。'));
    let documentName = mode === 'copy' ? `${current.name} · 副本` : '我的简历'; let documentLanguage = mode === 'copy' ? current.data.language === 'en' ? 'zh-CN' : 'en' : 'zh-CN';
    const nameInput = field(form, '简历名称', documentName, value => { documentName = value; }); nameInput.required = true;
    field(form, '简历语言', documentLanguage, value => { documentLanguage = value; }, { options: [['zh-CN', '中文 · A4'], ['en', 'English · Letter']] });
    const failure = element('p', 'field-error'); failure.setAttribute('role', 'alert'); form.append(failure);
    const actions = element('div', 'dialog-actions'); const cancel = button('取消', () => { if (!creating) dialog.close(); }); actions.append(cancel); const submit = element('button', 'primary', mode === 'copy' ? '创建副本' : '开始编辑'); submit.type = 'submit'; actions.append(submit); form.append(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (libraryBusy()) return; if (!documentName.trim()) { failure.textContent = '请填写简历名称'; return; }
      creating = true; cancel.disabled = submit.disabled = true; renderStatus();
      try {
        const source = current; const conflictCopy = mode === 'copy' && statuses.get(source.id)?.state === 'conflict';
        if (!conflictCopy) await flushCurrent(source); if (disposed) return;
        const doc = mode === 'copy' ? await api.copy(source.id, { name: documentName, language: documentLanguage, draft: controllers.get(source.id).readDraft() }) : await api.create({ name: documentName, language: documentLanguage });
        if (disposed) return; summaries = await api.list(); if (disposed) return;
        attachDocument(doc); current = doc; ++opening; pendingSwitch = null; activeModule = 'profile'; alert.hidden = true; dialog.close(); renderDocument();
      } catch (cause) { failure.textContent = cause.message || '创建失败，请重试'; } finally { creating = false; cancel.disabled = submit.disabled = false; if (!disposed) renderStatus(); }
    });
    dialog.append(form); dialog.showModal(); nameInput.focus(); nameInput.select();
  }
  function showEnvironmentHelp() {
    dialog.replaceChildren(); dialog.setAttribute('aria-label', '环境与使用帮助');
    dialog.append(element('h2', '', '环境与使用帮助'));
    for (const text of [
      'Windows 首次运行 setup.cmd，再运行 start.cmd。setup 首次需要联网，自动准备 .runtime/node 中的项目专用 Node，无需管理员权限或预装系统 Node，也不会修改系统 PATH。Linux/macOS 需要手动安装 Node.js 22 或更新版本。',
      '生成 PDF 需要包含 XeLaTeX 的 MiKTeX 或 TeX Live。setup 会检查项目字体、模板和宏包，为已有 MiKTeX 补齐已知缺包；没有编译器时，Windows 11 x64 可尝试准备项目私有 MiKTeX。中文和英文样例实际编译通过才报告完整安装成功。其他平台需人工安装，MiKTeX 官方入口为 https://miktex.org/download。',
      '启动时会检测已有编译器。若已安装却未找到，请把 config.example.json 复制为项目根目录的 config.local.json，设置 xelatexPath 为完整的 xelatex.exe（其他系统为 xelatex）路径，再重新启动服务。Windows JSON 路径建议使用正斜杠。',
      '运行 doctor.cmd 可只验收、不安装宏包；运行 repair.cmd 可补齐已有 MiKTeX 的已知依赖并重新验收；旧格式或版本问题可运行 repair.cmd --update。TeX Live 缺包需人工补齐。完成后点击“重新检测环境”，中文和英文样例编译通过后可更新预览。编译或修复期间报忙时，请完成后再重试。setup.cmd --editor-only 只准备编辑环境，PDF 未准备时仍可编辑、保存和备份。',
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
  if (api.environment) refreshEnvironment();
  else environmentStatus.textContent = '编译环境由本地服务检测';
  setPane('edit'); renderDocument(); start();
  return { openResume, getDraft() { return current ? structuredClone({ resumeId: current.id, name: current.name, revision: current.revision, data: current.data }) : null; }, destroy() { disposed = true; ++opening; ++environmentRequest; clearTimeout(environmentTimer); mounted?.destroy(); preview?.destroy(); for (const controller of controllers.values()) controller.destroy(); if (dialog.open) dialog.close(); container.replaceChildren(); } };
}

const workspace = document.getElementById('workspace');
if (workspace) mountWorkspace(workspace);
