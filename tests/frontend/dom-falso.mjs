// DOM mínimo para executar public/app.js no Node sem dependências: só o subconjunto que a interface usa.
// A árvore é montada a partir do HTML real (app-autonomo.html), então ids, formulários e aninhamento são os de verdade.

const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'source', 'use', 'circle', 'path', 'rect']);

class FakeNode {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '') this.append(new FakeText(String(v), this.ownerDocument)); }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n, this.ownerDocument) : n;
      if (node.parentNode) node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const list = this.parentNode.childNodes;
    list.splice(list.indexOf(this), 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text, doc) { super(); this.data = text; this.ownerDocument = doc; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

function parseSelector(sel) {
  return sel.split(',').map((part) => part.trim().split(/\s+/).map((compound) => {
    const c = { tag: null, classes: [], attrs: [], not: [] };
    const re = /^([a-z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:not\(\[([\w-]+)\]\)/gi;
    let m;
    let consumed = 0;
    while ((m = re.exec(compound))) {
      if (m.index !== consumed) break;
      consumed = re.lastIndex;
      if (m[1]) c.tag = m[1].toLowerCase();
      else if (m[2]) c.classes.push(m[2]);
      else if (m[3]) c.attrs.push([m[3], m[4]]);
      else if (m[5]) c.not.push(m[5]);
    }
    if (consumed !== compound.length) throw new Error('seletor não suportado pelo DOM falso: ' + sel);
    return c;
  }));
}

function matchCompound(el, c) {
  if (!(el instanceof FakeElement)) return false;
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.classes.some((k) => !el.classList.contains(k))) return false;
  if (c.attrs.some(([k, v]) => !el.hasAttribute(k) || (v !== undefined && el.getAttribute(k) !== v))) return false;
  if (c.not.some((k) => el.hasAttribute(k))) return false;
  return true;
}

function matches(el, chains) {
  return chains.some((chain) => {
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2;
    for (let p = el.parentNode; p && i >= 0; p = p.parentNode) if (matchCompound(p, chain[i])) i -= 1;
    return i < 0;
  });
}

const BOOL_PROPS = ['hidden', 'disabled', 'checked', 'selected', 'required'];

class FakeElement extends FakeNode {
  constructor(tag, doc) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.attributes = new Map();
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this._value = undefined;
    const self = this;
    this.classList = {
      contains: (k) => self.className.split(/\s+/).includes(k),
      add: (k) => { if (!self.classList.contains(k)) self.className = (self.className + ' ' + k).trim(); },
      remove: (k) => { self.className = self.className.split(/\s+/).filter((x) => x && x !== k).join(' '); },
      toggle: (k, on) => { (on ?? !self.classList.contains(k)) ? self.classList.add(k) : self.classList.remove(k); },
    };
  }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.setAttribute('type', v); }
  get name() { return this.getAttribute('name') || ''; }
  get tabIndex() { return Number(this.getAttribute('tabindex') || 0); }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  get value() {
    if (this.tagName === 'SELECT') {
      if (this._value !== undefined) return this._value;
      const opts = this.querySelectorAll('option');
      const sel = opts.find((o) => o.selected) || opts[0];
      return sel ? sel.value : '';
    }
    if (this._value !== undefined) return this._value;
    return this.getAttribute('value') ?? (this.tagName === 'OPTION' ? this.textContent : '');
  }
  set value(v) {
    if (this.tagName === 'SELECT' && !this.querySelectorAll('option').some((o) => o.value === String(v))) return;
    this._value = String(v);
  }
  get childElementCount() { return this.childNodes.filter((c) => c instanceof FakeElement).length; }
  get elements() {
    const all = this.querySelectorAll('input, select, textarea, button');
    return { namedItem: (n) => all.find((e) => e.name === n) || null };
  }
  descendants() {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c instanceof FakeElement) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(sel) { const chains = parseSelector(sel); return this.descendants().filter((e) => matches(e, chains)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, extra) {
    const results = [];
    const event = Object.assign({ type, target: this, preventDefault() { this.defaultPrevented = true; } }, extra);
    for (let n = this; n; n = n.parentNode) {
      for (const fn of (n.listeners && n.listeners[type]) || []) {
        event.currentTarget = n;
        results.push(fn.call(n, event));
      }
      if (type === 'focus' || type === 'blur') break;
    }
    this.ownerDocument.pending.push(...results.filter((r) => r && typeof r.then === 'function'));
    return event;
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  reset() {
    for (const e of this.querySelectorAll('input, select, textarea')) { e._value = undefined; e.checked = false; }
  }
}
for (const p of BOOL_PROPS) {
  Object.defineProperty(FakeElement.prototype, p, {
    get() { return this.hasAttribute(p); },
    set(v) { if (v) this.setAttribute(p, ''); else this.removeAttribute(p); },
  });
}

export function createDocument(html) {
  const doc = {
    readyState: 'complete',
    pending: [],
    activeElement: null,
    title: '',
    createElement: (t) => new FakeElement(t, doc),
    createElementNS: (_ns, t) => new FakeElement(t, doc),
    createTextNode: (t) => new FakeText(t, doc),
    addEventListener() {},
    getElementById: (id) => doc.documentElement.descendants().find((e) => e.id === id) || null,
    querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
    querySelector: (s) => doc.documentElement.querySelector(s),
  };
  doc.documentElement = new FakeElement('html', doc);
  const stack = [doc.documentElement];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[2]) {
      const tag = m[2].toLowerCase();
      while (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const el = new FakeElement(m[3], doc);
      for (const a of m[4].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], (a[2] ?? '').replace(/&amp;/g, '&'));
      stack[stack.length - 1].append(el);
      if (!m[5] && !VOID.has(m[3].toLowerCase())) stack.push(el);
    } else if (m[6] && m[6].trim()) {
      stack[stack.length - 1].append(new FakeText(m[6], doc));
    }
  }
  doc.body = doc.documentElement.querySelector('body');
  return { doc, Node: FakeNode };
}

// Espera uma condição da interface (a demonstração responde com latência simulada).
export async function waitFor(doc, check, label, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    const failed = (await Promise.allSettled(doc.pending.splice(0))).find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error('tempo esgotado esperando: ' + label);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Aguarda handlers assíncronos e temporizadores (latência da demonstração) e repassa erros não tratados.
export async function settle(doc, ms = 30) {
  for (let round = 0; round < 40; round++) {
    await new Promise((r) => setTimeout(r, ms));
    if (!doc.pending.length) {
      await new Promise((r) => setTimeout(r, ms));
      if (!doc.pending.length) return;
    }
    const batch = doc.pending.splice(0);
    const results = await Promise.allSettled(batch);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
