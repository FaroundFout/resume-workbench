import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom.mjs';
import { createEmptyData } from '../web/shared/model.mjs';

test('missing compiler has an accessible help entry that explains setup while editing remains available', async t => {
  const host = installDom(t);
  const { mountWorkspace } = await import('../web/app.mjs');
  const workspace = mountWorkspace(host, { api: {
    list: async () => [], environment: async () => ({ available: false, message: '未找到 XeLaTeX' }),
  } });
  t.after(() => workspace.destroy());
  await new Promise(resolve => setImmediate(resolve));
  const help = host.all().find(node => node.tagName === 'button' && node.textContent === '环境与使用帮助');
  assert.ok(help, 'environment help must be reachable from the workspace');
  assert.equal(help.disabled, false); await help.click();
  const dialog = host.all().find(node => node.tagName === 'dialog'); assert.equal(dialog.open, true);
  const content = dialog.all().map(node => node.textContent || '').join(' ');
  assert.match(content, /MiKTeX/); assert.match(content, /TeX Live/);
  assert.match(content, /setup\.cmd/); assert.match(content, /start\.cmd/); assert.match(content, /\.runtime\/node/);
  assert.match(content, /Linux\/macOS/); assert.match(content, /首次.*联网/);
  assert.match(content, /config.local.json/); assert.match(content, /xelatexPath/);
  assert.match(content, /重新启动/); assert.match(content, /保存和备份/); assert.match(content, /宏包/);
  assert.match(content, /手动翻译/); assert.match(content, /更新预览/);
  const close = dialog.all().find(node => node.tagName === 'button' && node.textContent === '知道了');
  await close.click(); assert.equal(dialog.open, false);
});

test('finding a compiler without PDF verification does not display a ready claim', async t => {
  const host = installDom(t);
  const { mountWorkspace } = await import('../web/app.mjs');
  const workspace = mountWorkspace(host, { api: { list: async () => [],
    environment: async () => ({ available: true, editorReady: true, pdfReady: false,
      state: 'missing-packages', message: '缺少宏包，请运行 repair.cmd 后重新启动。', checks: [], task: null }) } });
  t.after(() => workspace.destroy());
  await new Promise(resolve => setImmediate(resolve));
  const status = host.all().find(node => node.className === 'environment-status');
  assert.match(status.textContent, /repair\.cmd/);
  assert.doesNotMatch(status.textContent, /XeLaTeX 可用|PDF 已就绪/);
});

test('recheck polls actual phases then shows ready without restarting the editor', async t => {
  const host = installDom(t);
  const { mountWorkspace } = await import('../web/app.mjs');
  let checking = false; let polls = 0;
  const workspace = mountWorkspace(host, { environmentPollMs: 1, api: { list: async () => [],
    checkEnvironment: async () => { checking = true; return { state: 'checking', task: { id: 'check-1', phase: 'inspect', status: 'running' } }; },
    environment: async () => !checking ? { editorReady: true, pdfReady: false, state: 'missing-packages', checks: [] }
      : ++polls === 1 ? { editorReady: true, pdfReady: false, state: 'checking', task: { id: 'check-1', phase: 'pdf-zh-CN', status: 'running' }, checks: [] }
        : { editorReady: true, pdfReady: true, state: 'ready', task: { id: 'check-1', phase: 'complete', status: 'succeeded' }, checks: [] },
  } });
  t.after(() => workspace.destroy());
  await new Promise(resolve => setImmediate(resolve));
  const check = host.all().find(node => node.tagName === 'button' && node.textContent === '重新检测环境');
  assert.ok(check); await check.click();
  for (let i = 0; i < 30 && polls < 2; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const status = host.all().find(node => node.className === 'environment-status');
  assert.match(status.textContent, /中文、英文.*通过/); assert.equal(check.disabled, false);
});

test('recheck failures show fixed repair guidance and remain retryable', async t => {
  const host = installDom(t);
  const { mountWorkspace } = await import('../web/app.mjs');
  const workspace = mountWorkspace(host, { api: { list: async () => [],
    environment: async () => ({ editorReady: true, pdfReady: false, state: 'verification-failed',
      checks: [{ id: 'format', status: 'failed', code: 'TEX_FORMAT_OUTDATED', message: '当前 LaTeX 格式过旧' }] }),
    checkEnvironment: async () => { throw { code: 'ENVIRONMENT_BUSY', message: '所选环境正在编译，请稍后重试' }; },
  } });
  t.after(() => workspace.destroy());
  await new Promise(resolve => setImmediate(resolve));
  const content = host.all().map(node => node.textContent || '').join(' ');
  assert.match(content, /repair\.cmd --update/);
  const check = host.all().find(node => node.textContent === '重新检测环境'); await check.click();
  assert.equal(check.disabled, false);
  assert.match(host.all().find(node => node.className === 'environment-status').textContent, /稍后重试/);
});

test('missing PDF environment disables preview but editing and saving remain available', async t => {
  const host = installDom(t);
  const { mountWorkspace } = await import('../web/app.mjs');
  let saved = null;
  const doc = { id: 'test-document', name: '虚构示例', revision: 0, data: createEmptyData('en'), latestBuild: null };
  const workspace = mountWorkspace(host, { api: { list: async () => [doc], read: async () => structuredClone(doc),
    save: async (_id, payload) => { saved = payload; return { ...doc, ...payload, revision: 1 }; },
    environment: async () => ({ editorReady: true, pdfReady: false, available: true, state: 'missing-packages', checks: [] }),
  } });
  t.after(() => workspace.destroy());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.all().find(node => node.id === 'compile-button').disabled, true);
  const save = host.all().find(node => node.id === 'save-button'); assert.equal(save.disabled, false);
  const title = host.all().find(node => node.tagName === 'input' && node.maxLength === 2000);
  assert.equal(title.disabled, false); title.value = '改名后仍能保存'; await title.fire('input'); await save.click();
  assert.equal(saved.name, '改名后仍能保存');
  assert.equal(host.all().find(node => node.id === 'backup-button').disabled, false);
});
