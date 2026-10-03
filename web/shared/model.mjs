/**
 * Shared browser/server resume contract. Text is retained verbatim; consumers
 * perform context-specific escaping when displaying or generating LaTeX.
 *
 * @typedef {'zh-CN'|'en'} Language
 * @typedef {{text: string, bold: boolean, url: string|null}} TextRun
 * @typedef {TextRun[]} RichText
 * @typedef {{id: string, type: 'phone'|'email'|'wechat'|'url', label: string, value: string}} Contact
 * @typedef {{name: string, alternateName: string, title: string, contacts: Contact[]}} Profile
 * @typedef {{id: string, school: string, degree: string, major: string, period: string, location?: string, bullets: RichText[]}} EducationItem
 * @typedef {{id: string, organization: string, role: string, location: string, period: string, bullets: RichText[]}} ExperienceItem
 * @typedef {{id: string, name: string, period: string, role: string, url: string, techStack: string, summary: RichText, bullets: RichText[]}} ProjectItem
 * @typedef {{id: string, category: string, content: RichText}} SkillItem
 * @typedef {{id: string, name: string, period: string, issuer: string, description: RichText}} AwardItem
 * @typedef {{id: string, organization: string, role: string, period: string, bullets: RichText[]}} SocialItem
 * @typedef {'education'|'experience'|'projects'|'skills'|'awards'|'social'} SectionKey
 * @template T
 * @typedef {{enabled: boolean, items: T[]}} Section
 * @typedef {{education: Section<EducationItem>, experience: Section<ExperienceItem>, projects: Section<ProjectItem>, skills: Section<SkillItem>, awards: Section<AwardItem>, social: Section<SocialItem>}} Sections
 * @typedef {{paper: 'auto'|'a4'|'letter', fontSizePt: 10|11|12, density: 'standard'|'compact', marginMm: number, lineSpacing?: number}} Layout
 * @typedef {{mode: 'default'|'custom'|'hidden', assetId: string|null, widthCm: number}} Logo
 * @typedef {{language: Language, profile: Profile, sections: Sections, sectionOrder: SectionKey[], layout: Layout, logo: Logo}} ResumeData
 * @typedef {{schemaVersion: 1, id: string, name: string, revision: number, updatedAt: string, data: ResumeData}} SavedResume
 * @typedef {{id: string, resumeId: string, revision: number, status: 'running'|'succeeded'|'failed'|'timed_out'|'interrupted', createdAt: string, finishedAt: string|null, pages: number|null, warnings: string[], error: object|null}} BuildRecord
 * @typedef {SavedResume & {latestBuild: BuildRecord|null}} ResumeView
 * @typedef {{resumeId: string, revision: number, data: ResumeData, logoImage: null|{mime: 'image/png'|'image/jpeg', bytes: Buffer}}} Snapshot
 * @typedef {{code: string, message: string, status: number, fields?: object}} AppError
 * @typedef {{path: string, message: string}} ValidationIssue
 */

const SECTION_KEYS = ['education', 'experience', 'projects', 'skills', 'awards', 'social'];
const ITEM_FIELDS = {
  education: ['id', 'school', 'degree', 'major', 'period', 'bullets', 'location'],
  experience: ['id', 'organization', 'role', 'location', 'period', 'bullets'],
  projects: ['id', 'name', 'period', 'role', 'url', 'techStack', 'summary', 'bullets'],
  skills: ['id', 'category', 'content'],
  awards: ['id', 'name', 'period', 'issuer', 'description'],
  social: ['id', 'organization', 'role', 'period', 'bullets'],
};

/** @param {unknown} input @returns {Language} */
export function validateLanguage(input) {
  if (input !== 'zh-CN' && input !== 'en') {
    throw new Error('language 必须为 zh-CN 或 en');
  }
  return input;
}

/** @param {Language} language @returns {ResumeData} */
export function createEmptyData(language) {
  return {
    language: validateLanguage(language),
    profile: { name: '', alternateName: '', title: '', contacts: [] },
    sections: Object.fromEntries(SECTION_KEYS.map(key => [key, { enabled: true, items: [] }])),
    sectionOrder: [...SECTION_KEYS],
    layout: { paper: 'auto', fontSizePt: 10, density: 'compact', marginMm: 10 },
    logo: { mode: 'default', assetId: null, widthCm: 2.4 },
  };
}

/**
 * Checks the complete strict schema without modifying, trimming or escaping it.
 * @param {unknown} input
 * @returns {{ok: true, value: ResumeData}|{ok: false, issues: ValidationIssue[]}}
 */
export function validateResumeData(input) {
  const issues = [];
  let totalText = 0;
  const issue = (path, message) => issues.push({ path, message });
  function object(value, fields, path, optional = []) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      issue(path, '必须为对象');
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!fields.includes(key)) issue(path === '$' ? key : `${path}.${key}`, '不允许的字段');
    }
    for (const key of fields) {
      if (!optional.includes(key) && !Object.hasOwn(value, key)) issue(path === '$' ? key : `${path}.${key}`, '缺少字段');
    }
    return true;
  }
  function string(value, path, maximum = 2000) {
    if (typeof value !== 'string') { issue(path, '必须为字符串'); return false; }
    totalText += value.length;
    if (value.length > maximum) issue(path, `不得超过 ${maximum} 字符`);
    return true;
  }
  function enumeration(value, allowed, path) {
    if (!allowed.includes(value)) issue(path, `必须为 ${allowed.join(' / ')}`);
  }
  function boolean(value, path) {
    if (typeof value !== 'boolean') issue(path, '必须为布尔值');
  }
  function dimension(value, minimum, maximum, path) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      issue(path, `必须为 ${minimum}–${maximum} 之间的数值`);
    }
  }
  function array(value, path, maximum) {
    if (!Array.isArray(value)) { issue(path, '必须为数组'); return false; }
    if (maximum !== undefined && value.length > maximum) issue(path, `不得超过 ${maximum} 条`);
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) issue(`${path}[${index}]`, '缺少数组条目');
    }
    return true;
  }
  function url(value, path, { allowMailto = false, allowEmpty = false, nullable = false } = {}) {
    if (nullable && value === null) return;
    if (!string(value, path)) return;
    if (allowEmpty && value === '') return;
    try {
      const parsed = new URL(value);
      const http = /^https?:\/\//iu.test(value) && ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname;
      const mailto = allowMailto && parsed.protocol === 'mailto:' && parsed.pathname;
      if ((!http && !mailto) || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('invalid URL');
    } catch {
      issue(path, allowMailto ? '链接必须为完整的 http、https 或 mailto URL' : '链接必须为完整的 http 或 https URL');
    }
  }
  function richText(value, path) {
    if (!array(value, path)) return;
    value.forEach((run, index) => {
      const at = `${path}[${index}]`;
      if (!object(run, ['text', 'bold', 'url'], at)) return;
      string(run.text, `${at}.text`, 10000);
      boolean(run.bold, `${at}.bold`);
      url(run.url, `${at}.url`, { allowMailto: true, nullable: true });
    });
  }
  function bullets(value, path) {
    if (array(value, path, 100)) value.forEach((paragraph, index) => richText(paragraph, `${path}[${index}]`));
  }
  function uniqueIds(items, path) {
    const seen = new Set();
    items.forEach((item, index) => {
      if (typeof item?.id !== 'string') return;
      if (seen.has(item.id)) issue(`${path}[${index}].id`, 'ID 重复；同一列表中的每个条目必须具有不同 ID');
      seen.add(item.id);
    });
  }

  if (object(input, ['language', 'profile', 'sections', 'sectionOrder', 'layout', 'logo'], '$')) {
    enumeration(input.language, ['zh-CN', 'en'], 'language');
    if (object(input.profile, ['name', 'alternateName', 'title', 'contacts'], 'profile')) {
      for (const key of ['name', 'alternateName', 'title']) string(input.profile[key], `profile.${key}`);
      if (array(input.profile.contacts, 'profile.contacts')) {
        uniqueIds(input.profile.contacts, 'profile.contacts');
        input.profile.contacts.forEach((contact, index) => {
          const at = `profile.contacts[${index}]`;
          if (!object(contact, ['id', 'type', 'label', 'value'], at)) return;
          for (const key of ['id', 'label']) string(contact[key], `${at}.${key}`);
          enumeration(contact.type, ['phone', 'email', 'wechat', 'url'], `${at}.type`);
          if (contact.type === 'url') url(contact.value, `${at}.value`);
          else string(contact.value, `${at}.value`);
        });
      }
    }
    if (object(input.sections, SECTION_KEYS, 'sections')) {
      for (const key of SECTION_KEYS) {
        const section = input.sections[key];
        const at = `sections.${key}`;
        if (!object(section, ['enabled', 'items'], at)) continue;
        boolean(section.enabled, `${at}.enabled`);
        if (!array(section.items, `${at}.items`, 100)) continue;
        uniqueIds(section.items, `${at}.items`);
        section.items.forEach((item, index) => {
          const entryPath = `${at}.items[${index}]`;
          const optional = key === 'education' ? ['location'] : [];
          if (!object(item, ITEM_FIELDS[key], entryPath, optional)) return;
          for (const field of ITEM_FIELDS[key]) {
            if (optional.includes(field) && !Object.hasOwn(item, field)) continue;
            const path = `${entryPath}.${field}`;
            if (field === 'bullets') bullets(item[field], path);
            else if (['summary', 'content', 'description'].includes(field)) richText(item[field], path);
            else if (field === 'url') url(item[field], path, { allowEmpty: true });
            else string(item[field], path);
          }
        });
      }
    }
    if (array(input.sectionOrder, 'sectionOrder')) {
      if (input.sectionOrder.length !== 6 || new Set(input.sectionOrder).size !== 6 ||
          !input.sectionOrder.every(key => SECTION_KEYS.includes(key))) {
        issue('sectionOrder', '必须恰好包含六个不同的已知模块');
      }
    }
    if (object(input.layout, ['paper', 'fontSizePt', 'density', 'marginMm', 'lineSpacing'], 'layout', ['lineSpacing'])) {
      enumeration(input.layout.paper, ['auto', 'a4', 'letter'], 'layout.paper');
      enumeration(input.layout.fontSizePt, [10, 11, 12], 'layout.fontSizePt');
      enumeration(input.layout.density, ['standard', 'compact'], 'layout.density');
      dimension(input.layout.marginMm, 8, 20, 'layout.marginMm');
      if (Object.hasOwn(input.layout, 'lineSpacing')) dimension(input.layout.lineSpacing, 1, 1.5, 'layout.lineSpacing');
    }
    if (object(input.logo, ['mode', 'assetId', 'widthCm'], 'logo')) {
      enumeration(input.logo.mode, ['default', 'custom', 'hidden'], 'logo.mode');
      dimension(input.logo.widthCm, 1.2, 3.2, 'logo.widthCm');
      const asset = input.logo.assetId;
      if (asset !== null && (typeof asset !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(asset))) {
        issue('logo.assetId', '必须为 null 或有效的素材 ID');
      }
      if (input.logo.mode === 'default' && asset !== null) issue('logo.assetId', '默认校徽的素材 ID 必须为 null');
      if (input.logo.mode === 'custom' && asset === null) issue('logo.assetId', '自定义校徽必须具有素材 ID');
    }
  }
  if (totalText > 200000) issue('$', '总文本不得超过 200000 字符');
  return issues.length ? { ok: false, issues } : { ok: true, value: input };
}
