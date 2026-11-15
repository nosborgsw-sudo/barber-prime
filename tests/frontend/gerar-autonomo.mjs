// Gera app-autonomo.html (raiz do projeto) a partir de public/: um único arquivo com CSS e JS embutidos,
// adaptador de DEMONSTRAÇÃO (localStorage) no lugar da API e CSP que bloqueia qualquer acesso à rede.
// Uso: node tests/frontend/gerar-autonomo.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(ROOT + rel, 'utf8');

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
  + "connect-src 'none'; form-action 'none'; base-uri 'none'";

const BANNER = [
  '<div class="demo-banner" role="note">',
  '    <strong>DEMONSTRAÇÃO</strong> — funciona sem internet; os dados ficam só neste navegador e não chegam à barbearia.',
  '    <button type="button" class="btn btn-ghost btn-sm" id="demo-reset">Apagar dados da demonstração</button>',
  '  </div>',
].join('\n');

// Impede que o conteúdo encerre a tag <script>/<style> antes da hora.
const safe = (code, tag) => code.replace(new RegExp('</' + tag, 'gi'), '<\\/' + tag);

function replaceOnce(html, search, replacement) {
  const i = html.indexOf(search);
  if (i < 0 || html.indexOf(search, i + 1) >= 0) throw new Error('marcador ausente ou repetido: ' + search);
  return html.slice(0, i) + replacement + html.slice(i + search.length);
}

export function buildAutonomo() {
  let html = read('public/index.html');
  html = replaceOnce(html, '<link rel="stylesheet" href="styles.css">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n  <style>\n${safe(read('public/styles.css'), 'style')}\n  </style>`);
  html = replaceOnce(html, '<title>Barber Prime — Agendamento</title>', '<title>DEMONSTRAÇÃO — Barber Prime — Agendamento</title>');
  html = replaceOnce(html, '<body data-mode="api">', '<body data-mode="demo">');
  html = replaceOnce(html, '<!-- BP:DEMO-BANNER -->', BANNER);
  const begin = html.indexOf('<!-- BP:SCRIPTS:BEGIN -->');
  const endMark = '<!-- BP:SCRIPTS:END -->';
  const end = html.indexOf(endMark);
  if (begin < 0 || end < begin) throw new Error('marcadores BP:SCRIPTS ausentes');
  const scripts = ['public/core.js', 'public/demo.js', 'public/app.js']
    .map((f) => `<script>\n${safe(read(f), 'script')}\n</script>`).join('\n');
  html = html.slice(0, begin) + scripts + html.slice(end + endMark.length);
  return html;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = ROOT + 'app-autonomo.html';
  writeFileSync(out, buildAutonomo());
  console.log('gerado: ' + out);
}
