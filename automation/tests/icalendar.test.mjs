import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliError, run } from '../exportar-agenda.mjs';
import { buildCalendar, escapeText, foldLine, formatAgendaText, groupAgenda, toUtcStamp } from '../icalendar.mjs';

const SAMPLE = fileURLToPath(new URL('../exemplos/agenda-exemplo.json', import.meta.url));
const NOW = new Date('2026-11-14T10:00:00Z');
const sample = async () => JSON.parse(await readFile(SAMPLE, 'utf8'));
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
const sink = () => { const chunks = []; return { write: (c) => chunks.push(c), text: () => chunks.join('') }; };

test('rpa ical: escapa TEXT conforme RFC 5545 §3.3.11', () => {
  assert.equal(escapeText('a\\b;c,d\ne:f'), 'a\\\\b\\;c\\,d\\ne:f');
  assert.equal(escapeText(null), '');
});

test('rpa ical: dobra linhas em até 75 octetos sem partir UTF-8', () => {
  const line = `DESCRIPTION:${'çã'.repeat(80)}`;
  const folded = foldLine(line);
  for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part, 'utf8') <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), line);
  assert.equal(foldLine('CURTA'), 'CURTA');
});

test('rpa ical: instante sai em UTC com Z e data inválida é recusada', () => {
  assert.equal(toUtcStamp('2026-11-17T09:00:00-03:00'), '20261117T120000Z');
  assert.throws(() => toUtcStamp('ontem'), /data inválida/);
});

test('rpa ical: exporta a agenda de exemplo e registra a reserva inválida', async () => {
  const data = await sample();
  const { ics, exported, skipped } = buildCalendar(data.appointments, { location: data.shop.address, now: NOW });
  assert.equal(exported, 4);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, 'registro-invalido');
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'toda quebra é CRLF');
  const flat = unfold(ics);
  assert.equal((flat.match(/BEGIN:VEVENT/g) ?? []).length, 4);
  assert.equal((flat.match(/DTSTAMP:20261114T100000Z/g) ?? []).length, 4);
  assert.ok(flat.includes('UID:6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b@barberprime.app'));
  assert.ok(flat.includes('DTSTART:20261117T120000Z\r\nDTEND:20261117T124500Z'));
  assert.ok(flat.includes('SUMMARY:Cancelado: Barba completa — Rafael Souza'));
  assert.match(flat, /SEQUENCE:2\r\nSTATUS:CANCELLED/);
  assert.ok(flat.includes('Degradê baixo\\; usar máquina 1\\, depois tesoura'));
  assert.ok(flat.includes('LOCATION:Rua Exemplo\\, 100 - Centro\\, São Paulo - SP'));
  assert.ok(!flat.includes('Cliente Exemplo'), 'nome do cliente só com includeCustomer');
});

test('rpa ical: recusa entrada que não é lista', () => {
  assert.throws(() => buildCalendar({}), /lista esperada/);
});

test('rpa agenda legível: agrupa por profissional e dia no fuso da barbearia', async () => {
  const groups = groupAgenda((await sample()).appointments, { timeZone: 'America/Sao_Paulo' });
  assert.deepEqual(groups.map((g) => g.staffName), ['Bruno Lima', 'Rafael Souza']);
  const rafael = groups[1].days[0];
  assert.equal(rafael.date, '2026-11-17');
  assert.deepEqual(rafael.items.map((i) => `${i.start}-${i.end} ${i.statusLabel}`), ['09:00-09:45 Confirmado', '10:00-10:30 Cancelado']);
  const text = formatAgendaText(groups);
  assert.match(text, /== Bruno Lima ==\n {2}2026-11-17\n {4}11:00–12:15 {2}Corte \+ barba/);
  assert.throws(() => groupAgenda([], { timeZone: 'Fuso/Inexistente' }), RangeError);
});

test('rpa exportar-agenda: CLI grava .ics e .txt a partir do JSON de exemplo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-rpa-'));
  try {
    const out = sink();
    const err = sink();
    const summary = await run(['--entrada', SAMPLE, '--saida', join(dir, 'agenda.ics'), '--texto', join(dir, 'agenda.txt')],
      { env: {}, stdout: out, stderr: err, now: NOW });
    assert.equal(summary.exportadas, 4);
    assert.equal(summary.ignoradas, 1);
    assert.match(out.text(), /"exportadas":4/);
    const warn = JSON.parse(err.text().trim());
    assert.equal(warn.event, 'reserva_ignorada');
    assert.equal(warn.id, 'registro-invalido');
    assert.match(await readFile(join(dir, 'agenda.ics'), 'utf8'), /BEGIN:VEVENT/);
    assert.match(await readFile(join(dir, 'agenda.txt'), 'utf8'), /== Rafael Souza ==/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rpa exportar-agenda: recusa argumentos inválidos com mensagem clara', async () => {
  const opts = { env: {}, stdout: sink(), stderr: sink() };
  await assert.rejects(run(['--entrada', SAMPLE], opts), (e) => e instanceof CliError && /--saida/.test(e.message));
  await assert.rejects(run(['--entrada', SAMPLE, '--saida', 'x.exe'], opts), /terminar em \.ics/);
  await assert.rejects(run(['--saida', 'x.ics'], opts), /DATABASE_URL/);
  await assert.rejects(run(['--entrada', 'nao-existe.json', '--saida', 'x.ics'], opts), /ENOENT/);
  await assert.rejects(run(['--entrada', SAMPLE, '--saida', 'x.ics', '--fuso', 'Lua/Base'], opts), /fuso horário inválido/);
  await assert.rejects(run(['--desconhecido'], opts), (e) => e instanceof CliError && e.exitCode === 1);
});
