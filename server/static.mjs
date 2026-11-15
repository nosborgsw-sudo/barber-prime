// Arquivos do frontend (public/**) e o HTML autônomo da raiz, com proteção contra path traversal.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_ROOT = resolve(PROJECT_ROOT, 'public');
const AUTONOMOUS = resolve(PROJECT_ROOT, 'app-autonomo.html');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

// Devolve o caminho absoluto dentro de public/ ou null (caminho suspeito, extensão desconhecida).
export function resolveStatic(pathname) {
  if (pathname === '/app-autonomo.html') return AUTONOMOUS;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((p) => p === '..' || p.startsWith('.') && p.length > 0)) {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = resolve(PUBLIC_ROOT, relative);
  if (full !== PUBLIC_ROOT && !full.startsWith(PUBLIC_ROOT + sep)) return null;
  if (!TYPES[extname(full).toLowerCase()]) return null;
  return full;
}

// public/ não tem script nem estilo inline: só recursos da própria origem. O HTML autônomo é um arquivo
// único (scripts e estilos inline) que não acessa a rede.
const CSP_PUBLIC = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
  + "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const CSP_AUTONOMOUS = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
  + "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function serveStatic(request, response, pathname) {
  const file = resolveStatic(pathname);
  if (!file) return false;
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const type = TYPES[extname(file).toLowerCase()];
  response.setHeader('Content-Type', type);
  response.setHeader('Content-Length', info.size);
  response.setHeader('Cache-Control', type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300');
  response.setHeader('Content-Security-Policy', file === AUTONOMOUS ? CSP_AUTONOMOUS : CSP_PUBLIC);
  response.writeHead(200);
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  await new Promise((done) => {
    const stream = createReadStream(file);
    stream.on('error', () => { response.destroy(); done(); });
    stream.on('end', done);
    stream.pipe(response);
  });
  return true;
}
