// Executa os fluxos "tela" com alvo "autonomo" declarados em .homologacao/fluxos.json no DOM mínimo,
// em sequência e com o MESMO localStorage (pior caso: o navegador da homologação não limpa entre fluxos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read, memoryStorage } from './apoio.mjs';
import { createDocument, waitFor, settle } from './dom-falso.mjs';

const fluxos = JSON.parse(read('.homologacao/fluxos.json'));
const telas = fluxos.fluxos.filter((f) => f.tipo === 'tela' && f.alvo === 'autonomo');

function visibleText(node) {
  if (node.tagName && (node.hidden || /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName))) return '';
  if (!node.tagName) return node.textContent;
  return node.childNodes.map(visibleText).join(' ');
}

// Abre a página como um navegador faria e imita os comportamentos padrão usados pelos passos:
// clicar num input marca e dispara change; clicar num link #ancora troca o hash; botão submit envia o formulário.
function open(storage) {
  const html = read('app-autonomo.html');
  const { doc, Node } = createDocument(html);
  const listeners = {};
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Intl, URLSearchParams, crypto: globalThis.crypto, Uint8Array,
    document: doc, Node, localStorage: storage, location: { hash: '', reload() {} }, scrollTo() {},
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
  });
  ctx.window = ctx;
  for (const [, code] of html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)) vm.runInContext(code, ctx);
  const isVisible = (n) => { for (let p = n; p && p.tagName; p = p.parentNode) if (p.hidden) return false; return true; };
  const find = (sel) => doc.documentElement.querySelectorAll(sel.replace(/^#([\w-]+)$/, '[id="$1"]')).find(isVisible);
  const click = (node) => {
    if (node.tagName === 'INPUT' && /radio|checkbox/.test(node.type)) { node.checked = true; node.dispatch('click'); node.dispatch('change'); return; }
    const ev = node.dispatch('click');
    const href = node.getAttribute('href');
    if (node.tagName === 'A' && href && href.startsWith('#') && !ev.defaultPrevented) {
      ctx.location.hash = href;
      for (const fn of listeners.hashchange || []) doc.pending.push(Promise.resolve(fn()));
    }
    if (node.tagName === 'BUTTON' && node.type !== 'button' && !ev.defaultPrevented) {
      let form = node.parentNode;
      while (form && form.tagName !== 'FORM') form = form.parentNode;
      if (form) form.dispatch('submit');
    }
  };
  return { doc, find, click };
}

test('fluxos de tela do app-autonomo.html declarados na homologação executam em sequência a 375px', async () => {
  assert.equal(fluxos.htmlAutonomo, 'app-autonomo.html');
  assert.ok(telas.length >= 10, 'fluxos de tela do autônomo declarados');
  const storage = memoryStorage();
  for (const fluxo of telas) {
    assert.equal(fluxo.largura, 375, fluxo.id + ' largura de celular');
    const page = open(storage);
    for (const [i, passo] of fluxo.passos.entries()) {
      const where = fluxo.id + ' passo ' + (i + 1) + ' ' + JSON.stringify(passo);
      if (passo.esperarTexto) {
        await waitFor(page.doc, () => visibleText(page.doc.body).replace(/\s+/g, ' ').includes(passo.esperarTexto), where);
      } else {
        const sel = passo.clicar || passo.preencher;
        const node = await waitFor(page.doc, () => page.find(sel) && !page.find(sel).disabled && page.find(sel), where);
        if (passo.clicar) page.click(node);
        else { node.value = passo.valor; node.dispatch('input'); node.dispatch('change'); }
      }
    }
    await settle(page.doc);
  }
});
