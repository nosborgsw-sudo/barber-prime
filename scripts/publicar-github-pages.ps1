# Publica o Barber Prime no GitHub e liga o GitHub Pages (versão HTML pública da demonstração).
# É uma ação PÚBLICA: só rode com -Confirmar depois de revisar o que vai para o repositório.
# Uso: pwsh scripts/publicar-github-pages.ps1 -Repositorio barber-prime -Confirmar
# Reversão: ver .github/DEPLOY.md.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._-]{1,100}$')][string]$Repositorio,
  [ValidateSet('public', 'private')][string]$Visibilidade = 'public',
  [switch]$Confirmar,
  # Minutos para esperar o deploy e conferir a URL pública (0 = não espera).
  [ValidateRange(0, 60)][int]$AguardarMinutos = 15
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Exigir($ok, $msg) { if (-not $ok) { Write-Error $msg } }

Exigir (Get-Command gh -ErrorAction SilentlyContinue) 'gh (GitHub CLI) não encontrado.'
gh auth status *> $null
Exigir ($LASTEXITCODE -eq 0) 'gh não autenticado: rode "gh auth login".'
Exigir ([string]::IsNullOrWhiteSpace((git status --porcelain) -join '')) 'Há alterações não commitadas: revise e faça o commit antes de publicar.'
Exigir (-not (git ls-files | Select-String -Pattern '(^|/)\.env($|\.)' -Quiet)) 'Arquivo .env versionado: remova antes de publicar.'

# Mesmas verificações do pipeline, falhando cedo.
npm ci; Exigir ($LASTEXITCODE -eq 0) 'npm ci falhou.'
npm run ci; Exigir ($LASTEXITCODE -eq 0) 'check/testes/build falharam: nada foi publicado.'

if (Get-Command gitleaks -ErrorAction SilentlyContinue) {
  gitleaks git --no-banner --redact .; Exigir ($LASTEXITCODE -eq 0) 'gitleaks encontrou possível segredo no histórico.'
}

if ($Visibilidade -eq 'private') {
  Write-Warning 'GitHub Pages em repositório privado exige plano pago, e o site continua público.'
}

if (-not $Confirmar) {
  Write-Host "Verificações OK. Nada foi publicado. Para publicar rode de novo com -Confirmar."
  exit 0
}

# Cria o repositório sem push: o Pages precisa estar ligado antes do primeiro run do pages.yml,
# senão o job deploy falha por falta do ambiente github-pages.
if (-not (git remote | Select-String -Pattern '^origin$' -Quiet)) {
  $dono = gh api user --jq .login
  gh repo create "$dono/$Repositorio" "--$Visibilidade" --source . --remote origin
  Exigir ($LASTEXITCODE -eq 0) 'Falha ao criar o repositório.'
}
# O alvo é sempre o repositório do origin (pode ser diferente de -Repositorio se o remote já existia).
$alvo = gh repo view --json nameWithOwner --jq .nameWithOwner
Exigir ($LASTEXITCODE -eq 0 -and $alvo) 'Não foi possível identificar o repositório do remote origin.'

function Ligar-Pages {
  gh api "repos/$alvo/pages" *> $null
  if ($LASTEXITCODE -eq 0) {
    gh api "repos/$alvo/pages" -X PUT -f build_type=workflow *> $null
  } else {
    gh api "repos/$alvo/pages" -X POST -f build_type=workflow *> $null
  }
  return ($LASTEXITCODE -eq 0)
}
$pagesAntes = Ligar-Pages

git push -u origin HEAD:main
Exigir ($LASTEXITCODE -eq 0) 'Falha no push.'

if (-not $pagesAntes) {
  # Repositório vazio pode recusar o Pages antes do push: liga agora e dispara o deploy de novo.
  Exigir (Ligar-Pages) "Não foi possível ligar o GitHub Pages em $alvo (Settings > Pages > Source: GitHub Actions)."
  gh workflow run pages.yml --repo $alvo --ref main
  Exigir ($LASTEXITCODE -eq 0) 'Falha ao disparar o workflow pages.yml.'
}

$url = gh api "repos/$alvo/pages" --jq .html_url
if (-not $url) { $url = "https://$($alvo.Split('/')[0].ToLower()).github.io/$($alvo.Split('/')[1])/" }
Write-Host "Repositório: https://github.com/$alvo"
Write-Host "URL pública: $url"

if ($AguardarMinutos -eq 0) {
  Write-Host "Deploy iniciado sem espera. Acompanhe: gh run watch --repo $alvo"
  exit 0
}

# Espera o run do pages.yml deste commit e confere que a URL responde com a demonstração.
$commit = git rev-parse HEAD
$limite = (Get-Date).AddMinutes($AguardarMinutos)
$run = $null
while (-not $run -and (Get-Date) -lt $limite) {
  $run = gh run list --repo $alvo --workflow pages.yml --commit $commit --limit 1 --json databaseId --jq '.[0].databaseId'
  if (-not $run) { Start-Sleep -Seconds 3 }
}
Exigir ($run) "Nenhum run do pages.yml para o commit $commit."
gh run watch $run --repo $alvo --exit-status
Exigir ($LASTEXITCODE -eq 0) "O deploy falhou: gh run view $run --repo $alvo --log-failed"

$limite = (Get-Date).AddMinutes($AguardarMinutos)
$ok = $false
while (-not $ok -and (Get-Date) -lt $limite) {
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
    $ok = ($resp.StatusCode -eq 200 -and $resp.Content -match 'DEMONSTRA')
  } catch { $ok = $false }
  if (-not $ok) { Start-Sleep -Seconds 5 }
}
Exigir $ok "A URL $url ainda não responde com a demonstração (a propagação do Pages pode levar alguns minutos)."
Write-Host "PUBLICADO E CONFERIDO: $url respondeu 200 com a DEMONSTRAÇÃO."
