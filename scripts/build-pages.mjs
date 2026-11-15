// Gera a versão HTML pública (site estático) em dist/pages/ a partir de app-autonomo.html.
// O site é a DEMONSTRAÇÃO autônoma: um arquivo único, sem rede, dados no localStorage do visitante.
// Uso: node scripts/build-pages.mjs [pasta-de-saida]   (padrão: dist/pages)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = join(ROOT, 'app-autonomo.html');

// Cada regra devolve a lista de problemas encontrados no HTML.
const RULES = [
  [/<script\b[^>]*\bsrc\s*=/i, 'usa <script src> (precisa ser arquivo único)'],
  [/<link\b[^>]*\brel\s*=\s*["']?(stylesheet|preload|modulepreload|import)/i, 'carrega recurso externo por <link>'],
  [/<script\b[^>]*type\s*=\s*["']?module/i, 'usa type="module" (não abre por duplo clique)'],
  [/\bfetch\s*\(/, 'usa fetch (a demonstração não acessa a rede)'],
  [/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, 'referencia endereço externo (CDN)'],
  [/\b(?:src|href)\s*=\s*["']?(?:[a-z]:\\|file:)/i, 'referencia caminho do disco'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[opsu]_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b|\bsk_live_[A-Za-z0-9]{10,}/, 'contém algo com formato de segredo'],
];

export function validatePagesHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return ['HTML vazio'];
  const problems = RULES.filter(([re]) => re.test(html)).map(([, msg]) => msg);
  if (!/<!doctype html>/i.test(html)) problems.push('sem <!doctype html>');
  if (!html.includes('DEMONSTRAÇÃO')) problems.push('não mostra que é DEMONSTRAÇÃO');
  if (!/<meta\s+name=["']viewport["']/i.test(html)) problems.push('sem meta viewport (celular)');
  return problems;
}

export function buildPages(outDir = join(ROOT, 'dist', 'pages')) {
  const target = resolve(ROOT, outDir);
  // Só apaga/grava dentro da pasta do projeto, e nunca a própria raiz.
  const rel = relative(ROOT, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`pasta de saída fora do projeto: ${target}`);
  }
  const html = readFileSync(SOURCE, 'utf8');
  const problems = validatePagesHtml(html);
  if (problems.length) throw new Error('app-autonomo.html reprovado: ' + problems.join('; '));

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  // Saída de build fora do Git: o .gitignore fica na raiz de dist/ (ou na própria pasta, se for outra).
  const ignoreDir = rel.split(/[\\/]/)[0] === 'dist' ? join(ROOT, 'dist') : target;
  writeFileSync(join(ignoreDir, '.gitignore'), '*\n');
  writeFileSync(join(target, 'index.html'), html);
  writeFileSync(join(target, 'app-autonomo.html'), html);
  writeFileSync(join(target, '404.html'), html);
  writeFileSync(join(target, '.nojekyll'), '');
  return { outDir: target, files: ['index.html', 'app-autonomo.html', '404.html', '.nojekyll'], bytes: Buffer.byteLength(html) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { outDir, files, bytes } = buildPages(process.argv[2]);
    console.log(`build-pages: ${files.length} arquivos em ${outDir} (index.html ${bytes} bytes)`);
  } catch (error) {
    console.error(`build-pages: ${error.message}`);
    process.exitCode = 1;
  }
}
