# Barber Prime — arquitetura e contrato de integração

## Estado e escopo desta entrega

Etapa **ARQUITETURA**, não entrega operacional. Existem um bootstrap Node HTTP, rota de saúde e testes do bootstrap/contrato. Não existem ainda telas, autenticação, persistência, reservas ou publicação. A arquitetura não satisfaz sozinha a homologação do produto; health=200 não significa agenda operacional.

O pedido específico desta execução manda criar documentação, contrato e esqueleto **sem implementar as frentes**. Por isso não foi criado HTML estático fingindo cumprir o produto nem uma demonstração local apresentada como backend real. O HTML autônomo será uma entrega adicional identificada como DEMONSTRAÇÃO, não um substituto da versão com servidor.

## Pesquisa e decisões

Consulte `PESQUISA.md` e `PESQUISA-COMPLEMENTAR.md` para URLs e avaliação de licenças. Não foi incorporado código externo.

- **Frontend alvo:** React, Next.js App Router e Tailwind CSS, instalados pela frente responsável na próxima fase. Next organiza a interface; a API de domínio permanece separada para evitar acoplamento com a demonstração offline.
- **Backend alvo:** Node.js 24, domínio separado do HTTP; bootstrap sem dependências externas. A frente backend pode adotar biblioteca de roteamento/validação com versões fixadas e lockfile, sem mudar URLs do contrato silenciosamente.
- **Banco alvo:** PostgreSQL, não SQLite para produção. `tstzrange` e exclusion constraint GiST por barbeiro sobre ocupação unificada de reservas/bloqueios. Conferir disponibilidade em JS não é proteção concorrente suficiente.
- **Produção:** reverse proxy HTTPS sob a mesma origem para `/api` e frontend, sem CORS aberto. O bootstrap escuta somente loopback por padrão. `HOST=0.0.0.0` somente em ambiente de implantação devidamente configurado.
- **Demonstração:** arquivo único `app-autonomo.html`, CSS/JS embutidos, sem fetch, CDN, módulos ou recursos externos; persistência localStorage, aviso DEMONSTRAÇÃO permanente. Nenhum segredo ou dado real sincronizado para essa versão.
- **Autenticação:** telefone com DDD é dado de cadastro, não senha. Sessão opaca por dispositivo; recuperar acesso exige prova de posse real. Número já registrado nunca dá acesso aos dados. Equipe usa credencial forte e papéis.
- **Integridade:** preço e duração vêm do servidor e são congelados na reserva; reagendamento e ocupação são transacionais; cancelamento libera a ocupação. Controle otimista por versão e idempotência de criação.

## Estrutura e propriedade

```text
package.json / package-lock.json  integração; scripts comuns
server/                          backend; bootstrap já existente
  app.mjs                        createApp(), saúde e 404
  index.mjs                      startServer(), configuração e encerramento
  auth/                          planejado
  booking/                       planejado
  catalog/                       planejado
web/ ou frontend/                frontend Next/React, planejado
public/                          assets e HTML operacional, planejado
app-autonomo.html                frontend, planejado
 db/                             dados; repositórios, planejado
migrations/                      dados; PostgreSQL, planejado
automation/ e jobs/               rpa; provedores/outbox, planejado
infra/ e tools/ e .github/        devops; CI e deploy, planejado
tests/arquitetura/                integração; testes existentes
tests/frontend/                  frontend
tests/backend/                   backend
tests/dados/                     dados
tests/rpa/                       rpa
tests/devops/                    devops
docs/                            integração; contrato e decisões
.homologacao/                     integração; fluxos para executor
```

As pastas planejadas não precisam existir vazias. A reserva normativa está em `contrato-api.json`, campo `reservas`: não há padrões sobrepostos. **Não usar scripts/**, pois no modelo anterior estava atribuído a duas frentes. RPA usa `automation/`; DevOps usa `tools/`. Arquivos compartilhados só são alterados pela integração; cada frente informa dependências e mudanças necessárias no contrato de retorno.

## Módulos e interfaces

O campo `sistema` do JSON descreve todos os módulos com dono, arquivos, interfaces providas/consumidas e requisitos. Cada módulo e rota carrega estado `implementado/implementada` ou `planejado/planejada`.

1. Frontend: catálogo, fluxo de reserva, área do cliente e calendário por profissional. Tema preto/grafite, dourado discreto, contraste acessível, foco visível, mobile first, movimento reduzido respeitado.
2. Backend/auth: cadastro, sessão, CSRF, provas de posse e autorização por recurso.
3. Backend/booking: disponibilidade e transições de reserva, sem acesso SQL no transporte HTTP.
4. Backend/catalog-admin: quatro barbeiros iniciais, serviços, estabelecimento, expediente e bloqueios.
5. Dados: migrações, índices, transações, constraints, ocupação unificada e outbox.
6. RPA: adaptador real de mensagens e processamento de outbox, com timeout/retries limitados e deduplicação. Falha de provedor nunca vira envio fictício aprovado.
7. DevOps: ambiente, build, CI, backup/restauração, segredos fora do Git, HTTPS e publicação.
8. Autônomo: versão offline segregada, claramente demonstrativa.

Rotas, corpos, respostas, erros, tipos e limites estão integralmente no JSON. Apenas **GET /api/health** está implementada. Qualquer outra rota retorna 404 nesta etapa.

## Modelo de dados e invariantes

Esquemas definidos: Shop, Staff, Customer, Service, WorkingHours, Block, Appointment, Session, Challenge e AuditEvent. Repositórios devem expor funções transacionais e nunca aceitar interpolação SQL. O banco guarda também ocupações e outbox, internas, sem exposição pela API.

Reservas e bloqueios disputam a mesma tabela de ocupação. Cada ocupação referencia exatamente uma reserva ou um bloqueio, com FK/UNIQUE/CHECK apropriados. A exclusão `staff_id =` e `period &&` abrange ambas; não criar duas tabelas com exclusões isoladas que deixem o conflito cruzado escapar. Intervalo é finito, não vazio, semiaberto `[inicio,fim)`, permitindo atendimentos adjacentes.

Conversão local usa fuso IANA do estabelecimento; persistência em UTC com offset explícito. O servidor valida expediente, exceções, serviço, profissional ativo, horizonte de reserva e duração. Não confiar em preço, fim ou identidade de cliente enviados pela tela. Não permitir que mudanças de expediente/desativação invalidem reservas futuras silenciosamente.

## Segurança e privacidade

- Cadastro obrigatório somente nome e telefone; normalizar antes da unicidade. Nome não é credencial.
- Cookie de sessão opaco, HttpOnly/Secure/SameSite e CSRF/Origin em mutações. Sessão guardada por hash e revogável; não expor token em URL ou localStorage no produto real.
- Um cadastro existente responde de forma genérica e não promove a sessão anônima. O frontend consulta `/api/me` para saber se dispõe de sessão; recuperação depende de provedor real, sem login por telefone.
- Customer vê apenas as próprias reservas; barber vê a própria agenda; admin altera configuração. Recurso alheio retorna 404, mesmo com UUID válido.
- Agenda pública nunca devolve nomes/telefones das reservas. Campos privados são projetados por papel, não serialização bruta da tabela.
- Corpo limitado, JSON e parâmetros validados, campos desconhecidos recusados, erros internos sanitizados, logs sem PII/segredos e limites de abuso persistentes.
- Nenhuma senha, sessão, chave ou código fixo de teste entra no repositório. Admin inicial será criado por comando controlado, não rota pública.

## Como executar o esqueleto agora

Requisito: Node.js 24 ou superior. Sem pacotes externos nesta etapa.

```sh
npm start
npm test
npm run check
```

`npm start` mantém o processo; responde a `GET /api/health` na porta 3000, host 127.0.0.1. A resposta inclui `stage: architecture` e `operational: false`. `PORT` aceita inteiro 0..65535 (0 útil para atribuição pelo sistema); valor inválido falha antes de escutar. `HOST` deve ser endereço válido para `server.listen`.

Se Node/npm não estiverem no PATH do Windows, os executáveis fornecidos pelo ambiente são `D:\IA\app\engine\node-win32-x64\node.exe` e `D:\IA\app\engine\node-win32-x64\npm.cmd`. Execute sempre dentro do projeto, nunca dentro da instalação do IA.

O script `npm test` usa **node --test sem argumento de diretório**, que descobre recursivamente `*.test.mjs`, `*.test.js` e `*.test.cjs`. A tentativa anterior `node --test tests/` falhou neste ambiente; não foi mantida. Cada frente grava `tests/<dono>/*.test.mjs` e não precisa editar package.json. O teste atual não valida o produto final nem PostgreSQL.

O lockfile sem dependências registra o bootstrap. Quando adicionar pacotes, atualizar package.json e lockfile juntos pela integração, fixar versões e rodar auditoria. Não há build/lint de frontend nesta etapa; `check` é apenas sintaxe JavaScript, não substitui lint, tipos ou build futuros.

## Plano de integração e aceite

1. Dados implementa migrações/repositórios PostgreSQL e testes reais de constraints e rollback.
2. Backend implementa auth, catálogo e booking consumindo o contrato de dados.
3. Frontend implementa fluxos HTTP reais e separadamente o autônomo offline. RPA implementa provedores sem simulação no produto.
4. DevOps configura execução conjunta, build, CI, banco, HTTPS e implantação autorizada. Não publicar dados ou usar contas sem acesso fornecido.
5. Integração testa autorização cruzada, validação, persistência após reinício, concorrência (mesmo barbeiro e bloqueio cruzado), idempotência e falha de reagendamento.
6. QA independente valida no navegador a 375px, desktop, acessibilidade e offline sem rede, depois repete sobre os artefatos finais. Executor do Studio é quem registra homologação; texto de entrega não a concede.

## Rastreabilidade e impedimentos reais

Há duas numerações R incompatíveis no pedido: a matriz de homologação inicial e o modelo compartilhado R1..R20. O campo `sistema` utiliza **R1..R20 do modelo compartilhado**, conforme solicitado. A matriz de aceite extensa contém 249 itens omitidos; não é possível inventar sua redação nem mapear cada requisito ausente honestamente.

`.homologacao/fluxos.json` registra somente provas executáveis do esqueleto e pendências, com escopo menor e `prontoParaHomologacao: false`. Não declara `htmlAutonomo` como se o arquivo existisse. Na integração é obrigatório completar os fluxos a partir da matriz integral, adicionar o arquivo real e então declarar escopo operacional. Não remover critérios nem usar testes documentais como substitutos de fluxos de negócio.

Pendências: frontend, backend funcional, PostgreSQL, provedor de posse, HTML operacional/autônomo, URL pública e homologação final. Não há conta/credencial de hospedagem ou provedor configurada. Esta execução não realizou deploy nem afirmou qualquer validação no provedor.
