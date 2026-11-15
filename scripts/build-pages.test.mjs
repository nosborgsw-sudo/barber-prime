import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPages, validatePagesHtml } from './build-pages.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OK = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>'
  + '<body>DEMONSTRAÇÃO<script>localStorage.x=1</script></body></html>';

test('devops: build gera a versão HTML pública autônoma em dist/', () => {
  const out = join('dist', 'test-pages');
  const { outDir, files } = buildPages(out);
  const original = readFileSync(join(ROOT, 'app-autonomo.html'), 'utf8');
  assert.deepEqual(files, ['index.html', 'app-autonomo.html', '404.html', '.nojekyll']);
  for (const f of files) assert.ok(existsSync(join(outDir, f)), f);
  assert.equal(readFileSync(join(outDir, 'index.html'), 'utf8'), original);
  assert.equal(readFileSync(join(ROOT, 'dist', '.gitignore'), 'utf8'), '*\n', 'saída de build fora do Git');
  assert.deepEqual(validatePagesHtml(original), []);
});

test('devops: validação recusa HTML que depende de rede, módulo ou segredo', () => {
  assert.deepEqual(validatePagesHtml(OK), []);
  const cases = [
    ['<script src="app.js"></script>', '<script src>'],
    ['<link rel="stylesheet" href="x.css">', '<link>'],
    ['<script type="module">1</script>', 'type="module"'],
    ['<script>fetch("/api")</script>', 'fetch'],
    ['<img src="https://cdn.exemplo.com/a.png">', 'externo'],
    ['<a href="file:///C:/x">x</a>', 'disco'],
    ['<script>const t="ghp_' + 'a'.repeat(36) + '"</script>', 'segredo'],
  ];
  for (const [snippet, expected] of cases) {
    const problems = validatePagesHtml(OK.replace('</body>', snippet + '</body>'));
    assert.ok(problems.some((p) => p.includes(expected)), `${snippet} → ${problems.join(' | ')}`);
  }
  assert.ok(validatePagesHtml(OK.replace('DEMONSTRAÇÃO', 'demo')).some((p) => p.includes('DEMONSTRAÇÃO')));
  assert.deepEqual(validatePagesHtml(''), ['HTML vazio']);
  assert.deepEqual(validatePagesHtml(null), ['HTML vazio']);
});

test('devops: build recusa pasta de saída fora do projeto ou a própria raiz', () => {
  assert.throws(() => buildPages('../fora-do-projeto'), /fora do projeto/);
  assert.throws(() => buildPages('.'), /fora do projeto/);
  assert.throws(() => buildPages(ROOT), /fora do projeto/);
});
