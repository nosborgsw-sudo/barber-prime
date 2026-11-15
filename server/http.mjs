// Utilitários de transporte HTTP: corpo JSON limitado, query estrita, cookies e erros no formato do contrato.
import { DataError } from '../db/index.mjs';

export const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(status, code, message, { fields, headers } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
    if (headers) this.headers = headers;
  }
}

export const httpError = (status, code, message, extra) => new HttpError(status, code, message, extra);
export const invalid = (field, reason) =>
  new HttpError(400, 'VALIDATION_ERROR', 'Entrada inválida.', { fields: { [field]: reason } });

export function sendJson(response, status, body, headers = {}) {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  if (status === 204 || body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// Converte qualquer erro em resposta do contrato. Erro inesperado não vaza mensagem, SQL nem stack.
export function sendError(response, err, log = console) {
  let status = 500;
  let error = { code: 'INTERNAL', message: 'Erro interno.' };
  if (err instanceof HttpError) {
    status = err.status;
    error = { code: err.code, message: err.message };
    if (err.fields) error.fields = err.fields;
    for (const [name, value] of Object.entries(err.headers ?? {})) response.setHeader(name, value);
  } else if (err instanceof DataError && err.status && err.status < 500) {
    status = err.status;
    error = { code: err.code, message: err.message };
    if (err.fields) error.fields = err.fields;
  } else if (err instanceof DataError && err.code === 'DB_UNAVAILABLE') {
    status = 503;
    error = { code: 'DB_UNAVAILABLE', message: 'Serviço temporariamente indisponível.' };
  } else {
    const cause = err?.cause ?? err;
    log.error(`Erro interno (${cause?.name ?? 'Error'}${cause?.code ? ` ${cause.code}` : ''}).`);
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendJson(response, status, { error });
}

export async function readJson(request) {
  const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw httpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie o corpo como application/json.');
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw httpError(413, 'PAYLOAD_TOO_LARGE', 'Corpo acima de 64 KiB.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'PAYLOAD_TOO_LARGE', 'Corpo acima de 64 KiB.');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'INVALID_JSON', 'JSON inválido.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('corpo', 'objeto JSON obrigatório');
  return body;
}

// Rejeita campos desconhecidos e exige os obrigatórios.
export function onlyFields(body, allowed, required = []) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw invalid(key, 'campo não permitido');
  for (const key of required) if (body[key] === undefined) throw invalid(key, 'obrigatório');
  return body;
}

// Query estrita: parâmetros desconhecidos ou repetidos são recusados.
export function readQuery(url, allowed) {
  const out = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key)) throw invalid(key, 'parâmetro não permitido');
    if (key in out) throw invalid(key, 'parâmetro repetido');
    if (value.length > 200) throw invalid(key, 'valor longo demais');
    out[key] = value;
  }
  return out;
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!(name in out)) out[name] = part.slice(index + 1).trim();
  }
  return out;
}

export function intParam(value, field, min, max) {
  if (value === undefined) return undefined;
  if (!/^\d{1,10}$/.test(value)) throw invalid(field, `inteiro ${min}..${max}`);
  const n = Number(value);
  if (n < min || n > max) throw invalid(field, `inteiro ${min}..${max}`);
  return n;
}
