// Envio de SMS pela API oficial da Twilio (Messages resource), sem SDK e sem automação de tela.
//   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
//   Basic auth (Account SID + Auth Token, ou API Key SID + Secret), corpo application/x-www-form-urlencoded
//   com To, Body e From ou MessagingServiceSid.
//
// Configuração por ambiente (nunca no código):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN               ou TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET
//   TWILIO_FROM (+E.164)                                 ou TWILIO_MESSAGING_SERVICE_SID
// Sem configuração completa, createSmsProvider lança PROVIDER_NOT_CONFIGURED e o backend responde 503
// (contrato: recuperação de acesso exige provedor configurado).
//
// Erros nunca carregam credenciais, telefone completo nem código: só status HTTP e código da Twilio.

const API_BASE = 'https://api.twilio.com/2010-04-01';
const SID_RE = /^AC[0-9a-f]{32}$/i;
const KEY_RE = /^SK[0-9a-f]{32}$/i;
const SERVICE_RE = /^MG[0-9a-f]{32}$/i;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const BR_PHONE_RE = /^\+55\d{10,11}$/;
const CODE_RE = /^\d{6}$/;

export class ProviderError extends Error {
  constructor(code, message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function maskPhone(phone) {
  const s = String(phone ?? '');
  return s.length > 4 ? `${'*'.repeat(s.length - 4)}${s.slice(-4)}` : '****';
}

/** Lê a configuração do ambiente. Devolve null quando incompleta ou malformada (sem dizer qual segredo falta). */
export function loadSmsConfig(env = process.env) {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  if (!accountSid || !SID_RE.test(accountSid)) return null;
  let username;
  let password;
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    if (!KEY_RE.test(env.TWILIO_API_KEY_SID.trim())) return null;
    username = env.TWILIO_API_KEY_SID.trim();
    password = env.TWILIO_API_KEY_SECRET;
  } else if (env.TWILIO_AUTH_TOKEN) {
    username = accountSid;
    password = env.TWILIO_AUTH_TOKEN;
  } else return null;
  const from = env.TWILIO_FROM?.trim() || null;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null;
  if (messagingServiceSid && !SERVICE_RE.test(messagingServiceSid)) return null;
  if (!messagingServiceSid && !(from && E164_RE.test(from))) return null;
  return { accountSid, username, password, from, messagingServiceSid };
}

function formatLocalTime(value, timeZone) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ProviderError('INVALID_INPUT', 'expiresAt inválido');
  return new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/**
 * Cria o provedor. `fetchImpl` é injetável para testes; a chamada real usa o fetch do Node.
 * Retorna { sendSms({to, body}), sendChallenge({challengeId, destination, code, expiresAt}) }.
 */
export function createSmsProvider({
  config = loadSmsConfig(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  timeZone = 'America/Sao_Paulo',
  brand = 'Barber Prime',
} = {}) {
  if (!config) throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Provedor de SMS não configurado.');
  const url = `${API_BASE}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;

  async function sendSms({ to, body }) {
    if (typeof to !== 'string' || !E164_RE.test(to)) throw new ProviderError('INVALID_INPUT', 'Destino precisa estar em E.164.');
    if (typeof body !== 'string' || body.length < 1 || body.length > 320) {
      throw new ProviderError('INVALID_INPUT', 'Mensagem precisa ter de 1 a 320 caracteres.');
    }
    const form = new URLSearchParams({ To: to, Body: body });
    if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
    else form.set('From', config.from);

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new ProviderError(timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
        timeout ? 'Provedor de SMS não respondeu a tempo.' : 'Provedor de SMS inacessível.', { retryable: true });
    }
    let data = null;
    try { data = await res.json(); } catch { /* corpo não JSON */ }
    if (res.ok) return { providerId: typeof data?.sid === 'string' ? data.sid : null, status: data?.status ?? null };
    const twilioCode = Number.isInteger(data?.code) ? ` (código ${data.code})` : '';
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(res.status === 401 ? 'PROVIDER_AUTH' : 'PROVIDER_REJECTED',
      `Provedor de SMS recusou o envio: HTTP ${res.status}${twilioCode}.`, { retryable, status: res.status });
  }

  async function sendChallenge({ challengeId, destination, code, expiresAt }) {
    if (typeof challengeId !== 'string' || challengeId.length < 1 || challengeId.length > 64) {
      throw new ProviderError('INVALID_INPUT', 'challengeId inválido.');
    }
    if (typeof destination !== 'string' || !BR_PHONE_RE.test(destination)) {
      throw new ProviderError('INVALID_INPUT', 'Telefone precisa estar normalizado (+55DDNNNNNNNNN).');
    }
    if (typeof code !== 'string' || !CODE_RE.test(code)) throw new ProviderError('INVALID_INPUT', 'Código precisa ter 6 dígitos.');
    const until = formatLocalTime(expiresAt, timeZone);
    const body = `${brand}: seu código de acesso é ${code}. Válido até ${until}. Não compartilhe este código.`;
    return sendSms({ to: destination, body });
  }

  return { sendSms, sendChallenge };
}

/** Atalho para o backend: usa a configuração do ambiente. */
export async function sendChallenge(input, options = {}) {
  return createSmsProvider(options).sendChallenge(input);
}
