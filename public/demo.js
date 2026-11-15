// Barber Prime — adaptador de DEMONSTRAÇÃO: mesma interface do adaptador HTTP, dados só no localStorage.
// Usado exclusivamente pelo app-autonomo.html (offline). Não é o sistema operacional nem substitui o backend.
(function (root) {
  'use strict';
  const C = root.BPCore;
  const { ApiError } = C;
  const KEY = 'barberprime.demo.v1';
  const TZ = 'America/Sao_Paulo';
  const STEP = 15;
  const HORIZON_DAYS = 60;

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    const b = [];
    for (let i = 0; i < 16; i++) b.push(Math.floor(Math.random() * 256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // Hash apenas para não guardar a senha da demonstração em texto puro no navegador (não é proteção de produção).
  function demoHash(salt, text) {
    let h = 0x811c9dc5;
    const s = salt + ':' + text;
    for (let round = 0; round < 500; round++) {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      h ^= round;
    }
    return h.toString(16);
  }

  function seed() {
    const barbers = [
      ['Rafael Monteiro', 'Cortes clássicos e navalhado.'],
      ['Diego Alencar', 'Degradê e desenhos.'],
      ['Lucas Ferraz', 'Barba terapia e acabamento.'],
      ['Bruno Tavares', 'Cortes modernos e texturizados.'],
    ].map(([name, bio]) => ({ id: uuid(), name, bio, role: 'barber', active: true, version: 1 }));
    const services = [
      ['Corte masculino', 'Corte com lavagem e finalização.', 45, 6000],
      ['Barba completa', 'Toalha quente, navalha e hidratação.', 30, 4500],
      ['Corte + barba', 'Combo completo.', 75, 9500],
      ['Pezinho e sobrancelha', 'Acabamento rápido.', 15, 2500],
      ['Pigmentação', 'Correção de falhas em barba ou cabelo.', 60, 8000],
    ].map(([name, description, durationMinutes, priceCents]) => ({ id: uuid(), name, description, durationMinutes, priceCents, active: true, version: 1 }));
    const hours = {};
    for (const b of barbers) {
      hours[b.id] = [1, 2, 3, 4, 5, 6].map((weekday) => ({
        id: uuid(), staffId: b.id, weekday, startLocal: '09:00', endLocal: '19:00', validFrom: '2026-01-01', validUntil: null, version: 1,
      }));
    }
    return {
      shop: {
        id: uuid(), name: 'Barber Prime', timezone: TZ,
        address: 'Endereço fictício da demonstração — configure no painel', contactPhone: null, version: 1,
      },
      staff: barbers, services, hours, blocks: [], appointments: [], customers: [], idempotency: {},
      admin: null, challenges: [],
    };
  }

  function createDemoAdapter(options) {
    const opts = options || {};
    const storage = opts.storage || root.localStorage;
    const now = opts.now || (() => new Date());
    let state;
    try {
      state = JSON.parse(storage.getItem(KEY) || 'null');
    } catch {
      state = null;
    }
    if (!state || !state.shop) {
      state = seed();
    }
    let session = state.session || { role: 'anonymous', principalId: null };

    function save() {
      state.session = session;
      storage.setItem(KEY, JSON.stringify(state));
    }
    save();

    const delay = (v) => new Promise((resolve) => setTimeout(() => resolve(v), opts.latency ?? 120));
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const ok = (v) => delay(clone(v));
    const fail = (status, code, message, fields) => Promise.reject(ApiError(status, code, message, fields));

    function requireRole(...roles) {
      if (session.role === 'anonymous') throw ApiError(401, 'UNAUTHENTICATED', 'Entre para continuar.');
      if (!roles.includes(session.role)) throw ApiError(403, 'FORBIDDEN', null);
    }

    function canSee(a) {
      if (session.role === 'admin') return true;
      if (session.role === 'customer') return a.customerId === session.principalId;
      if (session.role === 'barber') return a.staffId === session.principalId;
      return false;
    }

    function findVisible(id) {
      const a = state.appointments.find((x) => x.id === id);
      if (!a || !canSee(a)) throw ApiError(404, 'NOT_FOUND', null);
      return a;
    }

    function hoursFor(staffId, date) {
      const wd = C.weekdayOf(date);
      return (state.hours[staffId] || []).filter((h) => h.weekday === wd && h.validFrom <= date && (!h.validUntil || h.validUntil >= date));
    }

    function busy(staffId, ignoreId) {
      const a = state.appointments
        .filter((x) => x.staffId === staffId && x.status === 'confirmed' && x.id !== ignoreId)
        .map((x) => [x.startAt, x.endAt]);
      const b = state.blocks.filter((x) => x.staffId === staffId).map((x) => [x.startAt, x.endAt]);
      return a.concat(b);
    }

    function slotsFor(staffId, service, date, ignoreId) {
      const today = C.todayIn(TZ, now());
      if (date < today || date > C.addDays(today, HORIZON_DAYS)) return [];
      const taken = busy(staffId, ignoreId);
      const out = [];
      for (const h of hoursFor(staffId, date)) {
        const [sh, sm] = h.startLocal.split(':').map(Number);
        const [eh, em] = h.endLocal.split(':').map(Number);
        for (let t = sh * 60 + sm; t + service.durationMinutes <= eh * 60 + em; t += STEP) {
          const hhmm = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
          const startAt = C.zonedToInstant(date, hhmm, TZ);
          const endAt = new Date(new Date(startAt).getTime() + service.durationMinutes * 60000).toISOString();
          if (new Date(startAt) <= now()) continue;
          if (taken.some(([s, e]) => C.overlaps(startAt, endAt, s, e))) continue;
          out.push({ startAt, endAt });
        }
      }
      return out;
    }

    function activeBarber(id) {
      const s = state.staff.find((x) => x.id === id && x.active && x.role === 'barber');
      if (!s) throw ApiError(404, 'NOT_FOUND', 'Barbeiro indisponível.');
      return s;
    }

    function slotIsFree(staffId, service, startAt, ignoreId) {
      if (Number.isNaN(Date.parse(startAt))) throw ApiError(400, 'VALIDATION_ERROR', null, { startAt: 'Horário inválido.' });
      const date = C.localDateOf(startAt, TZ);
      const iso = new Date(startAt).toISOString();
      return slotsFor(staffId, service, date, ignoreId).some((s) => s.startAt === iso);
    }

    function project(a) {
      const out = clone(a);
      const st = state.staff.find((s) => s.id === a.staffId);
      const sv = state.services.find((s) => s.id === a.serviceId);
      out.staffName = st ? st.name : '';
      out.serviceName = sv ? sv.name : '';
      if (session.role === 'customer') delete out.customerName;
      return out;
    }

    // Mesmo formato pedido ao backend: por dia, menor início e maior fim entre barbeiros ativos.
    function openingHours() {
      const byDay = {};
      for (const s of state.staff.filter((x) => x.active && x.role === 'barber')) {
        for (const h of state.hours[s.id] || []) {
          const d = byDay[h.weekday];
          byDay[h.weekday] = d
            ? { weekday: h.weekday, startLocal: h.startLocal < d.startLocal ? h.startLocal : d.startLocal, endLocal: h.endLocal > d.endLocal ? h.endLocal : d.endLocal }
            : { weekday: h.weekday, startLocal: h.startLocal, endLocal: h.endLocal };
        }
      }
      return Object.values(byDay).sort((a, b) => a.weekday - b.weekday);
    }

    function wrap(fn) {
      return (...args) => {
        try {
          const r = fn(...args);
          return r && typeof r.then === 'function' ? r : ok(r);
        } catch (e) {
          return delay().then(() => { throw e; });
        }
      };
    }

    return {
      mode: 'demo',
      isDemo: true,
      shop: wrap(() => Object.assign({}, state.shop, { openingHours: openingHours() })),
      staff: wrap(() => state.staff.filter((s) => s.active && s.role === 'barber').map(({ id, name, bio, role }) => ({ id, name, bio, role }))),
      services: wrap(() => state.services.filter((s) => s.active)),
      adminStaff: wrap(() => { requireRole('admin'); return state.staff; }),
      adminServices: wrap(() => { requireRole('admin'); return state.services; }),
      availability: wrap(({ staffId, serviceId, date }) => {
        if (!C.isUuid(staffId) || !C.isUuid(serviceId) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
          throw ApiError(400, 'VALIDATION_ERROR', 'Parâmetros inválidos.');
        }
        activeBarber(staffId);
        const service = state.services.find((s) => s.id === serviceId && s.active);
        if (!service) throw ApiError(404, 'NOT_FOUND', 'Serviço indisponível.');
        return { staffId, serviceId, date, timezone: TZ, slots: slotsFor(staffId, service, date) };
      }),
      me: wrap(() => {
        if (session.role === 'customer') {
          const c = state.customers.find((x) => x.id === session.principalId);
          return c ? { id: c.id, name: c.name, role: 'customer' } : null;
        }
        if (session.role === 'admin') return { id: 'admin', name: 'Administrador (demonstração)', role: 'admin' };
        return null;
      }),
      register: wrap(({ name, phone }) => {
        const n = C.validateName(name);
        const p = C.validatePhone(phone);
        const fields = {};
        if (!n.ok) fields.name = n.message;
        if (!p.ok) fields.phone = p.message;
        if (Object.keys(fields).length) throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', fields);
        // Telefone já cadastrado nunca concede acesso: mesma resposta genérica, sessão inalterada.
        if (!state.customers.some((c) => c.phone === p.value)) {
          const c = { id: uuid(), name: n.value, phone: p.value, phoneVerifiedAt: null, createdAt: now().toISOString(), version: 1 };
          state.customers.push(c);
          session = { role: 'customer', principalId: c.id };
          save();
        }
        return { message: 'Solicitação recebida. Continue no dispositivo ou verifique a posse do telefone.' };
      }),
      requestChallenge: wrap(({ phone }) => {
        const p = C.validatePhone(phone);
        if (!p.ok) throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', { phone: p.message });
        const customer = state.customers.find((c) => c.phone === p.value);
        const code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
        const ch = { id: uuid(), customerId: customer ? customer.id : null, codeHash: demoHash('ch', code), expiresAt: Date.now() + 5 * 60000, attempts: 0, consumed: false };
        state.challenges.push(ch);
        save();
        // Sem provedor de SMS offline: a demonstração mostra o código na tela (somente aqui, nunca no produto).
        return { challengeId: ch.id, message: 'Se possível, enviaremos as instruções.', demoCode: customer ? code : null };
      }),
      verifyChallenge: wrap(({ challengeId, code }) => {
        const ch = state.challenges.find((x) => x.id === challengeId);
        const generic = () => ApiError(401, 'INVALID_CHALLENGE', 'Código inválido ou expirado.');
        if (!ch || ch.consumed || ch.expiresAt < Date.now() || ch.attempts >= 5) throw generic();
        ch.attempts += 1;
        if (ch.codeHash !== demoHash('ch', String(code)) || !ch.customerId) {
          save();
          throw generic();
        }
        ch.consumed = true;
        const c = state.customers.find((x) => x.id === ch.customerId);
        c.phoneVerifiedAt = now().toISOString();
        session = { role: 'customer', principalId: c.id };
        save();
        return { role: 'customer' };
      }),
      login: wrap(({ login, password }) => {
        const v = C.validateStaffLogin(login, password);
        if (!v.ok) throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', v.fields);
        if (!state.admin) {
          const salt = uuid();
          state.admin = { login: v.value.login, salt, hash: demoHash(salt, password) };
        } else if (state.admin.login !== v.value.login || state.admin.hash !== demoHash(state.admin.salt, password)) {
          throw ApiError(401, 'INVALID_CREDENTIALS', 'Login ou senha incorretos.');
        }
        session = { role: 'admin', principalId: 'admin' };
        save();
        return { id: 'admin', role: 'admin' };
      }),
      logout: wrap(() => {
        session = { role: 'anonymous', principalId: null };
        save();
        return null;
      }),
      createAppointment: wrap((body, idempotencyKey) => {
        requireRole('customer', 'admin');
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
          throw ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key inválida.');
        }
        const prior = state.idempotency[idempotencyKey];
        if (prior) {
          if (prior.body !== JSON.stringify(body)) throw ApiError(409, 'IDEMPOTENCY_CONFLICT', null);
          return project(state.appointments.find((a) => a.id === prior.id));
        }
        const barber = activeBarber(body.staffId);
        const service = state.services.find((s) => s.id === body.serviceId && s.active);
        if (!service) throw ApiError(404, 'NOT_FOUND', 'Serviço indisponível.');
        const notes = typeof body.notes === 'string' ? body.notes.slice(0, 500) : '';
        let customerId = session.principalId;
        if (session.role === 'admin') {
          if (!state.customers.some((c) => c.id === body.customerId)) throw ApiError(404, 'NOT_FOUND', 'Cliente não encontrado.');
          customerId = body.customerId;
        }
        if (!slotIsFree(barber.id, service, body.startAt)) throw ApiError(409, 'SLOT_CONFLICT', null);
        const startAt = new Date(body.startAt).toISOString();
        const customer = state.customers.find((c) => c.id === customerId);
        const a = {
          id: uuid(), customerId, customerName: customer ? customer.name : 'Cliente', staffId: barber.id, serviceId: service.id,
          startAt, endAt: new Date(Date.parse(startAt) + service.durationMinutes * 60000).toISOString(),
          durationMinutes: service.durationMinutes, priceCents: service.priceCents, status: 'confirmed', notes,
          version: 1, createdAt: now().toISOString(),
        };
        state.appointments.push(a);
        state.idempotency[idempotencyKey] = { id: a.id, body: JSON.stringify(body) };
        save();
        return project(a);
      }),
      listAppointments: wrap(({ from, to, staffId } = {}) => {
        requireRole('customer', 'barber', 'admin');
        const list = state.appointments
          .filter(canSee)
          .filter((a) => !staffId || a.staffId === staffId)
          .filter((a) => {
            const d = C.localDateOf(a.startAt, TZ);
            return (!from || d >= from) && (!to || d <= to);
          })
          .sort((a, b) => a.startAt.localeCompare(b.startAt));
        return { data: list.map(project), meta: { cursor: null } };
      }),
      getAppointment: wrap((id) => {
        requireRole('customer', 'barber', 'admin');
        return project(findVisible(id));
      }),
      reschedule: wrap((id, { staffId, startAt, version }) => {
        requireRole('customer', 'admin');
        const a = findVisible(id);
        if (a.version !== version) throw ApiError(409, 'VERSION_CONFLICT', null);
        if (a.status !== 'confirmed') throw ApiError(422, 'BUSINESS_RULE', 'Somente reservas confirmadas podem ser reagendadas.');
        const barber = activeBarber(staffId);
        const service = state.services.find((s) => s.id === a.serviceId) || { durationMinutes: a.durationMinutes };
        const svc = { durationMinutes: a.durationMinutes, id: service.id };
        // Conflito mantém a reserva original intacta.
        if (!slotIsFree(barber.id, svc, startAt, a.id)) throw ApiError(409, 'SLOT_CONFLICT', null);
        a.staffId = barber.id;
        a.startAt = new Date(startAt).toISOString();
        a.endAt = new Date(Date.parse(a.startAt) + a.durationMinutes * 60000).toISOString();
        a.version += 1;
        save();
        return project(a);
      }),
      cancel: wrap((id, { version }) => {
        requireRole('customer', 'admin');
        const a = findVisible(id);
        if (a.status === 'cancelled') return project(a);
        if (a.version !== version) throw ApiError(409, 'VERSION_CONFLICT', null);
        if (a.status !== 'confirmed') throw ApiError(422, 'BUSINESS_RULE', 'Atendimento já encerrado não pode ser cancelado.');
        a.status = 'cancelled';
        a.version += 1;
        save();
        return project(a);
      }),
      setStatus: wrap((id, { status, version }) => {
        requireRole('barber', 'admin');
        const a = findVisible(id);
        if (!['completed', 'no_show'].includes(status)) throw ApiError(400, 'VALIDATION_ERROR', null, { status: 'Status inválido.' });
        if (a.version !== version) throw ApiError(409, 'VERSION_CONFLICT', null);
        if (a.status !== 'confirmed') throw ApiError(422, 'BUSINESS_RULE', 'Reserva não está confirmada.');
        a.status = status;
        a.version += 1;
        save();
        return project(a);
      }),
      updateShop: wrap((body) => {
        requireRole('admin');
        if (body.version !== state.shop.version) throw ApiError(409, 'VERSION_CONFLICT', null);
        const fields = {};
        if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 100)) fields.name = 'Nome de 1 a 100 caracteres.';
        if (body.address !== undefined && (typeof body.address !== 'string' || body.address.length > 300)) fields.address = 'Endereço até 300 caracteres.';
        let phone = state.shop.contactPhone;
        if (body.contactPhone !== undefined) {
          if (body.contactPhone === '' || body.contactPhone === null) phone = null;
          else {
            phone = C.normalizePhoneBR(body.contactPhone);
            if (!phone) fields.contactPhone = 'Telefone inválido.';
          }
        }
        if (Object.keys(fields).length) throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', fields);
        if (body.name !== undefined) state.shop.name = body.name.trim();
        if (body.address !== undefined) state.shop.address = body.address.trim();
        state.shop.contactPhone = phone;
        state.shop.version += 1;
        save();
        return state.shop;
      }),
      createService: wrap((body) => {
        requireRole('admin');
        const v = C.validateServiceInput(body);
        if (!v.ok) throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', v.fields);
        const s = Object.assign({ id: uuid(), description: '', active: true, version: 1 }, v.value);
        state.services.push(s);
        save();
        return s;
      }),
      updateService: wrap((id, body) => {
        requireRole('admin');
        const s = state.services.find((x) => x.id === id);
        if (!s) throw ApiError(404, 'NOT_FOUND', null);
        if (s.version !== body.version) throw ApiError(409, 'VERSION_CONFLICT', null);
        const merged = Object.assign({}, s, body);
        const v = C.validateServiceInput(merged);
        if (!v.ok) throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', v.fields);
        Object.assign(s, v.value, { active: typeof body.active === 'boolean' ? body.active : s.active, version: s.version + 1 });
        save();
        return s;
      }),
      updateStaff: wrap((id, body) => {
        requireRole('admin');
        const s = state.staff.find((x) => x.id === id);
        if (!s) throw ApiError(404, 'NOT_FOUND', null);
        if (s.version !== body.version) throw ApiError(409, 'VERSION_CONFLICT', null);
        if (body.name !== undefined) {
          const n = C.validateName(body.name);
          if (!n.ok) throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', { name: n.message });
          s.name = n.value;
        }
        if (body.bio !== undefined) {
          if (typeof body.bio !== 'string' || body.bio.length > 300) throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', { bio: 'Até 300 caracteres.' });
          s.bio = body.bio.trim();
        }
        if (typeof body.active === 'boolean') {
          const future = state.appointments.some((a) => a.staffId === id && a.status === 'confirmed' && new Date(a.startAt) > now());
          if (!body.active && future) throw ApiError(409, 'SCHEDULE_CONFLICT', null);
          s.active = body.active;
        }
        s.version += 1;
        save();
        return s;
      }),
      workingHours: wrap((staffId) => {
        requireRole('admin');
        return state.hours[staffId] || [];
      }),
      replaceWorkingHours: wrap((staffId, { periods }) => {
        requireRole('admin');
        if (!state.staff.some((s) => s.id === staffId)) throw ApiError(404, 'NOT_FOUND', null);
        if (!Array.isArray(periods) || periods.length > 28) throw ApiError(400, 'VALIDATION_ERROR', 'Lista de até 28 turnos.');
        for (const p of periods) {
          if (!Number.isInteger(p.weekday) || p.weekday < 0 || p.weekday > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.startLocal) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.endLocal) || p.endLocal <= p.startLocal) {
            throw ApiError(400, 'VALIDATION_ERROR', 'Período inválido.');
          }
        }
        const next = periods.map((p) => ({
          id: uuid(), staffId, weekday: p.weekday, startLocal: p.startLocal, endLocal: p.endLocal,
          validFrom: p.validFrom || '2000-01-01', validUntil: p.validUntil || null, version: 1,
        }));
        // Recusa mudança que deixe reserva confirmada futura fora do expediente.
        const orphan = state.appointments.some((a) => {
          if (a.staffId !== staffId || a.status !== 'confirmed' || new Date(a.startAt) <= now()) return false;
          const d = C.localDateOf(a.startAt, TZ);
          const wd = C.weekdayOf(d);
          return !next.some((p) => p.weekday === wd
            && C.zonedToInstant(d, p.startLocal, TZ) <= a.startAt && C.zonedToInstant(d, p.endLocal, TZ) >= a.endAt);
        });
        if (orphan) throw ApiError(409, 'SCHEDULE_CONFLICT', null);
        state.hours[staffId] = next;
        save();
        return next;
      }),
      blocks: wrap(({ staffId, from, to } = {}) => {
        requireRole('admin');
        return state.blocks.filter((b) => (!staffId || b.staffId === staffId)
          && (!from || C.localDateOf(b.endAt, TZ) >= from) && (!to || C.localDateOf(b.startAt, TZ) <= to))
          .sort((a, b) => a.startAt.localeCompare(b.startAt));
      }),
      createBlock: wrap(({ staffId, startAt, endAt, reason }) => {
        requireRole('admin');
        if (!state.staff.some((s) => s.id === staffId)) throw ApiError(404, 'NOT_FOUND', null);
        if (Number.isNaN(Date.parse(startAt)) || Number.isNaN(Date.parse(endAt)) || Date.parse(endAt) <= Date.parse(startAt)) {
          throw ApiError(400, 'VALIDATION_ERROR', 'Entrada inválida.', { endAt: 'O fim precisa ser depois do início.' });
        }
        if (busy(staffId).some(([s, e]) => C.overlaps(startAt, endAt, s, e))) throw ApiError(409, 'SLOT_CONFLICT', null);
        const b = { id: uuid(), staffId, startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(), reason: String(reason || '').slice(0, 200), version: 1 };
        state.blocks.push(b);
        save();
        return b;
      }),
      deleteBlock: wrap((id, version) => {
        requireRole('admin');
        const i = state.blocks.findIndex((b) => b.id === id);
        if (i < 0) throw ApiError(404, 'NOT_FOUND', null);
        if (state.blocks[i].version !== Number(version)) throw ApiError(409, 'VERSION_CONFLICT', null);
        state.blocks.splice(i, 1);
        save();
        return null;
      }),
      // Só a demonstração permite apagar tudo; o produto real nunca expõe isso.
      resetDemo() {
        state = seed();
        session = { role: 'anonymous', principalId: null };
        save();
      },
      _fail: fail,
    };
  }

  root.BPDemo = { createDemoAdapter, STORAGE_KEY: KEY };
})(typeof window !== 'undefined' ? window : globalThis);
