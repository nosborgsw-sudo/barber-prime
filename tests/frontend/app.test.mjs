// Executa a interface real (app-autonomo.html: core.js + demo.js + app.js) num DOM mínimo e percorre os fluxos principais.
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
  const pick = (input) => { input.checked = true; input.dispatch('change'); };
  return { doc, $, go, type, pick, ctx };
}

const visible = (node) => {
  for (let n = node; n && n.tagName; n = n.parentNode) if (n.hidden) return false;
  return true;
};

async function chooseFirstFreeSlot(t, container) {
  const days = container.querySelectorAll('.days input').filter((i) => !i.disabled);
  for (const day of days) {
    t.pick(day);
    const settled = await waitFor(t.doc, () => {
      const st = container.querySelector('.status').textContent;
      return /livre/.test(st) || /Nenhum horário/.test(st) ? st : null;
    }, 'horários do dia');
    if (/Nenhum/.test(settled)) continue;
    const slot = container.querySelector('.slots input');
    t.pick(slot);
    return slot.value;
  }
  throw new Error('nenhum dia com horário livre');
}

test('interface: página inicial mostra barbeiros, serviços, horário de funcionamento e marca DEMONSTRAÇÃO', async () => {
  const t = boot();
  await waitFor(t.doc, () => t.$('lista-barbeiros').querySelectorAll('.barber').length === 4, 'barbeiros');
  const text = t.$('lista-barbeiros').textContent;
  for (const n of ['Rafael Monteiro', 'Diego Alencar', 'Lucas Ferraz', 'Bruno Tavares']) assert.ok(text.includes(n), n);
  const services = t.$('lista-servicos').textContent;
  assert.match(services, /Corte masculino/);
  assert.match(services, /R\$\s?60,00/);
  assert.match(services, /45 min/);
  const hours = t.$('horario-funcionamento').textContent;
  assert.match(hours, /Segunda09:00 – 19:00/);
  assert.match(hours, /DomingoFechado/);
  assert.match(t.doc.title, /^DEMONSTRAÇÃO/);
  assert.equal(t.doc.body.dataset.mode, 'demo');
  assert.ok(visible(t.$('view-inicio')) && !visible(t.$('view-agendar')));
  await settle(t.doc);
});

test('interface: agendamento completo com validação, confirmação e listagem em Minhas reservas', async () => {
  const t = boot();
  await waitFor(t.doc, () => t.$('lista-servicos').querySelectorAll('.service').length > 0, 'catálogo');
  t.go('#agendar');
  await waitFor(t.doc, () => t.$('agendar-servicos').querySelectorAll('input').length > 0, 'serviços para escolher');
  assert.ok(visible(t.$('view-agendar')));

  // Envio sem escolhas: erros visíveis, nada é criado.
  t.$('form-agendar').dispatch('submit');
  await settle(t.doc);
  assert.match(t.$('erro-servico').textContent, /Escolha um serviço/);
  assert.equal(t.$('erro-servico').hidden, false);

  t.pick(t.$('agendar-servicos').querySelector('input'));
  t.pick(t.$('agendar-barbeiros').querySelector('input'));
  // Sem tocar no calendário, já abre num dia com horário livre (pula dias fechados ou lotados).
  await waitFor(t.doc, () => /horário\(s\) livre\(s\)/.test(t.$('agendar-calendario').querySelector('.status').textContent), 'dia com horário livre automático');
  assert.ok(t.$('agendar-horario-0'), 'primeiro horário tem id estável para o fluxo de tela');
  const startAt = await chooseFirstFreeSlot(t, t.$('agendar-calendario'));
  assert.ok(startAt);
  assert.match(t.$('resumo').textContent, /Corte masculino/);
  assert.match(t.$('resumo').textContent, /Rafael Monteiro/);

  t.type('cad-nome', 'A');
  t.type('cad-telefone', '123');
  t.$('form-agendar').dispatch('submit');
  await settle(t.doc);
  assert.equal(t.$('cad-nome').getAttribute('aria-invalid'), 'true');
  assert.equal(t.$('cad-telefone').getAttribute('aria-invalid'), 'true');
  assert.ok(t.$('agendar-sucesso').hidden);

  t.type('cad-nome', 'Ana Souza');
  t.type('cad-telefone', '11912345678');
  assert.equal(t.$('cad-telefone').value, '(11) 91234-5678', 'máscara de telefone');
  t.$('form-agendar').dispatch('submit');
  await waitFor(t.doc, () => !t.$('agendar-sucesso').hidden, 'confirmação');
  assert.match(t.$('sucesso-detalhe').textContent, /Corte masculino com Rafael Monteiro/);
  assert.equal(t.$('sessao-nome').textContent, 'Ana Souza');

  t.go('#reservas');
  await waitFor(t.doc, () => t.$('lista-reservas').querySelectorAll('.appt').length === 1, 'reserva listada');
  const item = t.$('lista-reservas').querySelector('.appt');
  assert.match(item.textContent, /Confirmado/);
  assert.match(item.textContent, /Rafael Monteiro/);
  assert.ok(t.$('reservas-anonimo').hidden);

  // Reagendar abre o seletor inline sem perder a reserva atual.
  const [reagendar, cancelar] = item.querySelectorAll('.appt-actions button');
  reagendar.click();
  await waitFor(t.doc, () => item.querySelector('.reschedule'), 'painel de reagendamento');
  assert.equal(reagendar.getAttribute('aria-expanded'), 'true');
  await chooseFirstFreeSlot(t, item.querySelector('.reschedule'));
  const confirmar = item.querySelectorAll('.reschedule button').find((b) => /Confirmar novo horário/.test(b.textContent));
  assert.equal(confirmar.disabled, false);
  confirmar.click();
  await waitFor(t.doc, () => /reagendada/.test(t.$('avisos').textContent), 'aviso de reagendamento');

  // Cancelar pede confirmação e libera o horário.
  await waitFor(t.doc, () => t.$('lista-reservas').querySelectorAll('.appt').length === 1 && t.$('lista-reservas').querySelector('.appt') !== item, 'lista recarregada');
  const novo = t.$('lista-reservas').querySelector('.appt');
  novo.querySelectorAll('.appt-actions button')[1].click();
  const sim = novo.querySelectorAll('.appt-actions button').find((b) => /Sim, cancelar/.test(b.textContent));
  sim.click();
  await waitFor(t.doc, () => /Cancelado/.test(t.$('lista-reservas').textContent), 'reserva marcada como cancelada');
  assert.equal(t.$('lista-reservas').querySelectorAll('.appt-actions button').length, 0, 'cancelada não oferece ações');
  assert.equal(cancelar.textContent, 'Cancelar');
  await settle(t.doc);
});

test('interface: recuperação de acesso por código e painel da equipe com agenda e administração', async () => {
  const storage = memoryStorage();
  const first = boot(storage);
  await waitFor(first.doc, () => first.$('lista-servicos').querySelectorAll('.service').length > 0, 'catálogo');
  await settle(first.doc);

  const t = boot(storage);
  await waitFor(t.doc, () => t.$('lista-servicos').querySelectorAll('.service').length > 0, 'catálogo');
  t.go('#reservas');
  await waitFor(t.doc, () => !t.$('reservas-anonimo').hidden, 'tela de acesso');
  t.type('rec-telefone', 'abc');
  t.$('form-recuperar').dispatch('submit');
  await settle(t.doc);
  assert.match(t.$('rec-telefone-erro').textContent, /telefone válido/);

  t.go('#equipe');
  await waitFor(t.doc, () => /DEMONSTRAÇÃO: o primeiro acesso define/.test(t.$('equipe-login-ajuda').textContent), 'ajuda do login demo');
  t.type('equipe-login', 'gerente');
  t.type('equipe-senha', 'curta');
  t.$('form-equipe-login').dispatch('submit');
  await settle(t.doc);
  assert.match(t.$('equipe-senha-erro').textContent, /12 a 128/);
  t.type('equipe-senha', ['senha', 'da', 'demo', 'local'].join('-'));
  t.$('form-equipe-login').dispatch('submit');
  await waitFor(t.doc, () => !t.$('painel').hidden, 'painel');
  await waitFor(t.doc, () => t.$('agenda-colunas').querySelectorAll('.agenda-col').length === 4, 'agenda com 4 barbeiros');
  assert.equal(t.$('ptab-agenda').getAttribute('aria-selected'), 'true');

  // Serviços: criar e ver na lista.
  t.$('ptab-servicos').click();
  await waitFor(t.doc, () => t.$('admin-servicos').querySelectorAll('.admin-item').length >= 5, 'lista de serviços');
  t.type('servico-nome', 'Hidratação');
  t.type('servico-duracao', '30');
  t.type('servico-preco', '35,00');
  t.$('form-servico').dispatch('submit');
  await waitFor(t.doc, () => /Hidratação/.test(t.$('admin-servicos').textContent), 'serviço criado');
  t.type('servico-nome', 'Y');
  t.type('servico-duracao', 'x');
  t.type('servico-preco', 'abc');
  t.$('form-servico').dispatch('submit');
  await settle(t.doc);
  for (const id of ['servico-nome', 'servico-duracao', 'servico-preco']) assert.equal(t.$(id).getAttribute('aria-invalid'), 'true', id);

  // Barbeiros, expediente, bloqueios e dados da barbearia carregam sem erro.
  t.$('ptab-barbeiros').click();
  await waitFor(t.doc, () => t.$('admin-barbeiros').querySelectorAll('form').length === 4, 'barbeiros editáveis');
  t.$('ptab-expediente').click();
  await waitFor(t.doc, () => t.$('expediente-dias').querySelectorAll('.week-row').length === 7, 'expediente semanal');
  t.$('form-expediente').dispatch('submit');
  await waitFor(t.doc, () => /Expediente salvo/.test(t.$('avisos').textContent), 'expediente salvo');
  t.$('ptab-bloqueios').click();
  await waitFor(t.doc, () => /Nenhum bloqueio/.test(t.$('admin-bloqueios').textContent), 'bloqueios');
  t.type('bloqueio-inicio', '10:00');
  t.type('bloqueio-fim', '09:00');
  t.$('form-bloqueio').dispatch('submit');
  await settle(t.doc);
  assert.match(t.$('bloqueio-fim-erro').textContent, /depois do início/);
  t.$('ptab-barbearia').click();
  await waitFor(t.doc, () => t.$('barbearia-nome').value === 'Barber Prime', 'formulário da barbearia');
  t.type('barbearia-endereco', 'Rua das Tesouras, 100 — Centro');
  t.type('barbearia-telefone', '1134567890');
  t.$('form-barbearia').dispatch('submit');
  await waitFor(t.doc, () => /Rua das Tesouras/.test(t.$('contato-endereco').textContent), 'endereço na página inicial');
  assert.match(t.$('contato-telefone').textContent, /\(11\) 3456-7890/);

  t.$('sair').click();
  await waitFor(t.doc, () => t.$('sessao').hidden, 'saiu');
  await settle(t.doc);
});
