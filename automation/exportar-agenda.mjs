#!/usr/bin/env node
// Exporta a agenda para .ics (RFC 5545) e, opcionalmente, para texto legível por profissional/dia.
//
//   node automation/exportar-agenda.mjs --entrada automation/exemplos/agenda-exemplo.json --saida agenda.ics [--texto agenda.txt]
//   DATABASE_URL=... node automation/exportar-agenda.mjs --de 2026-11-16T00:00:00Z --ate 2026-11-23T00:00:00Z --saida agenda.ics
//
// Entrada JSON: lista de reservas ou { shop: { name, timezone, address }, appointments: [...] }.
// Com DATABASE_URL lê do PostgreSQL via db/index.mjs (listAgenda, escopo admin; exige o pacote pg).
// Reservas inválidas são registradas em stderr (JSON por linha) e não interrompem a exportação.
// Códigos de saída: 0 ok; 1 entrada ou argumentos inválidos; 2 banco indisponível.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildCalendar, formatAgendaText, groupAgenda } from './icalendar.mjs';

const OPTIONS = {
  entrada: { type: 'string' },
  saida: { type: 'string' },
  texto: { type: 'string' },
  de: { type: 'string' },
  ate: { type: 'string' },
  profissional: { type: 'string' },
  fuso: { type: 'string' },
  'incluir-cliente': { type: 'boolean', default: false },
};

export class CliError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

function logJson(stream, event) {
  stream.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function requireExtension(path, ext, flag) {
  if (!path.toLowerCase().endsWith(ext)) throw new CliError(`--${flag} precisa terminar em ${ext}`);
  return resolve(path);
}

async function loadFromFile(path) {
  let data;
  try {
    data = JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (err) {
    throw new CliError(`não foi possível ler ${path}: ${err.code ?? err.message}`);
  }
  if (Array.isArray(data)) return { shop: {}, appointments: data };
  if (data && Array.isArray(data.appointments)) return { shop: data.shop ?? {}, appointments: data.appointments };
  throw new CliError('entrada precisa ser uma lista de reservas ou { appointments: [...] }');
}

async function loadFromDatabase({ url, from, to, staffId }) {
  if (!from || !to) throw new CliError('com DATABASE_URL informe --de e --ate (ISO 8601, até 31 dias)');
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    throw new CliError('pacote "pg" não instalado; instale as dependências do backend', 2);
  }
  const db = await import('../db/index.mjs');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const shop = (await db.getShop(pool)) ?? {};
    const appointments = await db.listAgenda(pool, { role: 'admin' },
      { from, to, staffId: staffId ?? null, includeCancelled: true });
    return { shop, appointments };
  } catch (err) {
    if (err?.code === 'VALIDATION_ERROR') throw new CliError(`período inválido: ${err.message}`);
    throw new CliError(`banco indisponível (${err?.code ?? 'erro'})`, 2);
  } finally {
    await pool.end();
  }
}

export async function run(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, now = new Date() } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true }));
  } catch (err) {
    throw new CliError(err.message);
  }
  if (!values.saida) throw new CliError('informe --saida arquivo.ics');
  const icsPath = requireExtension(values.saida, '.ics', 'saida');
  const textPath = values.texto ? requireExtension(values.texto, '.txt', 'texto') : null;

  let source;
  if (values.entrada) source = await loadFromFile(values.entrada);
  else if (env.DATABASE_URL) {
    source = await loadFromDatabase({ url: env.DATABASE_URL, from: values.de, to: values.ate, staffId: values.profissional });
  } else throw new CliError('informe --entrada arquivo.json ou defina DATABASE_URL');

  const timeZone = values.fuso ?? source.shop.timezone ?? 'America/Sao_Paulo';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch {
    throw new CliError(`fuso horário inválido: ${timeZone}`);
  }

  const { ics, exported, skipped } = buildCalendar(source.appointments, {
    calendarName: `${source.shop.name ?? 'Barber Prime'} — Agenda`,
    location: source.shop.address ?? '',
    includeCustomer: values['incluir-cliente'],
    now,
  });
  for (const s of skipped) logJson(stderr, { level: 'warn', event: 'reserva_ignorada', ...s });
  await writeFile(icsPath, ics, 'utf8');
  if (textPath) await writeFile(textPath, formatAgendaText(groupAgenda(source.appointments, { timeZone })), 'utf8');
  const summary = { exportadas: exported, ignoradas: skipped.length, ics: icsPath, texto: textPath };
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2)).catch((err) => {
    logJson(process.stderr, { level: 'error', event: 'exportacao_falhou', message: err.message });
    process.exitCode = err instanceof CliError ? err.exitCode : 1;
  });
}
