// Apoio dos testes do backend: servidor real (PostgreSQL embutido PGlite) e cliente HTTP com cookies.
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromEnv, createApp } from '../../server/app.mjs';
import { ensureAdmin } from '../../server/auth/rotas.mjs';
import { openDatabase } from '../../server/db.mjs';

// Credenciais geradas a cada execução: nenhuma senha fica escrita no repositório.
export const randomSecret = () => randomBytes(18).toString('base64url');
export const ADMIN = { login: 'gerente', password: randomSecret() };
const silent = { info() {}, error() {}, warn() {} };

// Sobe app sobre um banco (memória ou diretório) e devolve base URL, pool e close().
export async function startApp({ dataDir = 'memory://', sendChallenge = null, admin = true } = {}) {
  const pool = await openDatabase({ databaseUrl: '', dataDir });
  if (admin) await ensureAdmin(pool, ADMIN);
  const server = createApp({ pool, config: configFromEnv({}), sendChallenge, log: silent });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, pool,
    client: () => new Client(base),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'bp-backend-'));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

// Cliente que guarda cookies como um navegador. `browser: true` envia Origin e X-CSRF-Token.
export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(method, path, { body, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (this.cookies.size) init.headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.headers['content-type'] ??= 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(this.base + path, init);
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '' || /Max-Age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    const json = text && (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : null;
    return { status: response.status, headers: response.headers, json, text };
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, body, opts = {}) { return this.request('POST', path, { ...opts, body }); }
  patch(path, body, opts = {}) { return this.request('PATCH', path, { ...opts, body }); }
  put(path, body, opts = {}) { return this.request('PUT', path, { ...opts, body }); }
  delete(path, opts) { return this.request('DELETE', path, opts); }

  // Como o frontend: busca o token e manda Origin da própria aplicação + X-CSRF-Token.
  async browser(method, path, body, headers = {}) {
    if (!this.csrf) this.csrf = (await this.get('/api/auth/csrf')).json.data.csrfToken;
    const res = await this.request(method, path, { body, headers: { origin: this.base, 'x-csrf-token': this.csrf, ...headers } });
    // Login/cadastro emitem sessão nova com outro token: o cliente passa a usar o devolvido.
    if (res.json?.data?.csrfToken) this.csrf = res.json.data.csrfToken;
    return res;
  }
}

export async function registerCustomer(client, name, phone) {
  const res = await client.post('/api/auth/register', { name, phone });
  if (res.status !== 202) throw new Error(`cadastro falhou: ${res.status} ${res.text}`);
  return res;
}

export async function loginAdmin(client) {
  const res = await client.post('/api/auth/session', ADMIN);
  if (res.status !== 200) throw new Error(`login admin falhou: ${res.status} ${res.text}`);
  return res.json.data;
}

// Próximo dia útil (seg–sáb) a pelo menos `minDays` dias, em data local de São Paulo.
export function nextWorkday(minDays = 2) {
  const d = new Date(Date.now() + minDays * 86_400_000);
  for (;;) {
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
    if (new Date(`${local}T12:00:00Z`).getUTCDay() !== 0) return local;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export async function catalog(client) {
  const staff = (await client.get('/api/staff')).json.data;
  const services = (await client.get('/api/services')).json.data;
  return { staff, services };
}

export async function slots(client, staffId, serviceId, date) {
  const res = await client.get(`/api/availability?staffId=${staffId}&serviceId=${serviceId}&date=${date}`);
  if (res.status !== 200) throw new Error(`disponibilidade falhou: ${res.status} ${res.text}`);
  return res.json.data.slots;
}
