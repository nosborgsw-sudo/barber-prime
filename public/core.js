// Barber Prime — funções puras compartilhadas pela tela operacional e pela demonstração.
// Script clássico (sem módulos) para funcionar também dentro do HTML autônomo.
(function (root) {
  'use strict';

  // Mesma regra de db/telefone.mjs: DDD válido, celular com 9 dígitos começando em 9, fixo de 2 a 5.
  const DDD_VALIDOS = new Set([
    11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
    41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
    71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
  ]);

  function normalizePhoneBR(input) {
    if (typeof input !== 'string' || input.length > 40) return null;
    if (!/^[\d\s()+.-]+$/.test(input)) return null;
    let digits = input.replace(/\D/g, '');
    if (input.trim().startsWith('+')) {
      if (!digits.startsWith('55')) return null;
      digits = digits.slice(2);
    } else if (digits.length >= 12 && digits.startsWith('55')) {
      digits = digits.slice(2);
    } else if (digits.startsWith('0')) {
      digits = digits.replace(/^0+/, '');
    }
    if (digits.length !== 10 && digits.length !== 11) return null;
    if (!DDD_VALIDOS.has(Number(digits.slice(0, 2)))) return null;
    const local = digits.slice(2);
    if (local.length === 9 && local[0] !== '9') return null;
    if (local.length === 8 && !/^[2-5]/.test(local)) return null;
    return '+55' + digits;
  }

  function formatPhoneBR(e164) {
    if (typeof e164 !== 'string') return '';
    const d = e164.replace(/^\+55/, '');
    if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
    if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return e164;
  }

  // Máscara progressiva para o campo de telefone enquanto a pessoa digita.
  function maskPhoneInput(value) {
    const d = String(value).replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d.length ? '(' + d : '';
    if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  }

  function validateName(value) {
    const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2) return { ok: false, message: 'Informe seu nome (mínimo de 2 letras).' };
    if (name.length > 100) return { ok: false, message: 'O nome pode ter no máximo 100 caracteres.' };
    if (!/\p{L}/u.test(name)) return { ok: false, message: 'O nome precisa conter letras.' };
    if (/[<>]/.test(name)) return { ok: false, message: 'Remova os caracteres < e >.' };
    return { ok: true, value: name };
  }

  function validatePhone(value) {
    const phone = normalizePhoneBR(typeof value === 'string' ? value : '');
    if (!phone) return { ok: false, message: 'Informe um telefone válido com DDD, por exemplo (11) 91234-5678.' };
    return { ok: true, value: phone };
  }

  function validateCode(value) {
    const code = typeof value === 'string' ? value.trim() : '';
    if (!/^\d{6}$/.test(code)) return { ok: false, message: 'O código tem 6 dígitos.' };
    return { ok: true, value: code };
  }

  function validateStaffLogin(login, password) {
    const fields = {};
    const l = typeof login === 'string' ? login.trim() : '';
    if (l.length < 3 || l.length > 100) fields.login = 'Informe o login (3 a 100 caracteres).';
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      fields.password = 'A senha tem de 12 a 128 caracteres.';
    }
    return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: { login: l, password } };
  }

  function validateServiceInput({ name, durationMinutes, priceCents }) {
    const fields = {};
    const n = typeof name === 'string' ? name.trim() : '';
    if (n.length < 2 || n.length > 100) fields.name = 'Nome de 2 a 100 caracteres.';
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
      fields.durationMinutes = 'Duração inteira entre 5 e 480 minutos.';
    }
    if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 1000000) {
      fields.priceCents = 'Preço entre R$ 0,00 e R$ 10.000,00.';
    }
    return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value: { name: n, durationMinutes, priceCents } };
  }

  // "60,00", "60", "R$ 1.234,50" → centavos inteiros; null se inválido.
  function parseMoneyToCents(text) {
    if (typeof text !== 'string') return null;
    const clean = text.replace(/R\$|\s/g, '');
    if (!/^\d{1,3}(\.?\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(clean)) return null;
    const [int, frac = ''] = clean.replace(/\./g, '').split(',');
    return Number(int) * 100 + Number((frac + '00').slice(0, 2));
  }

  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  function formatMoney(cents) {
    return Number.isInteger(cents) ? BRL.format(cents / 100) : '';
  }

  function formatDuration(minutes) {
    if (!Number.isInteger(minutes) || minutes <= 0) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h) return m + ' min';
    return m ? h + 'h' + String(m).padStart(2, '0') : h + 'h';
  }

  // ---- Datas no fuso IANA da barbearia --------------------------------------------------------

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

  function todayIn(timeZone, now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now || new Date());
  }

  function addDays(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return dt.toISOString().slice(0, 10);
  }

  function weekdayOf(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  // Deslocamento (minutos) do fuso no instante dado: horário local - UTC.
  function tzOffsetMinutes(timeZone, epochMs) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(epochMs));
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
  }

  // Data + hora locais do estabelecimento → instante ISO UTC.
  function zonedToInstant(isoDate, hhmm, timeZone) {
    if (!ISO_DATE.test(isoDate) || !HH_MM.test(hhmm)) return null;
    const [y, m, d] = isoDate.split('-').map(Number);
    const [hh, mm] = hhmm.split(':').map(Number);
    const wall = Date.UTC(y, m - 1, d, hh, mm);
    let guess = wall - tzOffsetMinutes(timeZone, wall) * 60000;
    guess = wall - tzOffsetMinutes(timeZone, guess) * 60000;
    return new Date(guess).toISOString();
  }

  function localDateOf(instant, timeZone) {
    return todayIn(timeZone, new Date(instant));
  }

  function formatTime(instant, timeZone) {
    return new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(instant));
  }

  function formatDateLong(isoDateOrInstant, timeZone) {
    const date = ISO_DATE.test(isoDateOrInstant)
      ? new Date(isoDateOrInstant + 'T12:00:00Z')
      : new Date(isoDateOrInstant);
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: ISO_DATE.test(isoDateOrInstant) ? 'UTC' : timeZone,
      weekday: 'long', day: '2-digit', month: 'long',
    }).format(date);
  }

  function dayChip(isoDate) {
    const date = new Date(isoDate + 'T12:00:00Z');
    const f = (o) => new Intl.DateTimeFormat('pt-BR', Object.assign({ timeZone: 'UTC' }, o)).format(date);
    return { weekday: f({ weekday: 'short' }).replace('.', ''), day: f({ day: '2-digit' }), month: f({ month: 'short' }).replace('.', '') };
  }

  // Intervalos semiabertos [início, fim): atendimentos encostados não conflitam.
  function overlaps(aStart, aEnd, bStart, bEnd) {
    return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
  }

  const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

  const STATUS_LABEL = { confirmed: 'Confirmado', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Não compareceu' };

  function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  function initials(name) {
    return String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  }

  // Mensagem amigável para os erros padronizados do contrato.
  function errorMessage(error) {
    if (!error) return 'Algo deu errado. Tente novamente.';
    const byCode = {
      SLOT_CONFLICT: 'Esse horário acabou de ser ocupado. Escolha outro horário.',
      VERSION_CONFLICT: 'Os dados mudaram desde a última leitura. Atualize e tente de novo.',
      IDEMPOTENCY_CONFLICT: 'Essa solicitação já foi enviada com outros dados. Recarregue a página.',
      SCHEDULE_CONFLICT: 'A alteração afeta reservas confirmadas. Remaneje essas reservas antes.',
      NETWORK_ERROR: 'Sem conexão com o servidor. Verifique a internet e tente novamente.',
    };
    if (error.code && byCode[error.code]) return byCode[error.code];
    const byStatus = {
      401: 'Sua sessão expirou ou você ainda não entrou.',
      403: 'Você não tem permissão para esta ação.',
      404: 'Não encontrado ou indisponível para você.',
      409: 'Conflito com outra alteração. Atualize e tente de novo.',
      422: 'A operação não é permitida por uma regra da barbearia.',
      429: 'Muitas tentativas. Aguarde um pouco e tente de novo.',
      503: 'Serviço temporariamente indisponível. Tente mais tarde.',
    };
    return error.message || byStatus[error.status] || 'Algo deu errado. Tente novamente.';
  }

  function ApiError(status, code, message, fields) {
    const e = new Error(message || code || 'Erro');
    e.name = 'ApiError';
    e.status = status;
    e.code = code;
    e.fields = fields || null;
    return e;
  }

  root.BPCore = {
    normalizePhoneBR, formatPhoneBR, maskPhoneInput, validateName, validatePhone, validateCode,
    validateStaffLogin, validateServiceInput, parseMoneyToCents, formatMoney, formatDuration,
    todayIn, addDays, weekdayOf, tzOffsetMinutes, zonedToInstant, localDateOf, formatTime,
    formatDateLong, dayChip, overlaps, WEEKDAYS, STATUS_LABEL, isUuid, initials, errorMessage, ApiError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
