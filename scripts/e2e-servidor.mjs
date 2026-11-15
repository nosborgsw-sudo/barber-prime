// Ponta a ponta sobre o servidor real em processo separado (o mesmo de `npm start`), com banco
// temporário: frontend servido, catálogo, cadastro, reserva, conflito, isolamento entre clientes,
// reagendamento, painel da equipe, reinício do processo com persistência e cancelamento.
// Uso: node scripts/e2e-servidor.mjs  (sai com código 0 e "E2E OK" quando tudo confere).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'server', 'index.mjs');
const STARTUP_MS = 60_000;

// Sobe `node server/index.mjs` com porta livre e devolve a URL base e stop().
function startProcess(env) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`servidor não subiu em ${STARTUP_MS} ms: ${output}`)), STARTUP_MS);
    const onData = (chunk) => {
      output += chunk;
      const found = /ativo na porta (\d+)/.exec(output);
      if (found) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${found[1]}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`servidor encerrou (código ${code}): ${output}`));
    });
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });
  return { ready, stop };
}

// Cliente com cookies, como um navegador. `browser: true` envia Origin e X-CSRF-Token como o frontend.
class Client {
  constructor(base, { browser = false } = {}) {
    this.base = base;
    this.browser = browser;
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(method, path, { body, headers = {} } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (this.browser && method !== 'GET') {
      if (!this.csrf) this.csrf = (await this.request('GET', '/api/auth/csrf')).json.data.csrfToken;
      init.headers.origin = this.base;
      init.headers['x-csrf-token'] = this.csrf;
    }
    if (this.cookies.size) init.headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(this.base + path, init);
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const value = pair.slice(index + 1);
      if (value === '' || /Max-Age=0/i.test(line)) this.cookies.delete(pair.slice(0, index));
      else this.cookies.set(pair.slice(0, index), value);
    }
    const text = await response.text();
    const json = text && (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : null;
    if (json?.data?.csrfToken) this.csrf = json.data.csrfToken;
    return { status: response.status, json, text };
  }

  get(path) { return this.request('GET', path); }
  post(path, body, headers) { return this.request('POST', path, { body, headers }); }
  patch(path, body) { return this.request('PATCH', path, { body }); }
}

// Próximo dia útil (seg–sáb) a pelo menos `minDays` dias, em data local de São Paulo.
function nextWorkday(minDays) {
  const d = new Date(Date.now() + minDays * 86_400_000);
  for (;;) {
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
    if (new Date(`${local}T12:00:00Z`).getUTCDay() !== 0) return local;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// Números de celular válidos e diferentes a cada execução.
const phone = () => `11 9${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

export async function runE2E({ log = console.log } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bp-e2e-'));
  // Senha gerada a cada execução: nenhuma credencial fica escrita no repositório.
  const admin = { login: 'gerente', password: randomBytes(18).toString('base64url') };
  const env = { DATA_DIR: dataDir, DATABASE_URL: '', ADMIN_LOGIN: admin.login, ADMIN_PASSWORD: admin.password };
  let server = startProcess(env);
  let checks = 0;
  const check = (ok, label, detail = '') => {
    if (!ok) throw new Error(`falhou: ${label}${detail ? ` (${detail})` : ''}`);
    checks += 1;
    log(`✔ ${label}`);
  };
  try {
    let base = await server.ready;
    const anon = new Client(base);

    const health = await anon.get('/api/health');
    check(health.status === 200 && health.json.database === 'ok', 'saúde: servidor e banco respondendo');
    const home = await anon.get('/');
    check(home.status === 200 && home.text.includes('Barber Prime') && home.text.includes('api.js'), 'frontend servido em / com o cliente da API');
    const autonomo = await anon.get('/app-autonomo.html');
    check(autonomo.status === 200 && autonomo.text.includes('DEMONSTRAÇÃO'), 'app-autonomo.html servido e marcado como DEMONSTRAÇÃO');

    const shop = (await anon.get('/api/shop')).json.data;
    check(shop.openingHours.length === 6, 'horário de funcionamento por dia da semana', JSON.stringify(shop.openingHours));
    const staff = (await anon.get('/api/staff')).json.data;
    const services = (await anon.get('/api/services')).json.data;
    check(staff.length === 4, 'quatro barbeiros no catálogo', String(staff.length));
    check(services.every((s) => s.priceCents > 0 && s.durationMinutes > 0), 'serviços com preço e duração');

    const date = nextWorkday(2);
    const slotsPath = `/api/availability?staffId=${staff[0].id}&serviceId=${services[0].id}&date=${date}`;
    const free = (await anon.get(slotsPath)).json.data.slots;
    const later = free.find((s) => Date.parse(s.startAt) >= Date.parse(free[0].endAt));
    check(free.length > 1 && later, 'disponibilidade por profissional e dia', `${free.length} horários`);

    const ana = new Client(base, { browser: true });
    const anaPhone = phone();
    check((await ana.post('/api/auth/register', { name: 'Ana Homologação', phone: anaPhone })).status === 202, 'cadastro só com nome e telefone (navegador com CSRF)');
    check((await ana.get('/api/me')).json?.data?.role === 'customer', 'cadastro abre sessão de cliente');

    const invalid = await new Client(base, { browser: true }).post('/api/auth/register', { name: 'X', phone: '123' });
    check(invalid.status === 400 && invalid.json.error.code === 'VALIDATION_ERROR', 'entrada inválida recusada com 400');

    const intruder = new Client(base, { browser: true });
    check((await intruder.post('/api/auth/register', { name: 'Outra Pessoa', phone: anaPhone })).status === 202
      && (await intruder.get('/api/me')).status === 401, 'telefone já cadastrado não duplica nem entrega sessão');

    const key = { 'idempotency-key': randomBytes(18).toString('base64url') };
    const body = { staffId: staff[0].id, serviceId: services[0].id, startAt: free[0].startAt };
    const created = await ana.post('/api/appointments', body, key);
    check(created.status === 201 && created.json.data.status === 'confirmed', 'agendamento confirmado', created.text);
    const replay = await ana.post('/api/appointments', body, key);
    check(replay.status === 200 && replay.json.data.id === created.json.data.id, 'reenvio com a mesma Idempotency-Key não duplica');
    const booking = created.json.data;

    const bruno = new Client(base, { browser: true });
    await bruno.post('/api/auth/register', { name: 'Bruno Homologação', phone: phone() });
    const clash = await bruno.post('/api/appointments', body);
    check(clash.status === 409 && clash.json.error.code === 'SLOT_CONFLICT', 'conflito de horário recusado com 409');
    check(!(await bruno.get(slotsPath)).json.data.slots.some((s) => s.startAt === free[0].startAt), 'horário ocupado some da disponibilidade');
    check((await bruno.get(`/api/appointments/${booking.id}`)).status === 404
      && (await bruno.post(`/api/appointments/${booking.id}/cancel`, { version: booking.version })).status === 404,
    'cliente não consulta nem cancela reserva de terceiro');

    const moved = await ana.patch(`/api/appointments/${booking.id}/reschedule`, { startAt: later.startAt, version: booking.version });
    check(moved.status === 200 && moved.json.data.startAt === later.startAt, 'reagendamento para outro horário livre');

    const gerente = new Client(base, { browser: true });
    check((await gerente.post('/api/auth/session', admin)).json?.data?.role === 'admin', 'login do administrador');
    const agenda = (await gerente.get(`/api/appointments?from=${date}&to=${date}`)).json.data;
    check(agenda.some((a) => a.id === booking.id && a.customerName === 'Ana Homologação'), 'painel: agenda da equipe mostra a reserva');

    await server.stop();
    server = startProcess(env);
    base = await server.ready;
    for (const c of [ana, gerente]) c.base = base;
    const mine = (await ana.get('/api/appointments')).json?.data ?? [];
    check(mine.some((a) => a.id === booking.id && a.startAt === later.startAt), 'após reiniciar o processo: sessão e reserva persistem');

    const cancelled = await ana.post(`/api/appointments/${booking.id}/cancel`, { version: moved.json.data.version });
    check(cancelled.status === 200 && cancelled.json.data.status === 'cancelled', 'cancelamento pelo próprio cliente');
    check((await new Client(base).get(slotsPath)).json.data.slots.some((s) => s.startAt === later.startAt), 'horário cancelado volta a ficar livre');

    log(`E2E OK: ${checks} verificações no servidor real (processo separado, PostgreSQL embutido).`);
    return checks;
  } finally {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runE2E().catch((error) => {
    console.error(`E2E FALHOU: ${error.message}`);
    process.exitCode = 1;
  });
}
