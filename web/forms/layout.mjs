import { element, field } from './profile.mjs';

export function mountLayout(container, { data, onChange }) {
  let current = data;
  const edit = (key, value) => { current = { ...current, layout: { ...current.layout, [key]: value } }; onChange(current); };
  function render() {
    container.replaceChildren();
    container.append(element('p', 'module-intro', '版式参数直接用于 XeLaTeX 排版；生成后的实际 PDF 显示在右侧。'));
    const grid = element('div', 'field-grid'); container.append(grid);
    field(grid, '纸张', current.layout.paper, value => edit('paper', value), { options: [['auto', `自动 · ${current.language === 'en' ? 'Letter' : 'A4'}`], ['a4', 'A4'], ['letter', 'Letter']] });
    field(grid, '正文字号', current.layout.fontSizePt, value => edit('fontSizePt', Number(value)), { options: [[10, '10 pt'], [11, '11 pt'], [12, '12 pt']] });
    field(grid, '间距', current.layout.density, value => edit('density', value), { options: [['compact', '紧凑'], ['standard', '标准']] });
    const margin = field(grid, '页边距 · mm', current.layout.marginMm, value => {
      const number = Number(value); if (value !== '' && Number.isFinite(number) && number >= 8 && number <= 20) edit('marginMm', number);
    }, { type: 'number', min: 8, max: 20, step: 0.5 });
    margin.addEventListener('change', () => { if (!margin.checkValidity() || margin.value === '') margin.value = current.layout.marginMm; });
    container.append(element('p', 'muted', '页边距范围为 8–20 mm。正文支持 10、11、12 pt；标题保留模板层级。'));
  }
  render();
  return { update(next) { current = next; render(); }, destroy() { container.replaceChildren(); } };
}
