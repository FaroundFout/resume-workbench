import { element, field, button } from './profile.mjs';

export function mountLayout(container, { data, onChange }) {
  let current = data;
  const edit = (key, value) => { current = { ...current, layout: { ...current.layout, [key]: value } }; onChange(current); };
  function render() {
    container.replaceChildren();
    container.append(element('p', 'module-intro', '版式参数直接用于 XeLaTeX 排版；生成后的实际 PDF 显示在右侧。'));
    const grid = element('div', 'field-grid'); container.append(grid);
    field(grid, '纸张', current.layout.paper, value => edit('paper', value), { options: [['auto', `自动 · ${current.language === 'en' ? 'Letter' : 'A4'}`], ['a4', 'A4'], ['letter', 'Letter']] });
    field(grid, '正文字号', current.layout.fontSizePt, value => edit('fontSizePt', Number(value)), { options: [[10, '10 pt'], [11, '11 pt'], [12, '12 pt']] });
    field(grid, '条目 / 段落间距', current.layout.density, value => edit('density', value), { options: [['compact', '紧凑'], ['standard', '标准']] });
    const margin = field(grid, '页边距 · mm', current.layout.marginMm, value => {
      const number = Number(value); if (value !== '' && Number.isFinite(number) && number >= 8 && number <= 20) edit('marginMm', number);
    }, { type: 'number', min: 8, max: 20, step: 0.5 });
    margin.addEventListener('change', () => { if (!margin.checkValidity() || margin.value === '') margin.value = current.layout.marginMm; });
    const value = element('output', 'field-label', (current.layout.lineSpacing ?? 1).toFixed(2));
    const range = field(grid, '正文行距', current.layout.lineSpacing ?? 1, text => {
      const factor = Number(text);
      if (!Number.isFinite(factor) || factor < 1 || factor > 1.5) return;
      value.textContent = factor.toFixed(2); edit('lineSpacing', factor);
    }, { type: 'range', min: 1, max: 1.5, step: 0.05 });
    range.id = 'body-line-spacing'; value.id = 'body-line-spacing-value';
    value.setAttribute('for', range.id); range.setAttribute('aria-describedby', value.id);
    const controls = element('div', 'item-controls');
    controls.append(value, button('恢复默认', () => {
      range.value = 1; value.textContent = '1.00'; edit('lineSpacing', 1);
    }));
    grid.append(controls);
    container.append(element('p', 'muted', '正文行距范围为 1.00–1.50；调整后点击“更新预览”查看 PDF。行距越大，内容可能占用更多页。'));
    container.append(element('p', 'muted', '页边距范围为 8–20 mm。正文支持 10、11、12 pt；标题保留模板层级。'));
  }
  render();
  return { update(next) { current = next; render(); }, destroy() { container.replaceChildren(); } };
}
