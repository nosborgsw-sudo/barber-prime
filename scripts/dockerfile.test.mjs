import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

// Caminhos (relativos à raiz) que o Dockerfile copia para a imagem.
const copied = [...DOCKERFILE.matchAll(/^COPY\s+(?!--)(.+?)\s+\S+\s*$/gm)]
  .flatMap(([, srcs]) => srcs.split(/\s+/))
  .map((p) => p.replace(/^\.\//, '').replace(/\/$/, ''));

const isCopied = (rel) => copied.some((c) => rel === c || rel.startsWith(c + '/'));

// Imports relativos: estáticos, dinâmicos com texto fixo e new URL('./x.mjs', import.meta.url).
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|new\s+URL\(\s*)['"](\.{1,2}\/[^'"]+\.m?js)['"]/g;

// Segue os imports relativos a partir do ponto de entrada.
function localGraph(entry) {
  const seen = new Set();
  const stack = [join(ROOT, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(IMPORT_RE)) {
      const target = join(dirname(file), spec);
      assert.ok(existsSync(target), `${relative(ROOT, file)} importa ${spec}, que não existe`);
      stack.push(target);
    }
  }
  return [...seen].map((f) => relative(ROOT, f).split('\\').join('/'));
}

test('devops: Dockerfile copia todo módulo local usado pelo servidor', () => {
  const graph = localGraph('server/index.mjs');
  assert.ok(graph.includes('automation/challenge-provider.mjs'), 'segue o import por new URL()');
  const missing = graph.filter((f) => !isCopied(f));
  assert.deepEqual(missing, [], 'módulos que faltariam na imagem');
});

test('devops: .dockerignore barra segredos e banco local sem excluir o que a imagem copia', () => {
  const ignored = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const must of ['.env', '.env.*', 'node_modules', 'data', '.git']) assert.ok(ignored.includes(must), must);
  const blocked = copied.filter((c) => ignored.some((i) => !i.startsWith('!') && (c === i || c.startsWith(i + '/'))));
  assert.deepEqual(blocked, [], 'caminhos copiados pelo Dockerfile que o .dockerignore exclui');
});

test('devops: Dockerfile roda sem root, com healthcheck e sem segredo embutido', () => {
  assert.match(DOCKERFILE, /^USER node$/m);
  assert.match(DOCKERFILE, /^HEALTHCHECK .*\n?.*\/api\/health/m);
  assert.match(DOCKERFILE, /npm ci --omit=dev/);
  assert.ok(isCopied('public') && isCopied('migrations') && isCopied('package-lock.json'));
  assert.doesNotMatch(DOCKERFILE, /^(ENV|ARG)\s+.*(PASSWORD|SECRET|TOKEN|TWILIO_AUTH)/im, 'segredo não entra na imagem');
});
