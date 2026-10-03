import { element, button, field, itemControls } from './profile.mjs';
import { mountRichText } from '../rich-text.mjs';

export const SECTION_LABELS = { education: '教育经历', experience: '实习与工作', projects: '项目经历', skills: '专业技能', awards: '荣誉奖项', social: '社会实践' };
const fields = {
  education: [['school', '学校'], ['degree', '学位'], ['major', '专业'], ['period', '时间']],
  experience: [['organization', '公司 / 组织'], ['role', '职位'], ['location', '地点'], ['period', '时间']],
  projects: [['name', '项目名称'], ['period', '时间'], ['role', '角色'], ['url', '项目链接'], ['techStack', '技术栈']],
  skills: [['category', '技能类别']],
  awards: [['name', '奖项名称'], ['period', '时间'], ['issuer', '颁发机构']],
  social: [['organization', '组织'], ['role', '角色'], ['period', '时间']],
};
const descriptions = { projects: ['summary', '项目概述'], skills: ['content', '技能描述'], awards: ['description', '奖项说明'] };

export function moveItem(items, from, to) {
  const result = [...items];
  if (![from, to].every(index => Number.isInteger(index) && index >= 0 && index < items.length)) return result;
  const [item] = result.splice(from, 1); result.splice(to, 0, item); return result;
}
export function toggleSection(data, key, enabled) {
  if (!Object.hasOwn(data.sections, key)) throw new Error('未知简历模块');
  return { ...data, sections: { ...data.sections, [key]: { ...data.sections[key], enabled: !!enabled } } };
}
function emptyItem(key) {
  const item = { id: crypto.randomUUID(), ...Object.fromEntries(fields[key].map(([name]) => [name, ''])) };
  if (descriptions[key]) item[descriptions[key][0]] = [];
  if (!['skills', 'awards'].includes(key)) item.bullets = [];
  return item;
}

/** The optional sectionKey selects a workspace module; omitting it mounts all six. */
export function mountSections(container, { data, onChange, sectionKey }) {
  let current = data; let richEditors = [];
  const publish = next => { current = next; onChange(current); };
  const setItems = (key, items) => publish({ ...current, sections: { ...current.sections, [key]: { ...current.sections[key], items } } });
  const editItem = (key, id, name, value) => setItems(key, current.sections[key].items.map(item => item.id === id ? { ...item, [name]: value } : item));
  const rich = (parent, label, value, change) => {
    const host = element('div', 'rich-field'); host.dataset.label = label;
    host.append(element('p', 'field-label', label)); parent.append(host);
    richEditors.push(mountRichText(host, { value, onChange: change }));
  };
  function render() {
    richEditors.forEach(editor => editor.destroy()); richEditors = []; container.replaceChildren();
    for (const key of sectionKey ? [sectionKey] : current.sectionOrder) {
      const module = element('section', 'section-form'); const heading = element('div', 'subheading');
      heading.append(element('h3', '', SECTION_LABELS[key]));
      const visible = element('label', 'check-label'); const check = element('input'); check.type = 'checkbox'; check.checked = current.sections[key].enabled;
      check.addEventListener('change', () => { publish(toggleSection(current, key, check.checked)); render(); });
      visible.append(check, document.createTextNode('在 PDF 中显示')); heading.append(visible); module.append(heading);
      if (!current.sections[key].enabled) module.append(element('p', 'notice', '此模块已隐藏。内容仍保留，可继续编辑或随时恢复。'));
      const order = element('div', 'section-order'); const position = current.sectionOrder.indexOf(key);
      order.append(element('span', 'muted', `PDF 顺序 ${position + 1} / 6`));
      order.append(button('模块上移', () => { publish({ ...current, sectionOrder: moveItem(current.sectionOrder, position, position - 1) }); render(); }, position === 0));
      order.append(button('模块下移', () => { publish({ ...current, sectionOrder: moveItem(current.sectionOrder, position, position + 1) }); render(); }, position === 5)); module.append(order);
      current.sections[key].items.forEach((item, index) => {
        const group = element('fieldset', 'entry'); group.append(element('legend', '', `${SECTION_LABELS[key]} ${index + 1}`));
        itemControls(group, index, current.sections[key].items.length, to => { setItems(key, moveItem(current.sections[key].items, index, to)); render(); }, () => { setItems(key, current.sections[key].items.filter(entry => entry.id !== item.id)); render(); }, SECTION_LABELS[key]);
        const rows = element('div', 'field-grid'); group.append(rows);
        for (const [name, label] of fields[key]) field(rows, label, item[name], value => editItem(key, item.id, name, value), { type: name === 'url' ? 'url' : 'text' });
        if (descriptions[key]) {
          const [name, label] = descriptions[key]; rich(group, label, item[name], value => editItem(key, item.id, name, value));
        }
        if (item.bullets) {
          const bulletHeading = element('div', 'subheading'); bulletHeading.append(element('h4', '', '描述要点'));
          bulletHeading.append(button('＋ 添加要点', () => { const latest = current.sections[key].items.find(entry => entry.id === item.id); editItem(key, item.id, 'bullets', [...latest.bullets, []]); render(); }, item.bullets.length >= 100)); group.append(bulletHeading);
          item.bullets.forEach((paragraph, bulletIndex) => {
            const row = element('div', 'bullet-entry');
            const setBullets = transform => { const latest = current.sections[key].items.find(entry => entry.id === item.id); editItem(key, item.id, 'bullets', transform(latest.bullets)); };
            rich(row, `要点 ${bulletIndex + 1}`, paragraph, value => setBullets(bullets => bullets.map((existing, at) => at === bulletIndex ? value : existing)));
            itemControls(row, bulletIndex, item.bullets.length, to => { setBullets(bullets => moveItem(bullets, bulletIndex, to)); render(); }, () => { setBullets(bullets => bullets.filter((_, at) => at !== bulletIndex)); render(); }, '要点'); group.append(row);
          });
        }
        module.append(group);
      });
      if (!current.sections[key].items.length) module.append(element('p', 'empty-note', '这个模块还没有内容。添加一条，按需要填写。'));
      const add = button(`＋ 添加${SECTION_LABELS[key]}`, () => { setItems(key, [...current.sections[key].items, emptyItem(key)]); render(); }, current.sections[key].items.length >= 100); add.className = 'add-entry'; module.append(add); container.append(module);
    }
  }
  render();
  return { update(next) { current = next; render(); }, destroy() { richEditors.forEach(editor => editor.destroy()); container.replaceChildren(); } };
}
