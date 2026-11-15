// Carrega os scripts clássicos de public/ num contexto isolado do Node (sem DOM), como o navegador faria.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const read = (rel) => readFileSync(ROOT + rel, 'utf8');

export function loadScripts(files, extra) {
  const ctx = vm.createContext(Object.assign({
    console, setTimeout, clearTimeout, Intl, URLSearchParams, crypto: globalThis.crypto, Date, Math, JSON, Promise,
  }, extra));
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}

export function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}

// Objetos criados dentro do contexto vm têm outro protótipo; normaliza para comparar com deepStrictEqual.
export const plain = (v) => JSON.parse(JSON.stringify(v));
