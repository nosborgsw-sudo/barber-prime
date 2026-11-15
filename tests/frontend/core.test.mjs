import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, plain } from './apoio.mjs';

const C = loadScripts(['public/core.js']).BPCore;

test('frontend core: telefone brasileiro é normalizado para E.164 e recusa entradas inválidas', () => {
  assert.equal(C.normalizePhoneBR('(11) 91234-5678'), '+5511912345678');
  assert.equal(C.normalizePhoneBR('+55 21 3456-7890'), '+552134567890');
  assert.equal(C.normalizePhoneBR('011912345678'), '+5511912345678');
  for (const bad of ['', '1234', '(00) 91234-5678', '(11) 81234-5678', '+1 415 555 0100', '11 91234-5678<script>', null]) {
    assert.equal(C.normalizePhoneBR(bad), null, String(bad));
  }
  assert.equal(C.formatPhoneBR('+5511912345678'), '(11) 91234-5678');
  assert.equal(C.maskPhoneInput('11912345678'), '(11) 91234-5678');
});

test('frontend core: validação de nome, código, login da equipe e serviço', () => {
  assert.equal(C.validateName('  Ana   Souza ').value, 'Ana Souza');
  assert.equal(C.validateName('A').ok, false);
  assert.equal(C.validateName('<b>Ana</b>').ok, false);
  assert.equal(C.validateName('x'.repeat(101)).ok, false);
  assert.equal(C.validateCode('123456').ok, true);
  assert.equal(C.validateCode('12345a').ok, false);
  assert.deepEqual(Object.keys(C.validateStaffLogin('ad', 'curta').fields).sort(), ['login', 'password']);
  assert.equal(C.validateStaffLogin('admin', 'x'.repeat(12)).ok, true);
  assert.equal(C.validateServiceInput({ name: 'Corte', durationMinutes: 45, priceCents: 6000 }).ok, true);
  assert.deepEqual(Object.keys(C.validateServiceInput({ name: 'C', durationMinutes: 4.5, priceCents: -1 }).fields).sort(),
    ['durationMinutes', 'name', 'priceCents']);
});

test('frontend core: dinheiro em centavos inteiros e duração legível', () => {
  assert.equal(C.parseMoneyToCents('60,00'), 6000);
  assert.equal(C.parseMoneyToCents('R$ 1.234,5'), 123450);
  assert.equal(C.parseMoneyToCents('60'), 6000);
  assert.equal(C.parseMoneyToCents('6,001'), null);
  assert.equal(C.parseMoneyToCents('abc'), null);
  assert.match(C.formatMoney(9500), /R\$\s?95,00/);
  assert.equal(C.formatDuration(45), '45 min');
  assert.equal(C.formatDuration(75), '1h15');
});

test('frontend core: datas no fuso da barbearia e intervalos semiabertos', () => {
  const tz = 'America/Sao_Paulo';
  assert.equal(C.zonedToInstant('2026-11-16', '09:00', tz), '2026-11-16T12:00:00.000Z');
  assert.equal(C.zonedToInstant('2026-11-16', '24:00', tz), null);
  assert.equal(C.localDateOf('2026-11-17T02:30:00.000Z', tz), '2026-11-16');
  assert.equal(C.formatTime('2026-11-16T12:00:00.000Z', tz), '09:00');
  assert.equal(C.weekdayOf('2026-11-16'), 1);
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(C.todayIn(tz, new Date('2026-11-15T02:00:00Z')), '2026-11-14');
  assert.equal(C.overlaps('2026-11-16T12:00:00Z', '2026-11-16T12:45:00Z', '2026-11-16T12:45:00Z', '2026-11-16T13:30:00Z'), false);
  assert.equal(C.overlaps('2026-11-16T12:00:00Z', '2026-11-16T12:46:00Z', '2026-11-16T12:45:00Z', '2026-11-16T13:30:00Z'), true);
});

test('frontend core: mensagens de erro do contrato', () => {
  assert.match(C.errorMessage({ code: 'SLOT_CONFLICT' }), /ocupado/);
  assert.match(C.errorMessage({ code: 'NETWORK_ERROR' }), /conexão/);
  const e = C.ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', { phone: 'x' });
  assert.deepEqual(plain({ status: e.status, code: e.code, fields: e.fields }), { status: 400, code: 'VALIDATION_ERROR', fields: { phone: 'x' } });
});
