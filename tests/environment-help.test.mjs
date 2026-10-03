import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom.mjs';

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
  assert.match(content, /config.local.json/); assert.match(content, /xelatexPath/);
  assert.match(content, /重新启动/); assert.match(content, /保存和备份/); assert.match(content, /宏包/);
  assert.match(content, /手动翻译/); assert.match(content, /更新预览/);
  const close = dialog.all().find(node => node.tagName === 'button' && node.textContent === '知道了');
  await close.click(); assert.equal(dialog.open, false);
});
