// Small DOM primitives shared by the module forms. All user text uses textContent/value.
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(text, action, disabled = false) {
  const node = element('button', '', text); node.type = 'button'; node.disabled = disabled;
  node.addEventListener('click', action); return node;
}
export function field(parent, label, value, onInput, { options, type = 'text', min, max, step } = {}) {
  const wrapper = element('label', 'field'); wrapper.append(element('span', 'field-label', label));
  const input = element(options ? 'select' : 'input');
  if (options) for (const [key, title] of options) { const option = element('option', '', title); option.value = key; input.append(option); }
  else { input.type = type; if (type === 'text' || type === 'url') input.maxLength = 2000; }
  for (const [key, setting] of Object.entries({ min, max, step })) if (setting !== undefined) input[key] = setting;
  input.value = value; input.addEventListener(options ? 'change' : 'input', () => onInput(input.value)); wrapper.append(input); parent.append(wrapper); return input;
}
export function itemControls(parent, index, count, move, remove, label = '条目') {
  const controls = element('div', 'item-controls');
  for (const [text, action, disabled] of [
    ['上移', () => move(index - 1), index === 0], ['下移', () => move(index + 1), index === count - 1], ['删除', remove, false],
  ]) { const node = button(text, action, disabled); node.setAttribute('aria-label', `${label} ${index + 1} ${text}`); controls.append(node); }
  parent.append(controls);
}

export function mountProfile(container, { data, onChange }) {
  let current = data;
  const publish = profile => { current = { ...current, profile }; onChange(current); };
  function render() {
    container.replaceChildren();
    container.append(element('p', 'module-intro', current.language === 'en' ? '英文内容独立保存；可自由填写英文姓名与中文备用姓名。' : '先把身份和联系方式写清楚。标题可填写求职方向。'));
    const grid = element('div', 'field-grid'); container.append(grid);
    for (const [key, label] of [['name', current.language === 'en' ? '英文姓名 / Name' : '姓名'], ['alternateName', '备用姓名 / Alternate name'], ['title', '求职方向 / Title']]) {
      field(grid, label, current.profile[key], value => publish({ ...current.profile, [key]: value }));
    }
    const heading = element('div', 'subheading'); heading.append(element('h3', '', '联系方式'));
    heading.append(button('＋ 添加联系方式', () => { publish({ ...current.profile, contacts: [...current.profile.contacts, { id: crypto.randomUUID(), type: 'email', label: '', value: '' }] }); render(); })); container.append(heading);
    current.profile.contacts.forEach((contact, index) => {
      const group = element('fieldset', 'entry'); group.append(element('legend', '', `联系方式 ${index + 1}`));
      const edit = (key, value) => publish({ ...current.profile, contacts: current.profile.contacts.map(item => item.id === contact.id ? { ...item, [key]: value } : item) });
      const rows = element('div', 'field-grid'); group.append(rows);
      field(rows, '类型', contact.type, value => edit('type', value), { options: [['phone', '电话'], ['email', '邮箱'], ['wechat', '微信'], ['url', '网站']] });
      field(rows, '显示名称', contact.label, value => edit('label', value));
      field(rows, '联系方式内容', contact.value, value => edit('value', value));
      itemControls(group, index, current.profile.contacts.length, to => {
        const contacts = [...current.profile.contacts]; const [item] = contacts.splice(index, 1); contacts.splice(to, 0, item); publish({ ...current.profile, contacts }); render();
      }, () => { publish({ ...current.profile, contacts: current.profile.contacts.filter(item => item.id !== contact.id) }); render(); }, '联系方式');
      container.append(group);
    });
    if (!current.profile.contacts.length) container.append(element('p', 'empty-note', '尚未填写联系方式。添加后可调整顺序。'));
  }
  render();
  return { update(next) { current = next; render(); }, destroy() { container.replaceChildren(); } };
}
