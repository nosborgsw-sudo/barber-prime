// Datas locais (YYYY-MM-DD) no fuso IANA da barbearia → instantes UTC.
import { invalid } from './http.mjs';

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function parseLocalDate(value, field) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw invalid(field, 'data YYYY-MM-DD');
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(field, 'data inexistente');
  return value;
}

// Diferença (ms) entre o relógio local do fuso e UTC no instante dado.
function offsetMs(instantMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

// Início (00:00 local) do dia `date` no fuso `timeZone`.
export function startOfLocalDay(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall - offsetMs(wall, timeZone);
  guess = wall - offsetMs(guess, timeZone);
  return new Date(guess);
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function localToday(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
