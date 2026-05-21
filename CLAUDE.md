# CLAUDE.md

Guia para o Claude Code ao trabalhar neste repositório.

## Visão geral

Servidor MCP em TypeScript (módulo ESM, transporte **Streamable HTTP**
em modo stateless) que expõe tools para consultar dados de portabilidade
via uma **API HTTP interna da provedora** (autenticada por `x-api-key`).
O servidor é uma camada fina de validação, formatação e autenticação
de usuários — toda a lógica de domínio mora na API upstream.

URL pública canônica: `https://mcp.portabilidade.vivavox.com.br`.

## Stack

- `@modelcontextprotocol/sdk` — `McpServer` + `StreamableHTTPServerTransport`
  + `createMcpExpressApp` (Express embutido no SDK)
- `fetch` nativo do Node — cliente da API de portabilidade
- `better-sqlite3` — persistência local (OAuth + audit)
- `jose` — assinatura/validação de JWTs
- `zod` — schemas de input das tools
- TypeScript estrito, alvo `ES2022`, `module: Node16`

## Infra de produção

- **URL canônica:** `https://mcp.portabilidade.vivavox.com.br`
- **URL legada** (em migração — derruba quando todos os clientes
  trocarem): `https://mcp.vivavox.com.br/portabilidade`
- **Reverse proxy:** Nginx Proxy Manager em Docker, IP público
  `191.252.178.174`. Termina TLS com Let's Encrypt.
- **Backend Node:** `138.94.55.156:3000` (rede interna). NPM faz
  `proxy_pass` direto — subdomínio mapeia pra raiz, sem reescrita
  de path.
- **Streamable HTTP no NPM:** a aba Advanced do Proxy Host precisa de
  `proxy_buffering off; proxy_read_timeout 24h; proxy_send_timeout 24h;`.
  O resto (`Connection`, `Upgrade`, `proxy_http_version`) o template
  do NPM já injeta — duplicar dá erro de validação.
- **Decisão arquitetural — um subdomínio por MCP, nunca subpath:**
  spec OAuth do MCP busca `/.well-known/oauth-*` na raiz do host.
  Subpath quebra discovery e mistura cookies entre MCPs. Convenção
  de nomes: `mcp.<servico>.vivavox.com.br` (ex: próximo MCP nasce
  como `mcp.outroservico.vivavox.com.br`).

## Arquitetura

- `src/index.ts` — bootstrap HTTP. Lê `PORT`, `HOST`, `MCP_ALLOWED_HOSTS`,
  cria o app Express via `createMcpExpressApp`, expõe `POST /mcp`,
  `GET /health` e `405` para `GET|DELETE /mcp`.
- `src/server.ts` — `createServer()` instancia o `McpServer` e registra
  cada tool. Chamado **uma vez por requisição** (modo stateless), então
  evite estado mutável no escopo do módulo.
- `src/portabilidade.ts` — cliente HTTP da API da provedora. Lê
  `PORTABILIDADE_API_URL` e `PORTABILIDADE_API_KEY` por chamada. Toda
  nova consulta à API deve virar uma função tipada aqui, não `fetch`
  solto na tool.
- `src/sqlite.ts` — `getDb()` lazy. Abre `SQLITE_PATH` (default
  `./data/app.db`), aplica pragmas (`journal_mode=WAL`,
  `foreign_keys=ON`) e roda todos os `sql/*.sql` em ordem alfabética
  (idempotente — schemas usam `IF NOT EXISTS`).
- `src/audit.ts` — `logToolCall()` grava cada chamada de tool em
  `audit_log` com identidade, duração e resultado. Falha de audit
  não derruba a chamada da tool (loga e segue).
- `src/auth/jwt.ts` — assinatura/verificação de access tokens HS256
  via `jose`. TTL exposto em `ACCESS_TTL_SECONDS`.
- `src/auth/middleware.ts` — `requireAuth`: tenta JWT primeiro, cai
  pro bearer estático. 401 inclui `WWW-Authenticate` com
  `resource_metadata` (necessário pro discovery do claude.ai).
- `src/oauth/routes.ts` — registra todos os endpoints OAuth.
  Coordena `store.ts` (clients/codes/refresh/tx), `pkce.ts` e
  `google.ts`. Só é montado se o flow OAuth estiver completo
  (`OAUTH_FLOW_READY` em `index.ts`).
- `src/oauth/store.ts` — DCR clients, authorization codes (single-use
  atômico), refresh tokens (rotação), authorize-tx (state Google
  ↔ params do cliente).
- `src/oauth/google.ts` — cliente do IdP: monta URL de authorize,
  troca code, valida `id_token` contra a JWKS do Google.
- `src/oauth/pkce.ts` — verificação S256 em tempo constante.

## Modo stateless e ciclo de vida

Cada `POST /mcp` faz: `createServer()` → novo `StreamableHTTPServerTransport`
com `sessionIdGenerator: undefined` → `server.connect(transport)` →
`transport.handleRequest`. No `res.on("close")` fechamos transport e server.
Não cacheie o `McpServer` no escopo do módulo: o ciclo é por requisição.
A conexão SQLite (`getDb()`) é singleton — better-sqlite3 já é seguro
pra uso concorrente leitor/escritor no mesmo processo (WAL).

## Segurança

Dois caminhos de auth coexistem em `/mcp` (POST/GET/DELETE) — pelo
menos um precisa estar configurado, o servidor não inicia sem
nenhum. `/health` e as rotas OAuth (`/.well-known/*`, `/register`,
`/authorize`, `/oauth/google/callback`, `/token`) são públicas.

**1. Bearer estático** (cobre Claude Desktop, CLI, API, scripts):

- Header `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- Comparação em tempo constante (`crypto.timingSafeEqual`).
- Identidade no audit: `auth_kind='service'`, `user_email='service:static'`.

**2. OAuth 2.1 + Google Workspace** (cobre claude.ai web/mobile):

- Discovery via `/.well-known/oauth-authorization-server` e
  `/.well-known/oauth-protected-resource` (RFC 8414 + 9728).
- Dynamic Client Registration (RFC 7591) público em `/register`.
- `/authorize` → redireciona pro Google com `hd=vivavox.com.br`.
- `/oauth/google/callback` → valida `id_token` (JWKS do Google) +
  claim `hd`.
- `/token` → `authorization_code` (PKCE S256 obrigatório) e
  `refresh_token` (rotação a cada uso).
- Access tokens são JWTs HS256 — **não persistidos no DB**. Refresh
  tokens são opacos e ficam em `oauth_refresh_tokens`.
- Audiência: time interno + parceiros/consultorias, todos com email
  `@vivavox.com.br`. Defesa em profundidade: consent screen em modo
  **Internal** (bloqueia logins fora do Workspace na origem) +
  validação do claim `hd` no callback.
- Identidade no audit: `auth_kind='user'`, `user_email=<email Google>`.

O `requireAuth` tenta JWT primeiro e cai pro bearer estático. Quando
todos os clientes migrarem, mata o `MCP_AUTH_TOKEN`.

Resposta 401 do `/mcp` inclui `WWW-Authenticate: Bearer realm=...,
resource_metadata="<issuer>/.well-known/oauth-protected-resource"` —
sem isso claude.ai não descobre o AS no primeiro contato.

**Continua dependendo da infra (NPM):** TLS, rate limiting,
restrição de IP. Documente quando alguma for adicionada na
camada de aplicação.

## Convenções

- Variáveis lidas no bootstrap (`src/index.ts`, fail-fast):
  `PORTABILIDADE_API_URL`, `PORTABILIDADE_API_KEY`, e pelo menos um
  caminho de auth (`MCP_AUTH_TOKEN` ou `OAUTH_JWT_SECRET +
  OAUTH_ISSUER`). Transporte: `PORT`, `HOST`, `MCP_ALLOWED_HOSTS`.
- Variáveis lidas sob demanda: a chave da API é relida em cada
  chamada de `consultarPortabilidade()`; envs do Google (`GOOGLE_*`,
  `ALLOWED_GOOGLE_HD`) são lidas dentro do código OAuth e lançam
  erro se ausentes na primeira chamada.
- Tools devem capturar erros e devolver `{ isError: true, content: [...] }`
  em vez de deixar a exceção propagar pro transporte.
- Validação de input via `zod` é obrigatória — o número é normalizado
  para apenas dígitos (regex `/^\d{10,13}$/`).
- O retorno padrão de uma tool é um único bloco `text` com JSON
  `JSON.stringify(obj, null, 2)`.
- Logs em `console.error` (vai pro stderr/journald). `console.log` está
  livre agora que não usamos stdio, mas mantenha tudo em stderr para
  consistência.
- Toda chamada de tool gera linha em `audit_log` com identidade do
  chamador (`user_email` quando JWT, `auth_kind='service'` e
  `user_email='service:static'` quando bearer estático).

## API de portabilidade (provedora)

- **Base URL:** `PORTABILIDADE_API_URL` (interno, ex:
  `http://138.94.55.156:50500`).
- **Auth:** header `x-api-key: $PORTABILIDADE_API_KEY` (chave estática
  fornecida pela provedora).
- **Endpoint:** `GET {URL}/portabilidade/{numero}` — sempre 200.
- **Resposta:**
  ```json
  {"numero":"553534733100","encontrado":true,"idoperadora":55282,"cio":1,"portado":true}
  ```
  Quando `encontrado: false`, os demais campos podem vir ausentes.
- **Migração:** o MySQL com SP `consultaTN` foi descontinuado pela
  provedora em mai/2026. A API substitui inclusive o lookup local
  de nome de operadora — `data/idoperadora.txt` foi removido junto
  com `src/operadoras.ts`.

## Persistência local (SQLite)

Toda escrita do MCP vai pra um SQLite local: clients OAuth registrados
via DCR, authorization codes, refresh tokens, audit log. Vive em
arquivo apontado por `SQLITE_PATH` (default `./data/app.db` dev,
`/data/app.db` em prod via volume Docker). Acesso via `src/sqlite.ts`
+ `better-sqlite3`.

## Migrations SQL

Schemas adicionais vivem em `sql/NNN_descricao.sql` (numeração
sequencial). Dialeto: **SQLite**. Aplicar manualmente:

```bash
sqlite3 $SQLITE_PATH < sql/001_oauth_schema.sql
```

Em prod (container), executar dentro do container ou via
`docker exec`. O arquivo precisa estar no volume persistente.

Schemas existentes:

- `sql/001_oauth_schema.sql` — `oauth_clients`, `oauth_codes`,
  `oauth_refresh_tokens`, `audit_log`
- `sql/002_oauth_authorize_tx.sql` — `oauth_authorize_tx` (estado
  efêmero do flow Google, single-use)

## Deploy

Em prod o servidor roda em container Docker. `Dockerfile` multi-stage
(`node:22-slim`), runtime como user não-root `mcp`, expõe `/data`
como volume pro SQLite, healthcheck no `/health`. Orquestração via
`Makefile` — `docker run` direto com `--env-file .env`, volume
nomeado `portabilidade_data:/data` e mapeamento `50002:3000`.

```bash
make build     # docker image build
make run       # docker container run (detached)
make stop      # docker stop + rm
make update    # git pull + build + stop + run
docker logs -f portabilidade-mcp
```

Backup do SQLite:

```bash
docker run --rm -v portabilidade_data:/data -v $PWD:/backup \
  alpine tar czf /backup/sqlite-bkp.tgz -C /data .
```

Alternativa: rodar como serviço systemd com `EnvironmentFile=.env` e
`ExecStart=/usr/bin/node dist/index.js`.

## Comandos úteis

```bash
npm run build      # tsc
npm run check      # tsc --noEmit
npm start          # node dist/index.js (envs vem do ambiente / .env)
npm run dev        # tsc --watch
npm run inspect    # MCP Inspector
```

Smoke test rápido (local):

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/.well-known/oauth-authorization-server
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## O que NÃO fazer

- Não commitar `.env` ou `data/` (ambos no `.gitignore`).
- Não adicionar uma tool `ping` ou similar — o protocolo MCP já tem
  health check no `initialize` handshake.
- Não cachear o `McpServer` em escopo de módulo: stateless = um server
  por request.
- Não voltar pro transporte stdio: este servidor foi planejado pra
  rodar como daemon HTTP (Docker/systemd).
- Não bindar em `0.0.0.0` sem ter pelo menos um caminho de auth
  configurado. O bootstrap já recusa subir sem `MCP_AUTH_TOKEN` nem
  `OAUTH_JWT_SECRET+OAUTH_ISSUER`, mas vale o lembrete.
- Não aceitar login com email fora de `@vivavox.com.br`. Restrição da
  liderança. Valida o claim `hd` no callback do Google **mesmo** com
  consent screen Internal (defesa em profundidade).
- Não voltar pra URL subpath (`mcp.vivavox.com.br/portabilidade`):
  spec OAuth do MCP exige well-known na raiz do host. Subdomínio por
  MCP é a forma certa.
- Não persistir access tokens (JWTs) no banco — são stateless e
  validados por assinatura. Só refresh tokens (opacos) vão pra
  `oauth_refresh_tokens`.
- Não publicar o OAuth consent screen como **External**: perde a
  restrição automática de domínio do Workspace e exige verificação
  do Google (semanas de espera).
