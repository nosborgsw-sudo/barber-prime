// Barber Prime — interface (página inicial, agendamento, reservas do cliente e painel da equipe).
// Script clássico: o mesmo arquivo roda com a API real (public/index.html) e no HTML autônomo de demonstração.
// Dados vindos da API entram na tela só por textContent/atributos, nunca como HTML.
(function (root) {
  'use strict';
  const C = root.BPCore;
  const doc = root.document;
  const $ = (id) => doc.getElementById(id);
  const isDemo = doc.body.dataset.mode === 'demo';
  const api = isDemo ? root.BPDemo.createDemoAdapter() : root.BPApi.createApiAdapter();
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VIEWS = ['inicio', 'agendar', 'reservas', 'equipe'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const MAX_WEEKS_AHEAD = 8;

  const state = {
    tz: 'America/Sao_Paulo',
    shop: null,
    staff: [],
    services: [],
    catalog: null, // Promise do carregamento do catálogo
    me: undefined, // undefined = ainda não consultado; null = sem sessão
    booking: { serviceId: null, staffId: null, idemKey: null },
    agendaDate: null,
    adminStaff: [],
    adminServices: [],
    challengeId: null,
    firstRoute: true,
  };

  // ---------------------------------------------------------------- utilitários de DOM

  function el(tag, props, ...children) {
    const node = doc.createElement(tag);
    const p = props || {};
    if (p.className) node.className = p.className;
    if (p.text !== undefined && p.text !== null) node.textContent = String(p.text);
    if (p.attrs) for (const [k, v] of Object.entries(p.attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
    if (p.on) for (const [k, fn] of Object.entries(p.on)) node.addEventListener(k, fn);
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof root.Node ? child : doc.createTextNode(String(child)));
    }
    return node;
  }

  function icon(name, className) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    const use = doc.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function button(label, className, onClick, attrs) {
    return el('button', { className: 'btn ' + (className || ''), text: label, attrs: Object.assign({ type: 'button' }, attrs), on: onClick ? { click: onClick } : null });
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('is-loading', busy);
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function showError(node, message) {
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  }

  function fieldError(inputId, message) {
    const input = $(inputId);
    const err = $(inputId + '-erro');
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    showError(err, message);
  }

  function clearForm(form) {
    form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    form.querySelectorAll('.field-error, .form-error').forEach((n) => showError(n, ''));
  }

  // Erros do servidor por campo → mensagem ao lado do input com o mesmo name no formulário.
  function applyFieldErrors(error, form) {
    let first = null;
    if (error && error.fields) {
      for (const [field, msg] of Object.entries(error.fields)) {
        const input = form.elements.namedItem(field);
        if (!input || !input.id) continue;
        fieldError(input.id, typeof msg === 'string' ? msg : 'Valor inválido.');
        first = first || input;
      }
    }
    if (first) first.focus();
    return Boolean(first);
  }

  function toast(message, isError) {
    const box = $('avisos');
    const t = el('div', { className: 'toast' + (isError ? ' is-error' : ''), text: message });
    box.append(t);
    root.setTimeout(() => t.remove(), 5000);
  }

  function emptyItem(text, tag) {
    return el(tag || 'li', { className: 'empty', text });
  }

  function errorBlock(message, retry) {
    return el('div', { className: 'error-box', attrs: { role: 'alert' } },
      el('p', { text: message }),
      retry ? button('Tentar novamente', 'btn-ghost btn-sm', retry) : null);
  }

  function skeletons(list, n) {
    list.replaceChildren(...Array.from({ length: n }, () => el('li', { className: 'skeleton', attrs: { 'aria-hidden': 'true' } })));
  }

  function newIdemKey() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    const bytes = new Uint8Array(24);
    root.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const staffName = (id) => (state.staff.find((s) => s.id === id) || state.adminStaff.find((s) => s.id === id) || {}).name || '';
  const serviceOf = (id) => state.services.find((s) => s.id === id) || state.adminServices.find((s) => s.id === id) || null;
  const whenText = (instant) => C.formatDateLong(instant, state.tz) + ' · ' + C.formatTime(instant, state.tz);

  // ---------------------------------------------------------------- sessão

  async function refreshMe() {
    try {
      state.me = await api.me();
    } catch {
      state.me = null;
    }
    renderSession();
    return state.me;
  }

  function renderSession() {
    const me = state.me;
    $('sessao').hidden = !me;
    $('sessao-nome').textContent = me ? me.name : '';
  }

  async function logout() {
    const btn = $('sair');
    setBusy(btn, true);
    try {
      await api.logout();
    } catch (e) {
      if (e.status !== 401) toast(C.errorMessage(e), true);
    } finally {
      setBusy(btn, false);
    }
    state.me = null;
    renderSession();
    toast('Você saiu.');
    route();
  }

  // ---------------------------------------------------------------- catálogo e página inicial

  function loadCatalog(force) {
    if (state.catalog && !force) return state.catalog;
    skeletons($('lista-barbeiros'), 4);
    skeletons($('lista-servicos'), 3);
    $('inicio-status').replaceChildren();
    state.catalog = Promise.all([api.shop(), api.staff(), api.services()])
      .then(([shop, staff, services]) => {
        state.shop = shop;
        state.tz = (shop && shop.timezone) || state.tz;
        state.staff = staff || [];
        state.services = services || [];
        renderHome();
        return true;
      })
      .catch((e) => {
        state.catalog = null;
        $('lista-barbeiros').replaceChildren();
        $('lista-servicos').replaceChildren();
        $('inicio-status').replaceChildren(errorBlock('Não foi possível carregar a barbearia. ' + C.errorMessage(e), () => loadCatalog(true)));
        $('lista-barbeiros').setAttribute('aria-busy', 'false');
        $('lista-servicos').setAttribute('aria-busy', 'false');
        return false;
      });
    return state.catalog;
  }

  function renderHome() {
    const shop = state.shop || {};
    const name = shop.name || 'Barber Prime';
    for (const id of ['marca-nome', 'hero-nome', 'rodape-nome']) $(id).textContent = name;
    doc.title = (isDemo ? 'DEMONSTRAÇÃO — ' : '') + name + ' — Agendamento';

    const barbers = $('lista-barbeiros');
    barbers.setAttribute('aria-busy', 'false');
    barbers.replaceChildren(...(state.staff.length
      ? state.staff.map((b) => el('li', { className: 'card barber' },
        el('div', { className: 'avatar', text: C.initials(b.name), attrs: { 'aria-hidden': 'true' } }),
        el('h3', { text: b.name }),
        el('p', { text: b.bio || 'Barbeiro' })))
      : [emptyItem('Nenhum barbeiro disponível no momento.')]));

    const services = $('lista-servicos');
    services.setAttribute('aria-busy', 'false');
    services.replaceChildren(...(state.services.length
      ? state.services.map((s) => el('li', { className: 'card service' },
        icon('scissors', 'service-icon'),
        el('div', { className: 'service-body' }, el('h3', { text: s.name }), s.description ? el('p', { text: s.description }) : null),
        el('div', { className: 'service-meta' },
          el('span', { className: 'price', text: C.formatMoney(s.priceCents) }),
          el('span', { className: 'duration', text: C.formatDuration(s.durationMinutes) }))))
      : [emptyItem('Nenhum serviço disponível no momento.')]));

    const hours = $('horario-funcionamento');
    const opening = Array.isArray(shop.openingHours) ? shop.openingHours : null;
    if (opening) {
      hours.replaceChildren(...WEEK_ORDER.flatMap((wd) => {
        const h = opening.find((o) => o.weekday === wd);
        return [el('dt', { text: C.WEEKDAYS[wd] }), el('dd', { text: h ? h.startLocal + ' – ' + h.endLocal : 'Fechado' })];
      }));
    } else {
      hours.replaceChildren(el('dt', { text: 'Horários' }), el('dd', { text: 'Consulte os horários livres ao agendar' }));
    }

    const addr = $('contato-endereco');
    addr.replaceChildren(icon('pin'), el('span', { text: shop.address || 'Endereço a configurar no painel.' }));
    const phone = $('contato-telefone');
    phone.replaceChildren(icon('phone'), shop.contactPhone
      ? el('a', { text: C.formatPhoneBR(shop.contactPhone), attrs: { href: 'tel:' + shop.contactPhone } })
      : el('span', { text: 'Telefone a configurar no painel.' }));
    $('rodape-endereco').textContent = shop.address || '';
  }

  // ---------------------------------------------------------------- seletor de dia e horário

  // Usado no agendamento e no reagendamento. Consulta GET /availability para o dia escolhido.
  function createSlotPicker(container, opts) {
    const name = opts.name;
    let today = C.todayIn(state.tz);
    let weekStart = today;
    let date = null;
    let value = null;
    let request = 0;
    let autoSkips = 0; // dias que a seleção automática ainda pode pular quando o dia não tem horário livre

    const prev = el('button', { className: 'btn btn-icon', attrs: { type: 'button', 'aria-label': 'Semana anterior' }, on: { click: () => shift(-7) } }, icon('left'));
    const next = el('button', { className: 'btn btn-icon', attrs: { type: 'button', 'aria-label': 'Próxima semana' }, on: { click: () => shift(7) } }, icon('right'));
    const month = el('span', { className: 'calendar-month', attrs: { 'aria-live': 'polite' } });
    const days = el('div', { className: 'days', attrs: { role: 'radiogroup', 'aria-label': 'Dia' } });
    const title = el('h3', { className: 'slots-title' });
    const status = el('p', { className: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const slots = el('div', { className: 'slots', attrs: { role: 'radiogroup', 'aria-label': 'Horário' } });
    container.replaceChildren(el('div', { className: 'calendar-nav' }, prev, month, next), days, title, status, slots);

    function isClosed(iso) {
      const opening = state.shop && Array.isArray(state.shop.openingHours) ? state.shop.openingHours : null;
      return opening ? !opening.some((o) => o.weekday === C.weekdayOf(iso)) : false;
    }

    function shift(delta) {
      const target = C.addDays(weekStart, delta);
      if (target < today || target > C.addDays(today, MAX_WEEKS_AHEAD * 7)) return;
      weekStart = target;
      renderDays();
    }

    function renderDays() {
      today = C.todayIn(state.tz);
      if (weekStart < today) weekStart = today;
      prev.disabled = weekStart <= today;
      next.disabled = C.addDays(weekStart, 7) > C.addDays(today, MAX_WEEKS_AHEAD * 7);
      month.textContent = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(weekStart + 'T12:00:00Z'));
      const list = [];
      for (let i = 0; i < 7; i++) {
        const iso = C.addDays(weekStart, i);
        const chip = C.dayChip(iso);
        const closed = isClosed(iso);
        const id = name + '-dia-' + i;
        const input = el('input', { attrs: { type: 'radio', name: name + '-dia', id, value: iso, disabled: closed, 'aria-label': C.formatDateLong(iso) + (closed ? ', fechado' : '') } });
        input.checked = iso === date;
        input.addEventListener('change', () => selectDate(iso));
        list.push(el('label', { className: 'choice day' + (closed ? ' day-closed' : ''), attrs: { for: id } }, input,
          el('span', { className: 'choice-box' },
            el('span', { className: 'day-wd', text: iso === today ? 'hoje' : chip.weekday }),
            el('span', { className: 'day-n', text: chip.day }))));
      }
      days.replaceChildren(...list);
    }

    function setValue(v) {
      value = v;
      if (opts.onChange) opts.onChange(v);
    }

    function selectDate(iso) {
      autoSkips = 0;
      date = iso;
      setValue(null);
      load();
    }

    async function load() {
      const serviceId = opts.getServiceId();
      const staffId = opts.getStaffId();
      slots.replaceChildren();
      if (!serviceId || !staffId) {
        title.textContent = '';
        status.textContent = 'Escolha o serviço e o barbeiro para ver os horários livres.';
        return;
      }
      if (!date) {
        title.textContent = '';
        status.textContent = 'Escolha um dia.';
        return;
      }
      const mine = ++request;
      title.textContent = C.formatDateLong(date);
      status.textContent = 'Carregando horários…';
      slots.setAttribute('aria-busy', 'true');
      try {
        const res = await api.availability({ staffId, serviceId, date });
        if (mine !== request) return;
        const free = (res && res.slots) || [];
        if (!free.length && autoSkips > 0) {
          autoSkips -= 1;
          const next = nextOpenDay(date);
          if (next) {
            date = next;
            if (date >= C.addDays(weekStart, 7)) weekStart = date;
            renderDays();
            return load();
          }
        }
        autoSkips = 0;
        status.textContent = free.length ? free.length + ' horário(s) livre(s).' : 'Nenhum horário livre neste dia. Tente outro dia ou outro barbeiro.';
        slots.replaceChildren(...free.map((s, i) => {
          const id = name + '-horario-' + i;
          const label = C.formatTime(s.startAt, state.tz);
          const input = el('input', { attrs: { type: 'radio', name: name + '-horario', id, value: s.startAt, 'aria-label': label } });
          input.checked = s.startAt === value;
          input.addEventListener('change', () => setValue(s.startAt));
          return el('label', { className: 'choice slot', attrs: { for: id } }, input, el('span', { className: 'choice-box', text: label }));
        }));
      } catch (e) {
        if (mine !== request) return;
        status.textContent = '';
        slots.replaceChildren(errorBlock('Não foi possível carregar os horários. ' + C.errorMessage(e), load));
      } finally {
        if (mine === request) slots.setAttribute('aria-busy', 'false');
      }
    }

    function nextOpenDay(from) {
      const limit = C.addDays(today, MAX_WEEKS_AHEAD * 7 + 6);
      for (let iso = C.addDays(from, 1); iso <= limit; iso = C.addDays(iso, 1)) if (!isClosed(iso)) return iso;
      return null;
    }

    // Sem dia escolhido, abre no primeiro dia com horário livre (até duas semanas à frente), para agendar com menos toques.
    function autoDate() {
      if (date) return load();
      const first = isClosed(weekStart) ? nextOpenDay(weekStart) : weekStart;
      if (!first) return load();
      date = first;
      autoSkips = 13;
      renderDays();
      return load();
    }

    renderDays();
    load();
    return {
      refresh() { setValue(null); return autoDate(); },
      reset() { date = null; weekStart = C.todayIn(state.tz); setValue(null); renderDays(); load(); },
      get date() { return date; },
      get value() { return value; },
    };
  }

  function choice(name, id, value, checked, content, onChange, extraClass) {
    const input = el('input', { attrs: { type: 'radio', name, id, value } });
    input.checked = checked;
    input.addEventListener('change', onChange);
    return el('label', { className: 'choice' + (extraClass ? ' ' + extraClass : ''), attrs: { for: id } }, input, el('span', { className: 'choice-box' }, content));
  }

  // ---------------------------------------------------------------- agendamento

  let bookingPicker = null;

  async function enterBooking() {
    $('agendar-sucesso').hidden = true;
    $('form-agendar').hidden = false;
    $('agendar-servicos').setAttribute('aria-busy', 'true');
    const loaded = await loadCatalog();
    if (state.me === undefined) await refreshMe();
    renderIdentity();
    if (!loaded) {
      $('agendar-servicos').replaceChildren(errorBlock('Catálogo indisponível.', () => loadCatalog(true).then(enterBooking)));
      return;
    }
    renderBookingChoices();
    if (!bookingPicker) {
      bookingPicker = createSlotPicker($('agendar-calendario'), {
        name: 'agendar',
        getServiceId: () => state.booking.serviceId,
        getStaffId: () => state.booking.staffId,
        onChange: () => { state.booking.idemKey = null; showError($('erro-horario'), ''); updateSummary(); },
      });
    }
    updateSummary();
  }

  function renderIdentity() {
    const me = state.me;
    const isCustomer = me && me.role === 'customer';
    $('dados-identificado').hidden = !isCustomer;
    $('dados-cadastro').hidden = Boolean(isCustomer);
    $('dados-nome').textContent = isCustomer ? me.name : '';
  }

  function renderBookingChoices() {
    const b = state.booking;
    if (b.serviceId && !state.services.some((s) => s.id === b.serviceId)) b.serviceId = null;
    if (b.staffId && !state.staff.some((s) => s.id === b.staffId)) b.staffId = null;
    const services = $('agendar-servicos');
    services.setAttribute('aria-busy', 'false');
    services.replaceChildren(...(state.services.length ? state.services.map((s, i) => choice('servico', 'servico-' + i, s.id, s.id === b.serviceId, [
      icon('scissors', 'service-icon'),
      el('span', { className: 'service-body' }, el('span', { className: 'choice-title', text: s.name }), el('span', { className: 'choice-sub', text: ' · ' + C.formatDuration(s.durationMinutes) })),
      el('span', { className: 'choice-end price', text: C.formatMoney(s.priceCents) }),
    ], () => pick('serviceId', s.id))) : [emptyItem('Nenhum serviço disponível.', 'p')]));

    const barbers = $('agendar-barbeiros');
    barbers.setAttribute('aria-busy', 'false');
    barbers.replaceChildren(...(state.staff.length ? state.staff.map((s, i) => choice('barbeiro', 'barbeiro-' + i, s.id, s.id === b.staffId, [
      el('span', { className: 'avatar', text: C.initials(s.name), attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'choice-title', text: s.name }),
      s.bio ? el('span', { className: 'choice-sub', text: s.bio }) : null,
    ], () => pick('staffId', s.id))) : [emptyItem('Nenhum barbeiro disponível.', 'p')]));
  }

  function pick(key, id) {
    state.booking[key] = id;
    state.booking.idemKey = null;
    showError($(key === 'serviceId' ? 'erro-servico' : 'erro-barbeiro'), '');
    updateSummary();
    if (bookingPicker) bookingPicker.refresh();
  }

  function updateSummary() {
    const b = state.booking;
    const service = serviceOf(b.serviceId);
    const startAt = bookingPicker ? bookingPicker.value : null;
    const rows = [
      ['Serviço', service ? service.name : '—'],
      ['Barbeiro', staffName(b.staffId) || '—'],
      ['Dia', bookingPicker && bookingPicker.date ? C.formatDateLong(bookingPicker.date) : '—'],
      ['Horário', startAt ? C.formatTime(startAt, state.tz) : '—'],
      ['Duração', service ? C.formatDuration(service.durationMinutes) : '—'],
      ['Valor', service ? C.formatMoney(service.priceCents) : '—'],
    ];
    $('resumo').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
    const step = !service ? 1 : !b.staffId ? 2 : !startAt ? 3 : 4;
    doc.querySelectorAll('.stepper li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('done', n < step);
      li.classList.toggle('current', n === step);
      if (n === step) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
  }

  async function submitBooking(event) {
    event.preventDefault();
    const form = $('form-agendar');
    clearForm(form);
    const b = state.booking;
    const startAt = bookingPicker ? bookingPicker.value : null;
    let firstInvalid = null;
    if (!b.serviceId) { showError($('erro-servico'), 'Escolha um serviço.'); firstInvalid = firstInvalid || form.querySelector('[name="servico"]'); }
    if (!b.staffId) { showError($('erro-barbeiro'), 'Escolha um barbeiro.'); firstInvalid = firstInvalid || form.querySelector('[name="barbeiro"]'); }
    if (!startAt) { showError($('erro-horario'), 'Escolha um dia e um horário livre.'); firstInvalid = firstInvalid || $('agendar-calendario').querySelector('input:not([disabled])'); }

    const me = state.me;
    if (me && me.role !== 'customer') {
      showError($('agendar-erro'), 'Você está conectado como equipe. Saia para agendar como cliente.');
      return;
    }
    let name = null;
    let phone = null;
    if (!me) {
      const n = C.validateName($('cad-nome').value);
      const p = C.validatePhone($('cad-telefone').value);
      if (!n.ok) { fieldError('cad-nome', n.message); firstInvalid = firstInvalid || $('cad-nome'); }
      if (!p.ok) { fieldError('cad-telefone', p.message); firstInvalid = firstInvalid || $('cad-telefone'); }
      name = n.value;
      phone = p.value;
    }
    const notes = $('agendar-obs').value.trim();
    if (notes.length > 500) { showError($('agendar-erro'), 'A observação pode ter no máximo 500 caracteres.'); firstInvalid = firstInvalid || $('agendar-obs'); }
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const btn = $('agendar-confirmar');
    setBusy(btn, true);
    try {
      if (!me) {
        await api.register({ name, phone });
        await refreshMe();
        if (!state.me || state.me.role !== 'customer') {
          showError($('agendar-erro'), 'Não foi possível concluir o cadastro neste aparelho. Se esse telefone já tem cadastro, recupere o acesso em "Minhas reservas".');
          return;
        }
        renderIdentity();
      }
      if (!b.idemKey) b.idemKey = newIdemKey();
      const body = { staffId: b.staffId, serviceId: b.serviceId, startAt };
      if (notes) body.notes = notes;
      const appt = await api.createAppointment(body, b.idemKey);
      b.idemKey = null;
      $('agendar-obs').value = '';
      $('sucesso-detalhe').textContent = (appt.serviceName || (serviceOf(appt.serviceId) || {}).name || 'Atendimento') + ' com '
        + (appt.staffName || staffName(appt.staffId)) + ', ' + whenText(appt.startAt) + '.';
      $('form-agendar').hidden = true;
      const ok = $('agendar-sucesso');
      ok.hidden = false;
      ok.focus();
      bookingPicker.reset();
      updateSummary();
    } catch (e) {
      if (e.code === 'SLOT_CONFLICT' || e.status === 409) {
        b.idemKey = null;
        showError($('erro-horario'), C.errorMessage(e));
        bookingPicker.refresh();
      } else if (e.status === 401) {
        state.me = null;
        renderSession();
        renderIdentity();
        showError($('agendar-erro'), 'Sua sessão expirou. Informe seus dados de novo.');
      } else if (!applyFieldErrors(e, form)) {
        showError($('agendar-erro'), C.errorMessage(e));
      }
    } finally {
      setBusy(btn, false);
    }
  }

  // ---------------------------------------------------------------- minhas reservas

  async function loadReservations() {
    await loadCatalog();
    const me = await refreshMe();
    const isCustomer = me && me.role === 'customer';
    $('reservas-anonimo').hidden = Boolean(isCustomer);
    $('reservas-cliente').hidden = !isCustomer;
    if (!isCustomer) return;
    const list = $('lista-reservas');
    const status = $('reservas-status');
    status.textContent = 'Carregando reservas…';
    list.setAttribute('aria-busy', 'true');
    skeletons(list, 2);
    try {
      const res = await api.listAppointments({ limit: 100 });
      const now = Date.now();
      const upcoming = $('reservas-periodo').value !== 'anteriores';
      const items = (res.data || [])
        .filter((a) => upcoming ? Date.parse(a.endAt) >= now : Date.parse(a.endAt) < now)
        .sort((a, b) => upcoming ? a.startAt.localeCompare(b.startAt) : b.startAt.localeCompare(a.startAt));
      status.textContent = items.length ? items.length + ' reserva(s).' : '';
      list.replaceChildren(...(items.length ? items.map(renderAppointment) : [emptyItem(upcoming ? 'Você não tem reservas futuras.' : 'Nenhuma reserva anterior.')]));
    } catch (e) {
      status.textContent = '';
      list.replaceChildren(el('li', null, errorBlock(C.errorMessage(e), loadReservations)));
    } finally {
      list.setAttribute('aria-busy', 'false');
    }
  }

  function renderAppointment(a) {
    const service = serviceOf(a.serviceId);
    const li = el('li', { className: 'card appt' });
    const actions = el('div', { className: 'appt-actions' });
    const area = el('div');
    const err = el('p', { className: 'form-error', attrs: { role: 'alert' } });
    err.hidden = true;
    li.append(
      el('div', { className: 'appt-head' },
        el('span', { className: 'appt-when', text: whenText(a.startAt) }),
        el('span', { className: 'badge badge-' + a.status, text: C.STATUS_LABEL[a.status] || a.status })),
      el('p', { className: 'appt-meta', text: [a.serviceName || (service && service.name), a.staffName || staffName(a.staffId), C.formatDuration(a.durationMinutes), C.formatMoney(a.priceCents)].filter(Boolean).join(' · ') }),
      actions, err, area);
    const future = Date.parse(a.startAt) > Date.now();
    if (a.status === 'confirmed' && future) {
      const reschedule = button('Reagendar', 'btn-ghost btn-sm', () => openReschedule(a, area, reschedule), { 'aria-expanded': 'false' });
      const cancel = button('Cancelar', 'btn-danger btn-sm', () => {
        actions.replaceChildren(
          el('span', { className: 'muted small', text: 'Cancelar esta reserva?' }),
          button('Sim, cancelar', 'btn-danger btn-sm', async (ev) => {
            // currentTarget vira null depois do await: guarda o botão antes.
            const btn = ev.currentTarget;
            setBusy(btn, true);
            try {
              await api.cancel(a.id, { version: a.version });
              toast('Reserva cancelada. O horário foi liberado.');
              loadReservations();
            } catch (e) {
              setBusy(btn, false);
              showError(err, C.errorMessage(e));
            }
          }),
          button('Manter reserva', 'btn-ghost btn-sm', () => actions.replaceChildren(reschedule, cancel)));
        actions.querySelector('.btn-danger').focus();
      });
      actions.append(reschedule, cancel);
    }
    return li;
  }

  function openReschedule(a, area, toggle) {
    if (area.childElementCount) {
      area.replaceChildren();
      toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    toggle.setAttribute('aria-expanded', 'true');
    let staffId = a.staffId;
    const uid = 'rem-' + a.id.slice(0, 8);
    const select = el('select', { attrs: { id: uid + '-barbeiro' } },
      ...state.staff.map((s) => {
        const o = el('option', { text: s.name, attrs: { value: s.id } });
        o.selected = s.id === staffId;
        return o;
      }));
    const pickerBox = el('div', { className: 'calendar' });
    const err = el('p', { className: 'form-error', attrs: { role: 'alert' } });
    err.hidden = true;
    const confirm = button('Confirmar novo horário', 'btn-gold', null);
    confirm.disabled = true;
    area.replaceChildren(el('div', { className: 'reschedule' },
      el('h3', { className: 'card-title', text: 'Escolha o novo horário' }),
      el('p', { className: 'muted small', text: 'Sua reserva atual continua valendo até a troca ser confirmada.' }),
      el('div', { className: 'field' }, el('label', { text: 'Barbeiro', attrs: { for: uid + '-barbeiro' } }), select),
      pickerBox, err, confirm));
    const picker = createSlotPicker(pickerBox, {
      name: uid,
      getServiceId: () => a.serviceId,
      getStaffId: () => staffId,
      onChange: (v) => { confirm.disabled = !v; showError(err, ''); },
    });
    select.addEventListener('change', () => { staffId = select.value; picker.refresh(); });
    picker.refresh();
    confirm.addEventListener('click', async () => {
      if (!picker.value) return;
      setBusy(confirm, true);
      try {
        await api.reschedule(a.id, { staffId, startAt: picker.value, version: a.version });
        toast('Reserva reagendada para ' + whenText(picker.value) + '.');
        loadReservations();
      } catch (e) {
        setBusy(confirm, false);
        showError(err, C.errorMessage(e));
        if (e.code === 'SLOT_CONFLICT') picker.refresh();
        if (e.code === 'VERSION_CONFLICT') loadReservations();
      }
    });
    select.focus();
  }

  async function requestRecovery(event) {
    event.preventDefault();
    const form = $('form-recuperar');
    clearForm(form);
    const p = C.validatePhone($('rec-telefone').value);
    if (!p.ok) {
      fieldError('rec-telefone', p.message);
      $('rec-telefone').focus();
      return;
    }
    const btn = $('rec-enviar');
    setBusy(btn, true);
    try {
      const res = await api.requestChallenge({ phone: p.value });
      state.challengeId = res.challengeId;
      let msg = res.message || 'Se o telefone tiver cadastro, enviaremos um código.';
      if (isDemo && res.demoCode) msg += ' (DEMONSTRAÇÃO — sem envio de SMS: o código é ' + res.demoCode + '.)';
      $('rec-mensagem').textContent = msg;
      $('rec-codigo-bloco').hidden = false;
      $('rec-codigo').focus();
    } catch (e) {
      if (!applyFieldErrors(e, form)) showError($('rec-erro'), C.errorMessage(e));
    } finally {
      setBusy(btn, false);
    }
  }

  async function verifyRecovery() {
    fieldError('rec-codigo', '');
    showError($('rec-erro'), '');
    const v = C.validateCode($('rec-codigo').value);
    if (!v.ok) {
      fieldError('rec-codigo', v.message);
      $('rec-codigo').focus();
      return;
    }
    const btn = $('rec-verificar');
    setBusy(btn, true);
    try {
      await api.verifyChallenge({ challengeId: state.challengeId, code: v.value });
      $('form-recuperar').reset();
      $('rec-codigo-bloco').hidden = true;
      toast('Acesso confirmado neste aparelho.');
      await loadReservations();
    } catch (e) {
      showError($('rec-erro'), C.errorMessage(e));
    } finally {
      setBusy(btn, false);
    }
  }

  // ---------------------------------------------------------------- equipe

  async function enterTeam() {
    await loadCatalog();
    const me = await refreshMe();
    const staff = me && (me.role === 'admin' || me.role === 'barber');
    $('form-equipe-login').hidden = Boolean(staff);
    $('painel').hidden = !staff;
    $('equipe-login-ajuda').textContent = isDemo
      ? 'DEMONSTRAÇÃO: o primeiro acesso define o login e a senha (12+ caracteres) do administrador, guardados só neste navegador.'
      : 'Acesso para barbeiros e administração.';
    if (!staff) return;
    const isAdmin = me.role === 'admin';
    doc.querySelectorAll('.ptab[data-admin]').forEach((t) => { t.hidden = !isAdmin; });
    if (isAdmin) {
      try {
        state.adminStaff = await api.adminStaff();
      } catch (e) {
        toast(C.errorMessage(e), true);
      }
    }
    selectPanel('agenda');
  }

  async function submitLogin(event) {
    event.preventDefault();
    const form = $('form-equipe-login');
    clearForm(form);
    const v = C.validateStaffLogin($('equipe-login').value, $('equipe-senha').value);
    if (!v.ok) {
      if (v.fields.login) fieldError('equipe-login', v.fields.login);
      if (v.fields.password) fieldError('equipe-senha', v.fields.password);
      $(v.fields.login ? 'equipe-login' : 'equipe-senha').focus();
      return;
    }
    const btn = $('equipe-entrar');
    setBusy(btn, true);
    try {
      await api.login(v.value);
      form.reset();
      await enterTeam();
      toast('Bem-vindo ao painel.');
    } catch (e) {
      if (!applyFieldErrors(e, form)) showError($('equipe-erro'), C.errorMessage(e));
    } finally {
      setBusy(btn, false);
    }
  }

  const PANELS = ['agenda', 'servicos', 'barbeiros', 'expediente', 'bloqueios', 'barbearia'];

  function selectPanel(name) {
    for (const p of PANELS) {
      const tab = $('ptab-' + p);
      const on = p === name;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $('painel-' + p).hidden = !on;
    }
    const loaders = { agenda: loadAgenda, servicos: loadAdminServices, barbeiros: loadAdminStaff, expediente: loadWorkingHours, bloqueios: loadBlocks, barbearia: loadShopForm };
    loaders[name]();
  }

  function onPanelKey(event) {
    const visible = PANELS.filter((p) => !$('ptab-' + p).hidden);
    const current = visible.indexOf(event.target.id.replace('ptab-', ''));
    let next = null;
    if (event.key === 'ArrowRight') next = (current + 1) % visible.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + visible.length) % visible.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectPanel(visible[next]);
    $('ptab-' + visible[next]).focus();
  }

  function teamBarbers() {
    const me = state.me;
    if (me && me.role === 'barber') return state.staff.filter((s) => s.id === me.id).concat(state.staff.some((s) => s.id === me.id) ? [] : [{ id: me.id, name: me.name }]);
    return (state.adminStaff.length ? state.adminStaff : state.staff).filter((s) => s.active !== false);
  }

  async function loadAgenda() {
    if (!state.agendaDate) state.agendaDate = C.todayIn(state.tz);
    const date = state.agendaDate;
    $('agenda-data').value = date;
    $('agenda-titulo').textContent = C.formatDateLong(date);
    const status = $('agenda-status');
    const cols = $('agenda-colunas');
    status.textContent = 'Carregando agenda…';
    cols.setAttribute('aria-busy', 'true');
    const isAdmin = state.me && state.me.role === 'admin';
    try {
      const [appts, blocks] = await Promise.all([
        api.listAppointments({ from: date, to: date }).then((r) => r.data || []),
        isAdmin ? api.blocks({ from: date, to: date }) : Promise.resolve([]),
      ]);
      const barbers = teamBarbers();
      status.textContent = appts.filter((a) => a.status === 'confirmed').length + ' atendimento(s) confirmado(s).';
      cols.replaceChildren(...barbers.map((b) => {
        const items = appts.filter((a) => a.staffId === b.id).map((a) => ({ at: a.startAt, node: agendaAppointment(a, isAdmin) }))
          .concat((blocks || []).filter((x) => x.staffId === b.id).map((x) => ({ at: x.startAt, node: agendaBlock(x) })))
          .sort((x, y) => x.at.localeCompare(y.at));
        return el('section', { className: 'agenda-col', attrs: { 'aria-label': 'Agenda de ' + b.name } },
          el('h3', null, el('span', { className: 'avatar', text: C.initials(b.name), attrs: { 'aria-hidden': 'true' } }), b.name),
          items.length ? items.map((i) => i.node) : el('p', { className: 'muted small', text: 'Sem reservas neste dia.' }));
      }));
      if (!barbers.length) cols.replaceChildren(el('p', { className: 'empty', text: 'Nenhum barbeiro ativo.' }));
    } catch (e) {
      status.textContent = '';
      cols.replaceChildren(errorBlock(C.errorMessage(e), loadAgenda));
    } finally {
      cols.setAttribute('aria-busy', 'false');
    }
  }

  function agendaAppointment(a, isAdmin) {
    const actions = el('div', { className: 'appt-actions' });
    const item = el('article', { className: 'agenda-item' + (a.status === 'cancelled' ? ' is-cancelled' : '') },
      el('div', { className: 'appt-head' },
        el('span', { className: 'agenda-time', text: C.formatTime(a.startAt, state.tz) + '–' + C.formatTime(a.endAt, state.tz) }),
        el('span', { className: 'badge badge-' + a.status, text: C.STATUS_LABEL[a.status] || a.status })),
      el('p', { text: [a.customerName, a.serviceName || (serviceOf(a.serviceId) || {}).name].filter(Boolean).join(' · ') }),
      a.notes ? el('p', { className: 'small', text: 'Obs.: ' + a.notes }) : null,
      actions);
    const act = async (ev, fn, msg) => {
      setBusy(ev.currentTarget, true);
      try {
        await fn();
        toast(msg);
      } catch (e) {
        toast(C.errorMessage(e), true);
      }
      loadAgenda();
    };
    if (a.status === 'confirmed') {
      if (Date.parse(a.startAt) <= Date.now()) {
        actions.append(
          button('Concluído', 'btn-ghost btn-sm', (ev) => act(ev, () => api.setStatus(a.id, { status: 'completed', version: a.version }), 'Atendimento concluído.')),
          button('Não compareceu', 'btn-ghost btn-sm', (ev) => act(ev, () => api.setStatus(a.id, { status: 'no_show', version: a.version }), 'Falta registrada.')));
      }
      if (isAdmin) {
        actions.append(button('Cancelar', 'btn-danger btn-sm', (ev) => {
          const b = ev.currentTarget;
          if (b.dataset.confirm !== '1') {
            b.dataset.confirm = '1';
            b.textContent = 'Confirmar cancelamento';
            return;
          }
          act(ev, () => api.cancel(a.id, { version: a.version }), 'Reserva cancelada.');
        }));
      }
    }
    return item;
  }

  function agendaBlock(x) {
    return el('article', { className: 'agenda-item is-block' },
      el('span', { className: 'agenda-time', text: C.formatTime(x.startAt, state.tz) + '–' + C.formatTime(x.endAt, state.tz) }),
      el('p', { text: 'Bloqueado' + (x.reason ? ' · ' + x.reason : '') }));
  }

  function moveAgenda(days) {
    state.agendaDate = C.addDays(state.agendaDate || C.todayIn(state.tz), days);
    loadAgenda();
  }

  // ---- serviços (admin)

  async function loadAdminServices() {
    const list = $('admin-servicos');
    skeletons(list, 2);
    try {
      state.adminServices = await api.adminServices();
      list.replaceChildren(...(state.adminServices.length ? state.adminServices.map((s) => el('li', { className: 'card admin-item' },
        el('div', { className: 'grow' },
          el('strong', { text: s.name }),
          el('p', { className: 'muted small', text: C.formatDuration(s.durationMinutes) + ' · ' + C.formatMoney(s.priceCents) + (s.active ? '' : ' · inativo') })),
        button('Editar', 'btn-ghost btn-sm', () => editService(s), { 'aria-label': 'Editar ' + s.name }),
        button(s.active ? 'Desativar' : 'Ativar', 'btn-ghost btn-sm', async (ev) => {
          setBusy(ev.currentTarget, true);
          try {
            await api.updateService(s.id, { active: !s.active, version: s.version });
            toast(s.active ? 'Serviço desativado.' : 'Serviço ativado.');
            await loadCatalog(true);
          } catch (e) {
            toast(C.errorMessage(e), true);
          }
          loadAdminServices();
        }, { 'aria-label': (s.active ? 'Desativar ' : 'Ativar ') + s.name }))) : [emptyItem('Nenhum serviço cadastrado.')]));
    } catch (e) {
      list.replaceChildren(el('li', null, errorBlock(C.errorMessage(e), loadAdminServices)));
    }
  }

  function editService(s) {
    clearForm($('form-servico'));
    $('servico-id').value = s ? s.id : '';
    $('servico-nome').value = s ? s.name : '';
    $('servico-duracao').value = s ? String(s.durationMinutes) : '';
    $('servico-preco').value = s ? (s.priceCents / 100).toFixed(2).replace('.', ',') : '';
    $('servico-form-titulo').textContent = s ? 'Editar serviço' : 'Novo serviço';
    $('servico-cancelar').hidden = !s;
    if (s) $('servico-nome').focus();
  }

  async function submitService(event) {
    event.preventDefault();
    const form = $('form-servico');
    clearForm(form);
    const priceCents = C.parseMoneyToCents($('servico-preco').value);
    const durationText = $('servico-duracao').value.trim();
    const input = {
      name: $('servico-nome').value,
      durationMinutes: /^\d+$/.test(durationText) ? Number(durationText) : NaN,
      priceCents: priceCents === null ? NaN : priceCents,
    };
    const v = C.validateServiceInput(input);
    const map = { name: 'servico-nome', durationMinutes: 'servico-duracao', priceCents: 'servico-preco' };
    if (!v.ok) {
      for (const [k, msg] of Object.entries(v.fields)) fieldError(map[k], msg);
      $(map[Object.keys(v.fields)[0]]).focus();
      return;
    }
    const id = $('servico-id').value;
    const btn = $('servico-salvar');
    setBusy(btn, true);
    try {
      if (id) {
        const current = state.adminServices.find((s) => s.id === id);
        await api.updateService(id, Object.assign({ version: current ? current.version : 1 }, v.value));
        toast('Serviço atualizado.');
      } else {
        await api.createService(v.value);
        toast('Serviço criado.');
      }
      editService(null);
      await loadCatalog(true);
      loadAdminServices();
    } catch (e) {
      if (!applyFieldErrors(e, form)) showError($('servico-erro'), C.errorMessage(e));
    } finally {
      setBusy(btn, false);
    }
  }

  // ---- barbeiros (admin)

  async function loadAdminStaff() {
    const list = $('admin-barbeiros');
    skeletons(list, 4);
    try {
      state.adminStaff = await api.adminStaff();
      list.replaceChildren(...(state.adminStaff.length ? state.adminStaff.map(staffEditor) : [emptyItem('Nenhum barbeiro cadastrado.')]));
    } catch (e) {
      list.replaceChildren(el('li', null, errorBlock(C.errorMessage(e), loadAdminStaff)));
    }
  }

  function staffEditor(s) {
    const uid = 'bb-' + s.id.slice(0, 8);
    const name = el('input', { attrs: { id: uid + '-nome', type: 'text', maxlength: 100, value: s.name, 'aria-describedby': uid + '-nome-erro' } });
    const bio = el('input', { attrs: { id: uid + '-bio', type: 'text', maxlength: 300, value: s.bio || '' } });
    const active = el('input', { attrs: { id: uid + '-ativo', type: 'checkbox' } });
    active.checked = s.active !== false;
    const err = el('p', { className: 'form-error', attrs: { role: 'alert' } });
    err.hidden = true;
    const save = button('Salvar', 'btn-gold btn-sm', null);
    const form = el('form', { className: 'card', attrs: { novalidate: true, 'aria-label': 'Editar ' + s.name } },
      el('div', { className: 'form-row' },
        el('div', { className: 'field' }, el('label', { text: 'Nome', attrs: { for: uid + '-nome' } }), name,
          el('p', { className: 'field-error', attrs: { id: uid + '-nome-erro', hidden: true } })),
        el('div', { className: 'field' }, el('label', { text: 'Especialidade', attrs: { for: uid + '-bio' } }), bio)),
      el('div', { className: 'admin-item' },
        el('label', { className: 'inline-field', attrs: { for: uid + '-ativo' } }, active, 'Atende clientes'),
        save),
      err);
    save.type = 'submit';
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      clearForm(form);
      const n = C.validateName(name.value);
      if (!n.ok) {
        fieldError(uid + '-nome', n.message);
        name.focus();
        return;
      }
      const body = { version: s.version };
      if (n.value !== s.name) body.name = n.value;
      if (bio.value.trim() !== (s.bio || '')) body.bio = bio.value.trim();
      if (active.checked !== (s.active !== false)) body.active = active.checked;
      if (Object.keys(body).length === 1) {
        toast('Nada para salvar.');
        return;
      }
      setBusy(save, true);
      try {
        await api.updateStaff(s.id, body);
        toast('Barbeiro atualizado.');
        await loadCatalog(true);
        loadAdminStaff();
      } catch (e) {
        setBusy(save, false);
        showError(err, e.code === 'SCHEDULE_CONFLICT' ? 'Este barbeiro tem reservas futuras confirmadas. Remaneje-as antes de desativá-lo.' : C.errorMessage(e));
      }
    });
    return el('li', null, form);
  }

  // ---- expediente (admin)

  function fillBarberSelect(select) {
    const current = select.value;
    const barbers = state.adminStaff.length ? state.adminStaff : state.staff;
    select.replaceChildren(...barbers.map((b) => el('option', { text: b.name + (b.active === false ? ' (inativo)' : ''), attrs: { value: b.id } })));
    if (barbers.some((b) => b.id === current)) select.value = current;
  }

  async function loadWorkingHours() {
    const select = $('expediente-barbeiro');
    fillBarberSelect(select);
    const week = $('expediente-dias');
    showError($('expediente-erro'), '');
    if (!select.value) {
      week.replaceChildren(el('p', { className: 'empty', text: 'Nenhum barbeiro cadastrado.' }));
      return;
    }
    week.replaceChildren(el('p', { className: 'status', text: 'Carregando expediente…' }));
    try {
      const periods = await api.workingHours(select.value);
      week.replaceChildren(...WEEK_ORDER.map((wd) => {
        const p = (periods || []).find((x) => x.weekday === wd);
        const id = 'exp-' + wd;
        const on = el('input', { attrs: { type: 'checkbox', id: id + '-on' } });
        on.checked = Boolean(p);
        const start = el('input', { attrs: { type: 'time', id: id + '-ini', step: 900, value: p ? p.startLocal : '09:00', 'aria-label': C.WEEKDAYS[wd] + ': início' } });
        const end = el('input', { attrs: { type: 'time', id: id + '-fim', step: 900, value: p ? p.endLocal : '19:00', 'aria-label': C.WEEKDAYS[wd] + ': fim' } });
        const sync = () => { start.disabled = !on.checked; end.disabled = !on.checked; };
        on.addEventListener('change', sync);
        sync();
        return el('div', { className: 'week-row', attrs: { 'data-weekday': wd } },
          el('label', { className: 'day-toggle', attrs: { for: id + '-on' } }, on, C.WEEKDAYS[wd]), start, end);
      }));
    } catch (e) {
      week.replaceChildren(errorBlock(C.errorMessage(e), loadWorkingHours));
    }
  }

  async function submitWorkingHours(event) {
    event.preventDefault();
    const err = $('expediente-erro');
    showError(err, '');
    const periods = [];
    for (const wd of WEEK_ORDER) {
      if (!$('exp-' + wd + '-on') || !$('exp-' + wd + '-on').checked) continue;
      const startLocal = $('exp-' + wd + '-ini').value;
      const endLocal = $('exp-' + wd + '-fim').value;
      if (!/^\d{2}:\d{2}$/.test(startLocal) || !/^\d{2}:\d{2}$/.test(endLocal) || endLocal <= startLocal) {
        showError(err, C.WEEKDAYS[wd] + ': o fim precisa ser depois do início.');
        $('exp-' + wd + '-fim').focus();
        return;
      }
      periods.push({ weekday: wd, startLocal, endLocal });
    }
    const btn = $('expediente-salvar');
    setBusy(btn, true);
    try {
      await api.replaceWorkingHours($('expediente-barbeiro').value, { periods });
      toast('Expediente salvo.');
      await loadCatalog(true);
    } catch (e) {
      showError(err, e.code === 'SCHEDULE_CONFLICT' ? 'Há reservas confirmadas fora do novo expediente. Remaneje-as antes de salvar.' : C.errorMessage(e));
    } finally {
      setBusy(btn, false);
    }
  }

  // ---- bloqueios (admin)

  async function loadBlocks() {
    fillBarberSelect($('bloqueio-barbeiro'));
    if (!$('bloqueio-data').value) $('bloqueio-data').value = C.todayIn(state.tz);
    const list = $('admin-bloqueios');
    skeletons(list, 1);
    const from = C.todayIn(state.tz);
    try {
      const blocks = await api.blocks({ from, to: C.addDays(from, 30) });
      list.replaceChildren(...(blocks.length ? blocks.map((b) => el('li', { className: 'card admin-item' },
        el('div', { className: 'grow' },
          el('strong', { text: staffName(b.staffId) || 'Barbeiro' }),
          el('p', { className: 'muted small', text: whenText(b.startAt) + '–' + C.formatTime(b.endAt, state.tz) + (b.reason ? ' · ' + b.reason : '') })),
        button('Remover', 'btn-danger btn-sm', async (ev) => {
          setBusy(ev.currentTarget, true);
          try {
            await api.deleteBlock(b.id, b.version);
            toast('Bloqueio removido.');
          } catch (e) {
            toast(C.errorMessage(e), true);
          }
          loadBlocks();
        }, { 'aria-label': 'Remover bloqueio de ' + whenText(b.startAt) }))) : [emptyItem('Nenhum bloqueio nos próximos 30 dias.')]));
    } catch (e) {
      list.replaceChildren(el('li', null, errorBlock(C.errorMessage(e), loadBlocks)));
    }
  }

  async function submitBlock(event) {
    event.preventDefault();
    const form = $('form-bloqueio');
    clearForm(form);
    const date = $('bloqueio-data').value;
    const startAt = C.zonedToInstant(date, $('bloqueio-inicio').value, state.tz);
    const endAt = C.zonedToInstant(date, $('bloqueio-fim').value, state.tz);
    if (!startAt || !endAt) {
      showError($('bloqueio-erro'), 'Informe data, início e fim.');
      return;
    }
    if (endAt <= startAt) {
      fieldError('bloqueio-fim', 'O fim precisa ser depois do início.');
      $('bloqueio-fim').focus();
      return;
    }
    const btn = $('bloqueio-salvar');
    setBusy(btn, true);
    try {
      await api.createBlock({ staffId: $('bloqueio-barbeiro').value, startAt, endAt, reason: $('bloqueio-motivo').value.trim() });
      toast('Horário bloqueado.');
      $('bloqueio-motivo').value = '';
      loadBlocks();
    } catch (e) {
      showError($('bloqueio-erro'), e.code === 'SLOT_CONFLICT' ? 'Já existe reserva ou bloqueio nesse intervalo. Nada foi cancelado.' : C.errorMessage(e));
    } finally {
      setBusy(btn, false);
    }
  }

  // ---- barbearia (admin)

  async function loadShopForm() {
    // Bloqueia a edição até os dados chegarem, para o carregamento não sobrescrever o que for digitado.
    const controls = ['barbearia-nome', 'barbearia-endereco', 'barbearia-telefone', 'barbearia-salvar'].map($);
    for (const c of controls) c.disabled = true;
    try {
      state.shop = Object.assign({}, state.shop, await api.shop());
    } catch (e) {
      showError($('barbearia-erro'), C.errorMessage(e));
    } finally {
      for (const c of controls) c.disabled = false;
    }
    const shop = state.shop || {};
    $('barbearia-nome').value = shop.name || '';
    $('barbearia-endereco').value = shop.address || '';
    $('barbearia-telefone').value = shop.contactPhone ? C.formatPhoneBR(shop.contactPhone) : '';
  }

  async function submitShop(event) {
    event.preventDefault();
    const form = $('form-barbearia');
    clearForm(form);
    const name = $('barbearia-nome').value.trim();
    const address = $('barbearia-endereco').value.trim();
    const phoneText = $('barbearia-telefone').value.trim();
    if (name.length < 1 || name.length > 100) {
      showError($('barbearia-erro'), 'Informe o nome da barbearia (até 100 caracteres).');
      $('barbearia-nome').focus();
      return;
    }
    let contactPhone = null;
    if (phoneText) {
      contactPhone = C.normalizePhoneBR(phoneText);
      if (!contactPhone) {
        fieldError('barbearia-telefone', 'Telefone inválido. Use DDD, por exemplo (11) 3456-7890.');
        $('barbearia-telefone').focus();
        return;
      }
    }
    const btn = $('barbearia-salvar');
    setBusy(btn, true);
    try {
      await api.updateShop({ version: state.shop.version, name, address, contactPhone });
      toast('Dados da barbearia salvos.');
      await loadCatalog(true);
      loadShopForm();
    } catch (e) {
      if (!applyFieldErrors(e, form)) showError($('barbearia-erro'), C.errorMessage(e));
    } finally {
      setBusy(btn, false);
    }
  }

  // ---------------------------------------------------------------- navegação

  function route() {
    const name = (root.location.hash || '#inicio').slice(1);
    if (name === 'conteudo') return;
    const view = VIEWS.includes(name) ? name : 'inicio';
    for (const v of VIEWS) $('view-' + v).hidden = v !== view;
    doc.querySelectorAll('[data-nav]').forEach((a) => {
      if (a.dataset.nav === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (view === 'agendar') enterBooking();
    else if (view === 'reservas') loadReservations();
    else if (view === 'equipe') enterTeam();
    if (!state.firstRoute) {
      const heading = $('titulo-' + view);
      if (heading) heading.focus({ preventScroll: true });
      root.scrollTo(0, 0);
    }
    state.firstRoute = false;
  }

  function bind() {
    root.addEventListener('hashchange', route);
    $('sair').addEventListener('click', logout);
    $('form-agendar').addEventListener('submit', submitBooking);
    $('agendar-novo').addEventListener('click', () => {
      $('agendar-sucesso').hidden = true;
      $('form-agendar').hidden = false;
      $('titulo-agendar').focus();
    });
    for (const id of ['cad-telefone', 'rec-telefone', 'barbearia-telefone']) {
      $(id).addEventListener('input', (ev) => { ev.target.value = C.maskPhoneInput(ev.target.value); });
    }
    $('cad-nome').addEventListener('blur', () => { if ($('cad-nome').value) { const v = C.validateName($('cad-nome').value); fieldError('cad-nome', v.ok ? '' : v.message); } });
    $('cad-telefone').addEventListener('blur', () => { if ($('cad-telefone').value) { const v = C.validatePhone($('cad-telefone').value); fieldError('cad-telefone', v.ok ? '' : v.message); } });
    $('reservas-periodo').addEventListener('change', loadReservations);
    $('form-recuperar').addEventListener('submit', requestRecovery);
    $('rec-verificar').addEventListener('click', verifyRecovery);
    $('form-equipe-login').addEventListener('submit', submitLogin);
    for (const p of PANELS) {
      $('ptab-' + p).addEventListener('click', () => selectPanel(p));
      $('ptab-' + p).addEventListener('keydown', onPanelKey);
    }
    $('agenda-anterior').addEventListener('click', () => moveAgenda(-1));
    $('agenda-proximo').addEventListener('click', () => moveAgenda(1));
    $('agenda-hoje').addEventListener('click', () => { state.agendaDate = C.todayIn(state.tz); loadAgenda(); });
    $('agenda-data').addEventListener('change', (ev) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(ev.target.value)) { state.agendaDate = ev.target.value; loadAgenda(); }
    });
    $('form-servico').addEventListener('submit', submitService);
    $('servico-cancelar').addEventListener('click', () => editService(null));
    $('form-expediente').addEventListener('submit', submitWorkingHours);
    $('expediente-barbeiro').addEventListener('change', loadWorkingHours);
    $('form-bloqueio').addEventListener('submit', submitBlock);
    $('form-barbearia').addEventListener('submit', submitShop);
    const reset = $('demo-reset');
    if (reset && isDemo) {
      reset.addEventListener('click', () => {
        if (reset.dataset.confirm !== '1') {
          reset.dataset.confirm = '1';
          reset.textContent = 'Confirmar: apagar tudo';
          return;
        }
        api.resetDemo();
        root.location.hash = '#inicio';
        root.location.reload();
      });
    }
  }

  function start() {
    doc.body.dataset.mode = isDemo ? 'demo' : 'api';
    bind();
    loadCatalog();
    refreshMe();
    route();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
