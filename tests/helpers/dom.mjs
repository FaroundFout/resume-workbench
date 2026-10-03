export class TestNode {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.value = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; delete this[key]; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async fire(type, extra = {}) { for (const listener of this.listeners[type] || []) await listener({ preventDefault() {}, ...extra }); }
  showModal() { this.open = true; } close() { this.open = false; } focus() {} select() {} click() { return this.fire('click'); }
  all() { return [this, ...this.children.flatMap(node => node.all())]; }
}
export function installDom(t) {
  const previous = globalThis.document; const created = [];
  globalThis.document = { created, createElement: tag => { const node = new TestNode(tag); created.push(node); return node; }, getElementById: () => null };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return new TestNode('main');
}
