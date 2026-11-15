import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./publicar-github-pages.ps1', import.meta.url));
const src = readFileSync(SCRIPT, 'utf8');
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });

test('devops: script de publicação tem sintaxe PowerShell válida', { skip: pwsh.status !== 0 && 'pwsh ausente' }, () => {
  const cmd = '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:ALVO,[ref]$t,[ref]$e);'
    + '$e|%{$_.Message};exit $e.Count';
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', env: { ...process.env, ALVO: SCRIPT } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('devops: script de publicação só age em público depois de -Confirmar e liga o Pages antes do push', () => {
  const gate = src.indexOf('if (-not $Confirmar)');
  assert.ok(gate > 0, 'sem trava -Confirmar');
  for (const acao of ['gh repo create', 'git push', '-X POST', '-X PUT', 'gh workflow run']) {
    const pos = src.indexOf(acao);
    assert.ok(pos > gate, `${acao} aparece antes da trava -Confirmar`);
  }
  assert.ok(src.indexOf('$pagesAntes = Ligar-Pages') < src.indexOf('git push'), 'Pages deve ser ligado antes do push');
  assert.ok(src.indexOf('npm run ci') < gate, 'testes e build devem rodar antes de publicar');
  assert.match(src, /gh repo view --json nameWithOwner/, 'alvo deve vir do remote origin');
  assert.match(src, /Invoke-WebRequest/, 'URL pública deve ser conferida depois do deploy');
  assert.doesNotMatch(src, /\bgh[opsu]_[A-Za-z0-9]{20,}|--force\b|-f\s+main\b/, 'sem token escrito nem push forçado');
});
