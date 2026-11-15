// QA independente da página inicial: executa o app-autonomo.html real (core.js + demo.js + app.js) num DOM mínimo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read, memoryStorage } from './apoio.mjs';
import { createDocument, waitFor, settle } from './dom-falso.mjs';

function boot(storage) {
  const html = read('app-autonomo.html');
  const { doc, Node } = createDocument(html);
  const listeners = {};
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Intl, URLSearchParams, crypto: globalThis.crypto, Uint8Array,
    document: doc, Node, localStorage: storage || memoryStorage(),
    location: { hash: '', reload() {} },
    scrollTo() {},
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
  });
  ctx.window = ctx;
  for (const [, code] of html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)) vm.runInContext(code, ctx);
  const $ = (id) => doc.getElementById(id);
  const go = (hash) => {
    ctx.location.hash = hash;
    for (const fn of listeners.hashchange || []) doc.pending.push(Promise.resolve(fn()));
  };
  const type = (id, value) => { $(id).value = value; $(id).dispatch('input'); };
  return { doc, $, go, type, html };
}

const visible = (node) => {
  for (let n = node; n && n.tagName; n = n.parentNode) if (n.hidden) return false;
  return true;
};

const loaded = (t) => waitFor(t.doc, () => t.$('lista-servicos').querySelectorAll('.service').length > 0
  && t.$('lista-barbeiros').querySelectorAll('.barber').length > 0, 'catálogo na página inicial');

test('qa página inicial: logo, nome, banner e botão principal "Agendar horário" visíveis no topo', async () => {
  const t = boot();
  await loaded(t);
  const home = t.$('view-inicio');
  assert.ok(visible(home));
  // Logo (símbolo SVG) e nome da barbearia no cabeçalho, no banner e no rodapé.
  assert.ok(t.doc.querySelector('.brand-mark'), 'marca gráfica');
  assert.ok(t.html.includes('<symbol id="i-logo"'), 'símbolo do logo embutido');
  for (const id of ['marca-nome', 'hero-nome', 'rodape-nome']) assert.equal(t.$(id).textContent, 'Barber Prime', id);
  assert.ok(home.querySelector('.hero'), 'banner');
  assert.ok(t.$('titulo-inicio').textContent.trim().length > 0);

  const cta = t.$('cta-agendar');
  assert.match(cta.textContent, /Agendar horário/);
  assert.equal(cta.getAttribute('href'), '#agendar');
  assert.match(cta.getAttribute('class'), /btn-gold/);
  // Acesso às reservas do cliente direto da página inicial e da navegação.
  assert.ok(home.querySelectorAll('a').some((a) => a.getAttribute('href') === '#reservas' && /Minhas reservas/.test(a.textContent)));
  assert.ok(t.doc.querySelectorAll('.tab').some((a) => a.getAttribute('data-nav') === 'reservas'));
  await settle(t.doc);
});

test('qa página inicial: quatro barbeiros com nome e iniciais; todo serviço mostra preço em R$ e duração', async () => {
  const t = boot();
  await loaded(t);
  const barbers = t.$('lista-barbeiros').querySelectorAll('.barber');
  assert.equal(barbers.length, 4);
  const names = barbers.map((b) => b.querySelector('h3').textContent.trim());
  assert.equal(new Set(names).size, 4, 'nomes distintos');
  for (const b of barbers) assert.ok(b.querySelector('.avatar').textContent.trim().length > 0, 'avatar com iniciais');

  const services = t.$('lista-servicos').querySelectorAll('.service');
  assert.ok(services.length >= 3, `serviços: ${services.length}`);
  for (const s of services) {
    const name = s.querySelector('h3').textContent;
    assert.match(s.querySelector('.price').textContent, /^R\$\s?\d{1,3}(\.\d{3})*,\d{2}$/, `preço de ${name}`);
    assert.match(s.querySelector('.duration').textContent, /\d+\s?(min|h)/, `duração de ${name}`);
  }
  assert.equal(t.$('lista-barbeiros').getAttribute('aria-busy'), 'false');
  assert.equal(t.$('lista-servicos').getAttribute('aria-busy'), 'false');
  await settle(t.doc);
});

test('qa página inicial: horário de funcionamento lista os 7 dias e contato tem texto mesmo sem configuração', async () => {
  const t = boot();
  await loaded(t);
  const hours = t.$('horario-funcionamento');
  assert.equal(hours.querySelectorAll('dt').length, 7);
  assert.equal(hours.querySelectorAll('dd').length, 7);
  for (const dd of hours.querySelectorAll('dd')) assert.match(dd.textContent, /^(\d{2}:\d{2} – \d{2}:\d{2}|Fechado)$/);
  assert.ok(t.$('contato-endereco').textContent.trim().length > 0, 'endereço');
  assert.match(t.$('contato-telefone').textContent, /Telefone a configurar|\(\d{2}\)/);
  await settle(t.doc);
});

test('qa página inicial: um toque no botão principal abre o agendamento já no passo do serviço', async () => {
  const t = boot();
  await loaded(t);
  t.go(t.$('cta-agendar').getAttribute('href'));
  await waitFor(t.doc, () => t.$('agendar-servicos').querySelectorAll('input').length > 0, 'serviços para escolher');
  assert.ok(visible(t.$('view-agendar')));
  assert.ok(!visible(t.$('view-inicio')));
  assert.equal(t.$('agendar-servicos').querySelectorAll('input').length, t.$('lista-servicos').querySelectorAll('.service').length);
  assert.equal(t.$('agendar-barbeiros').querySelectorAll('input').length, 4);
  // Cliente novo vê só nome e telefone como dados obrigatórios.
  const required = t.$('form-agendar').querySelectorAll('input').filter((i) => i.hasAttribute('required'));
  assert.deepEqual(required.map((i) => i.id).sort(), ['cad-nome', 'cad-telefone']);
  await settle(t.doc);
});

test('qa página inicial: nome alterado no painel aparece no cabeçalho, banner, rodapé e título e persiste', async () => {
  const storage = memoryStorage();
  const t = boot(storage);
  await loaded(t);
  t.go('#equipe');
  await waitFor(t.doc, () => /DEMONSTRAÇÃO/.test(t.$('equipe-login-ajuda').textContent), 'login demo');
  t.type('equipe-login', 'gerente');
  t.type('equipe-senha', ['senha', 'qa', 'pagina', 'inicial'].join('-'));
  t.$('form-equipe-login').dispatch('submit');
  await waitFor(t.doc, () => !t.$('painel').hidden, 'painel');
  t.$('ptab-barbearia').click();
  await waitFor(t.doc, () => t.$('barbearia-nome').value === 'Barber Prime', 'formulário da barbearia');
  t.type('barbearia-nome', 'Navalha de Ouro');
  t.$('form-barbearia').dispatch('submit');
  await waitFor(t.doc, () => t.$('hero-nome').textContent === 'Navalha de Ouro', 'nome no banner');
  for (const id of ['marca-nome', 'rodape-nome']) assert.equal(t.$(id).textContent, 'Navalha de Ouro', id);
  assert.match(t.doc.title, /Navalha de Ouro/);
  await settle(t.doc);

  const again = boot(storage);
  await loaded(again);
  await waitFor(again.doc, () => again.$('hero-nome').textContent === 'Navalha de Ouro', 'nome persistido após recarregar');
  await settle(again.doc);
});
