// Exportação da agenda (frente RPA): iCalendar RFC 5545 e visão legível por profissional/dia.
// Funções puras: recebem as linhas de reserva no formato de db/repositorios.mjs (listAgenda,
// getAppointment, listAppointmentsForCustomer) e não acessam rede nem disco.
//
// Regras seguidas (RFC 5545):
// - linhas terminam em CRLF e não passam de 75 octetos; continuação começa com um espaço (§3.1);
// - TEXT escapa \ ; , e quebra de linha como \\ \; \, \n; dois-pontos não é escapado (§3.3.11);
// - VEVENT tem UID e DTSTAMP (§3.6.1); instantes em UTC com sufixo Z (§3.3.5).

const CRLF = '\r\n';
const MAX_OCTETS = 75;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_LABEL = { confirmed: 'Confirmado', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Não compareceu' };

export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Dobra por octetos UTF-8 sem partir um caractere multibyte ao meio.
export function foldLine(line) {
  const parts = [];
  let current = '';
  let octets = 0;
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (octets + size > limit) {
      parts.push(current);
      current = ' ';
      octets = 1;
      limit = MAX_OCTETS;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join(CRLF);
}

function toDate(value, field) {
  const d = value instanceof Date ? value : new Date(value);
  if (typeof value !== 'string' && !(value instanceof Date)) throw new TypeError(`${field}: data ausente`);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${field}: data inválida`);
  return d;
}

export function toUtcStamp(value, field = 'data') {
  return toDate(value, field).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function checkAppointment(a) {
  if (!a || typeof a !== 'object') throw new TypeError('reserva: objeto esperado');
  if (typeof a.id !== 'string' || !UUID_RE.test(a.id)) throw new TypeError('id: UUID inválido');
  const start = toDate(a.startAt, 'startAt');
  const end = toDate(a.endAt, 'endAt');
  if (end <= start) throw new TypeError('endAt: precisa ser depois de startAt');
  return { start, end };
}

/**
 * Monta um VCALENDAR com um VEVENT por reserva.
 * Reservas inválidas não derrubam a exportação: vão para `skipped` com o motivo.
 * Telefone do cliente nunca entra no arquivo; o nome só com includeCustomer.
 */
export function buildCalendar(appointments, {
  calendarName = 'Barber Prime — Agenda',
  location = '',
  uidDomain = 'barberprime.app',
  includeCustomer = false,
  now = new Date(),
} = {}) {
  if (!Array.isArray(appointments)) throw new TypeError('appointments: lista esperada');
  const stamp = toUtcStamp(now, 'now');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Barber Prime//Agenda//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  const skipped = [];
  let exported = 0;
  for (const [index, a] of appointments.entries()) {
    try {
      const { start, end } = checkAppointment(a);
      const summary = [a.serviceName, a.staffName].filter(Boolean).join(' — ') || 'Atendimento';
      const description = [
        a.staffName ? `Profissional: ${a.staffName}` : null,
        includeCustomer && a.customerName ? `Cliente: ${a.customerName}` : null,
        Number.isInteger(a.priceCents) ? `Valor: ${formatCents(a.priceCents)}` : null,
        a.notes ? `Observações: ${a.notes}` : null,
      ].filter(Boolean).join('\n');
      const version = Number.isInteger(a.version) && a.version >= 1 ? a.version : 1;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${a.id.toLowerCase()}@${uidDomain}`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${toUtcStamp(start)}`,
        `DTEND:${toUtcStamp(end)}`,
        `SEQUENCE:${version - 1}`,
        `STATUS:${a.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
        `SUMMARY:${escapeText(a.status === 'cancelled' ? `Cancelado: ${summary}` : summary)}`,
      );
      if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
      if (location) lines.push(`LOCATION:${escapeText(location)}`);
      lines.push('TRANSP:OPAQUE', 'END:VEVENT');
      exported += 1;
    } catch (err) {
      skipped.push({ index, id: typeof a?.id === 'string' ? a.id.slice(0, 64) : null, reason: err.message });
    }
  }
  lines.push('END:VCALENDAR');
  return { ics: lines.map(foldLine).join(CRLF) + CRLF, exported, skipped };
}

export function formatCents(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function localParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Agrupa por profissional e por dia local do estabelecimento, em ordem de horário.
 * Saída: [{ staffName, days: [{ date, items: [{ start, end, serviceName, status, statusLabel }] }] }]
 */
export function groupAgenda(appointments, { timeZone = 'America/Sao_Paulo' } = {}) {
  new Intl.DateTimeFormat('en-CA', { timeZone }); // fuso inválido lança RangeError aqui
  const byStaff = new Map();
  const valid = [];
  for (const a of appointments) {
    try { valid.push({ a, ...checkAppointment(a) }); } catch { /* inválidas ficam fora; buildCalendar relata */ }
  }
  valid.sort((x, y) => x.start - y.start);
  for (const { a, start, end } of valid) {
    const staffName = a.staffName || 'Sem profissional';
    const s = localParts(start, timeZone);
    const e = localParts(end, timeZone);
    if (!byStaff.has(staffName)) byStaff.set(staffName, new Map());
    const days = byStaff.get(staffName);
    if (!days.has(s.day)) days.set(s.day, []);
    days.get(s.day).push({
      start: s.time,
      end: e.day === s.day ? e.time : `${e.time} (${e.day})`,
      serviceName: a.serviceName || 'Atendimento',
      status: a.status,
      statusLabel: STATUS_LABEL[a.status] ?? String(a.status ?? ''),
    });
  }
  return [...byStaff.entries()]
    .sort(([x], [y]) => x.localeCompare(y, 'pt-BR'))
    .map(([staffName, days]) => ({
      staffName,
      days: [...days.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([date, items]) => ({ date, items })),
    }));
}

// Texto simples para impressão ou envio: uma seção por profissional, colunas alinhadas.
export function formatAgendaText(groups) {
  const out = [];
  for (const g of groups) {
    out.push(`== ${g.staffName} ==`);
    for (const d of g.days) {
      out.push(`  ${d.date}`);
      for (const i of d.items) {
        out.push(`    ${i.start}–${i.end}  ${i.serviceName.padEnd(24)}  ${i.statusLabel}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}
