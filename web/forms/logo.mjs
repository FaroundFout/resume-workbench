import { element, button, field } from './profile.mjs';

export function mountLogo(container, { data, onChange, api, resumeId }) {
  let current = data; let destroyed = false; let uploading = false; let message = '';
  const publish = logo => { current = { ...current, logo }; onChange(current); };
  function render() {
    container.replaceChildren();
    container.append(element('p', 'module-intro', '使用默认校徽、自定义图片，或隐藏校徽。隐藏会保留上传图片，恢复时无需重新上传。'));
    const modes = field(container, '校徽模式', current.logo.mode, mode => {
      if (mode === 'custom' && !current.logo.assetId) { message = '请先选择并上传 PNG / JPG 图片'; render(); return; }
      publish({ ...current.logo, mode, assetId: mode === 'default' ? null : current.logo.assetId }); message = ''; render();
    }, { options: [['default', '默认校徽'], ['custom', '自定义图片'], ['hidden', '隐藏校徽']] }); modes.disabled = uploading;
    const preview = element('div', 'logo-preview');
    let fit = () => {};
    if (current.logo.mode === 'hidden') preview.append(element('p', 'muted', '校徽已隐藏'));
    else {
      const image = element('img'); image.alt = current.logo.mode === 'default' ? '默认校徽缩略图' : '自定义校徽缩略图';
      image.src = current.logo.mode === 'default' ? '/assets/default-logo.png' : `/api/resumes/${encodeURIComponent(resumeId)}/assets/${encodeURIComponent(current.logo.assetId)}`;
      fit = () => {
        if (!image.naturalWidth || !image.naturalHeight) return;
        const scale = Math.min(current.logo.widthCm * 37.8 / image.naturalWidth, 3.2 * 37.8 / image.naturalHeight);
        image.width = Math.round(image.naturalWidth * scale); image.height = Math.round(image.naturalHeight * scale);
      };
      image.addEventListener('load', fit); image.addEventListener('error', () => { message = '校徽缩略图无法读取，请重新上传或恢复默认'; status.textContent = message; });
      preview.append(image);
    }
    const width = field(container, '校徽宽度 · cm', current.logo.widthCm, value => {
      publish({ ...current.logo, widthCm: Number(value) }); readout.textContent = `${Number(value).toFixed(1)} cm`; fit();
    }, { type: 'range', min: 1.2, max: 3.2, step: 0.1 }); width.disabled = uploading;
    const readout = element('output', 'dimension-readout', `${current.logo.widthCm.toFixed(1)} cm`); container.append(readout);
    container.append(preview, element('p', 'muted', '宽度 1.2–3.2 cm，等比例缩放，最大高度 3.2 cm。'));
    const uploadLabel = element('label', 'field'); uploadLabel.append(element('span', 'field-label', '上传校徽 · PNG / JPG'));
    const upload = element('input'); upload.type = 'file'; upload.accept = 'image/png,image/jpeg,.png,.jpg,.jpeg'; upload.disabled = uploading || !resumeId;
    upload.addEventListener('change', async () => {
      const file = upload.files[0]; if (!file) return;
      if (!['image/png', 'image/jpeg'].includes(file.type)) { message = '只支持 PNG 或 JPG 图片'; render(); return; }
      if (file.size > 5 * 1024 * 1024) { message = '图片不得超过 5 MiB'; render(); return; }
      uploading = true; message = '正在上传校徽…'; render();
      try {
        const asset = await api.uploadAsset(resumeId, file);
        if (destroyed) return;
        publish({ ...current.logo, mode: 'custom', assetId: asset.id }); message = '校徽已上传；图片引用作为草稿修改。';
      } catch (error) { if (!destroyed) message = error.message || '校徽上传失败'; }
      finally { uploading = false; if (!destroyed) render(); }
    });
    uploadLabel.append(upload); container.append(uploadLabel, element('p', 'muted', '单张图片最大 5 MiB。图片会保存在这份简历自己的素材目录中。'));
    const actions = element('div', 'logo-actions');
    actions.append(button('恢复默认校徽', () => { publish({ mode: 'default', assetId: null, widthCm: 2.4 }); message = ''; render(); }, uploading));
    if (current.logo.mode === 'hidden') actions.append(button('恢复显示', () => { publish({ ...current.logo, mode: current.logo.assetId ? 'custom' : 'default' }); render(); }, uploading));
    else actions.append(button('隐藏校徽', () => { publish({ ...current.logo, mode: 'hidden' }); render(); }, uploading));
    container.append(actions);
    const status = element('p', 'field-message', message); status.setAttribute('role', 'status'); container.append(status);
  }
  render();
  return { update(next) { current = next; render(); }, destroy() { destroyed = true; container.replaceChildren(); } };
}
