// Barber Prime — adaptador HTTP para a API real (docs/contrato-api.json).
// Sessão em cookie HttpOnly (mesma origem); mutações levam X-CSRF-Token.
(function (root) {
  'use strict';
  const { ApiError } = root.BPCore;

  function createApiAdapter(options) {
    const opts = options || {};
    const base = opts.base || '/api';
    const fetchFn = opts.fetch || root.fetch.bind(root);
    let csrfToken = null;

    async function parse(response) {
      if (response.status === 204) return null;
      const type = response.headers.get('content-type') || '';
      const body = type.includes('application/json') ? await response.json().catch(() => null) : null;
      if (!response.ok) {
        const err = body && body.error ? body.error : {};
        const e = ApiError(response.status, err.code || 'HTTP_' + response.status, err.message, err.fields);
        const retry = response.headers.get('retry-after');
        if (retry) e.retryAfter = Number(retry);
        throw e;
      }
      return body;
    }

    async function send(method, path, { body, query, headers } = {}) {
      let url = base + path;
      if (query) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
        const s = qs.toString();
        if (s) url += '?' + s;
      }
      const init = { method, credentials: 'same-origin', headers: Object.assign({ Accept: 'application/json' }, headers) };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      try {
        return await fetchFn(url, init);
      } catch {
        throw ApiError(0, 'NETWORK_ERROR', null);
      }
    }

    async function refreshCsrf() {
      const res = await parse(await send('GET', '/auth/csrf'));
      csrfToken = res && res.data ? res.data.csrfToken : null;
      return csrfToken;
    }

    async function request(method, path, extra) {
      const opt = extra || {};
      const mutation = method !== 'GET';
      if (mutation && !csrfToken) await refreshCsrf();
      const call = () => send(method, path, Object.assign({}, opt, {
        headers: Object.assign({}, opt.headers, mutation ? { 'X-CSRF-Token': csrfToken } : {}),
      }));
      let response = await call();
      // Token vencido ou sessão trocada: renova uma única vez e repete.
      if (mutation && response.status === 403) {
        const peek = await response.clone().json().catch(() => null);
        if (peek && peek.error && /CSRF/i.test(peek.error.code || '')) {
          await refreshCsrf();
          response = await call();
        }
      }
      const parsed = await parse(response);
      return parsed;
    }

    const data = (p) => p.then((r) => (r ? r.data : null));

    // Cadastro, login e verificação criam sessão nova: usa o csrfToken devolvido ou busca outro.
    async function withSession(p) {
      const r = await data(p);
      if (r && typeof r.csrfToken === 'string' && r.csrfToken) csrfToken = r.csrfToken;
      else await refreshCsrf().catch(() => null);
      return r;
    }

    return {
      mode: 'api',
      isDemo: false,
      shop: () => data(request('GET', '/shop')),
      staff: () => data(request('GET', '/staff')),
      services: () => data(request('GET', '/services')),
      availability: (q) => data(request('GET', '/availability', { query: q })),
      // Estado da sessão: null quando ninguém entrou (a rota responde 200, sem erro no console).
      async me() {
        try {
          return await data(request('GET', '/auth/session'));
        } catch (e) {
          if (e.status === 401) return null;
          throw e;
        }
      },
      register: (body) => withSession(request('POST', '/auth/register', { body })),
      requestChallenge: (body) => data(request('POST', '/auth/challenges', { body })),
      verifyChallenge: (body) => withSession(request('POST', '/auth/challenges/verify', { body })),
      login: (body) => withSession(request('POST', '/auth/session', { body })),
      async logout() {
        await request('DELETE', '/auth/session');
        csrfToken = null;
      },
      createAppointment: (body, idempotencyKey) =>
        data(request('POST', '/appointments', { body, headers: { 'Idempotency-Key': idempotencyKey } })),
      listAppointments: (q) => request('GET', '/appointments', { query: q }).then((r) => ({ data: r.data || [], meta: r.meta || {} })),
      getAppointment: (id) => data(request('GET', '/appointments/' + encodeURIComponent(id))),
      reschedule: (id, body) => data(request('PATCH', '/appointments/' + encodeURIComponent(id) + '/reschedule', { body })),
      cancel: (id, body) => data(request('POST', '/appointments/' + encodeURIComponent(id) + '/cancel', { body })),
      setStatus: (id, body) => data(request('PATCH', '/appointments/' + encodeURIComponent(id) + '/status', { body })),
      adminStaff: () => data(request('GET', '/admin/staff')),
      adminServices: () => data(request('GET', '/admin/services')),
      updateShop: (body) => data(request('PATCH', '/admin/shop', { body })),
      createService: (body) => data(request('POST', '/admin/services', { body })),
      updateService: (id, body) => data(request('PATCH', '/admin/services/' + encodeURIComponent(id), { body })),
      updateStaff: (id, body) => data(request('PATCH', '/admin/staff/' + encodeURIComponent(id), { body })),
      workingHours: (staffId) => data(request('GET', '/admin/working-hours', { query: { staffId } })),
      replaceWorkingHours: (staffId, body) => data(request('PUT', '/admin/working-hours/' + encodeURIComponent(staffId), { body })),
      blocks: (q) => data(request('GET', '/admin/blocks', { query: q })),
      createBlock: (body) => data(request('POST', '/admin/blocks', { body })),
      deleteBlock: (id, version) => request('DELETE', '/admin/blocks/' + encodeURIComponent(id), { query: { version } }),
    };
  }

  root.BPApi = { createApiAdapter };
})(typeof window !== 'undefined' ? window : globalThis);
