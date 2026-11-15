// Verificações estáticas do HTML operacional, do app-autonomo.html e das regras de segurança da interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ROOT, read } from './apoio.mjs';
import { buildAutonomo } from './gerar-autonomo.mjs';

const index = read('public/index.html');
const app = read('public/app.js');
const ids = new Set([...index.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('index.html: recursos locais referenciados existem e usam caminho relativo', () => {
  const refs = [...index.matchAll(/\b(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4);
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^(https?:|\/\/|\/|[a-z]:\\|file:)/i, 'caminho relativo: ' + ref);
    assert.ok(existsSync(ROOT + 'public/' + ref), 'arquivo existe: ' + ref);
  }
  assert.match(index, /<html lang="pt-BR">/);
  assert.match(index, /name="viewport"/);
  assert.equal(ids.size, [...index.matchAll(/\bid="/g)].length, 'ids únicos');
});

test('index.html: links internos, rótulos e controles de abas apontam para elementos existentes', () => {
  for (const [, target] of index.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target) || ['inicio', 'agendar', 'reservas', 'equipe'].includes(target), '#' + target);
  for (const [, target] of index.matchAll(/\bfor="([^"]+)"/g)) assert.ok(ids.has(target), 'label for=' + target);
  for (const [, list] of index.matchAll(/aria-(?:controls|describedby|labelledby)="([^"]+)"/g)) {
    for (const target of list.split(/\s+/)) assert.ok(ids.has(target), 'aria → ' + target);
  }
});

test('app.js: todo id usado existe no HTML e não há HTML dinâmico, fetch nem eval', () => {
  const used = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  for (const id of used) {
    if (id === 'demo-reset') continue; // só existe no HTML autônomo (verificado abaixo)
    assert.ok(ids.has(id), 'id ausente no index.html: ' + id);
  }
  for (const id of ['view-', 'titulo-']) {
    for (const v of ['inicio', 'agendar', 'reservas', 'equipe']) assert.ok(ids.has(id + v), id + v);
  }
  for (const p of ['agenda', 'servicos', 'barbeiros', 'expediente', 'bloqueios', 'barbearia']) {
    assert.ok(ids.has('ptab-' + p) && ids.has('painel-' + p), 'painel ' + p);
  }
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\bfetch\(/);
  assert.doesNotMatch(read('public/index.html'), /<script>(?!\s*<\/script>)|\son[a-z]+="/i, 'sem script inline nem handlers inline');
});

test('app-autonomo.html: arquivo único, sem rede, marcado como DEMONSTRAÇÃO e igual ao gerado a partir de public/', () => {
  const file = ROOT + 'app-autonomo.html';
  assert.ok(existsSync(file), 'app-autonomo.html existe na raiz');
  const html = read('app-autonomo.html');
  assert.equal(html, buildAutonomo(), 'app-autonomo.html desatualizado: rode node tests/frontend/gerar-autonomo.mjs');
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|type="module"|\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|@import|url\((?!#)/i);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, 'nenhum endereço externo');
  assert.match(html, /<body data-mode="demo">/);
  assert.match(html, /<strong>DEMONSTRAÇÃO<\/strong>/);
  assert.match(html, /<title>DEMONSTRAÇÃO/);
  assert.match(html, /id="demo-reset"/);
  assert.match(html, /connect-src 'none'/);
  for (const g of ['BPCore', 'BPDemo', 'BPApi']) {
    assert.equal(html.includes('root.' + g + ' ='), g !== 'BPApi', g + (g === 'BPApi' ? ' fora' : ' embutido'));
  }
  assert.doesNotMatch(html.slice(html.indexOf('<script>')), /<\/script>[\s\S]*<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/, 'exatamente três blocos de script');
});

test('estilo: tema escuro grafite com dourado discreto, tipografia elegante, ícones, cartões arredondados e animações suaves', () => {
  const css = read('public/styles.css');
  const luminance = (hex) => {
    const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const varOf = (name) => css.match(new RegExp('--' + name + ':[ ]*(#[0-9a-f]{6})', 'i'))[1];
  for (const v of ['bg', 'graphite', 'surface']) assert.ok(luminance(varOf(v)) < 0.02, v + ' escuro');
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  assert.ok(contrast(varOf('text'), varOf('bg')) >= 7, 'texto com contraste AAA sobre o fundo');
  assert.ok(contrast(varOf('muted'), varOf('surface')) >= 4.5, 'texto secundário com contraste AA');
  assert.ok(contrast(varOf('gold'), varOf('bg')) >= 4.5, 'dourado legível sobre o fundo');
  assert.match(css, /--font-display:[^;]*serif/);
  assert.match(css, /border-radius:\s*var\(--radius\)/);
  assert.match(css, /transition:/);
  assert.match(css, /@keyframes/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(min-width: 560px\)/, 'mobile first: estilos base para celular e ampliação por min-width');
  assert.match(index, /<symbol id="i-logo"/);
  assert.ok((index.match(/<symbol id="i-/g) || []).length >= 10, 'conjunto de ícones SVG minimalistas');
});
