# CLAUDE.md

Guia para o Claude Code ao trabalhar neste repositório.

## Visão geral

Servidor MCP base em TypeScript (módulo ESM, transporte **Streamable HTTP**
em modo stateless). É um scaffold: expõe uma tool `ping` de exemplo e
concentra o valor na infra reaproveitável — validação de input,
autenticação de usuários (bearer estático + OAuth) e auditoria. Novas
capacidades entram como tools tipadas em `src/server.ts`.

URL pública canônica: `https://mcp.base.vivavox.com.br`.

## Stack

- `@modelcontextprotocol/sdk` — `McpServer` + `StreamableHTTPServerTransport`
  + `createMcpExpressApp` (Express embutido no SDK)
- `better-sqlite3` — persistência local (OAuth + audit)
- `jose` — assinatura/validação de JWTs
- `zod` — schemas de input das tools
- TypeScript estrito, alvo `ES2022`, `module: Node16`

## Infra de produção

- **URL canônica:** `https://mcp.base.vivavox.com.br`
- **Reverse proxy:** Nginx Proxy Manager em Docker, IP público
  `191.252.178.174` (compartilhado pelos MCPs `*.vivavox.com.br`).
  Termina TLS com Let's Encrypt.
- **Backend Node:** host:porta internos do container `base-mcp`
  (Makefile mapeia `50007:3000`). NPM faz `proxy_pass` direto —
  subdomínio mapeia pra raiz, sem reescrita de path.
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

- Variáveis lidas no bootstrap (`src/index.ts`, fail-fast): pelo menos
  um caminho de auth (`MCP_AUTH_TOKEN` ou `OAUTH_JWT_SECRET +
  OAUTH_ISSUER`). Transporte: `PORT`, `HOST`, `MCP_ALLOWED_HOSTS`.
- Variáveis lidas sob demanda: envs do Google (`GOOGLE_*`,
  `ALLOWED_GOOGLE_HD`) são lidas dentro do código OAuth e lançam erro
  se ausentes na primeira chamada.
- Tools devem capturar erros e devolver `{ isError: true, content: [...] }`
  em vez de deixar a exceção propagar pro transporte.
- Validação de input via `zod` é obrigatória para toda tool.
- O retorno padrão de uma tool é um único bloco `text` com JSON
  `JSON.stringify(obj, null, 2)`.
- Logs em `console.error` (vai pro stderr/journald). `console.log` está
  livre agora que não usamos stdio, mas mantenha tudo em stderr para
  consistência.
- Toda chamada de tool gera linha em `audit_log` com identidade do
  chamador (`user_email` quando JWT, `auth_kind='service'` e
  `user_email='service:static'` quando bearer estático).

## Tools

- Hoje só `ping` — health check de exemplo que responde `pong` e ecoa
  uma `message` opcional. Serve de template para novas tools.
- Nova capacidade = uma tool em `src/server.ts` (schema `zod`,
  captura de erro devolvendo `{ isError: true }`, chamada a
  `logToolCall`). Integrações externas com estado/cliente próprio
  ganham um módulo tipado dedicado em `src/` (ex: `src/<servico>.ts`),
  em vez de chamar o SDK solto dentro da tool.

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
nomeado `base_data:/data` e mapeamento `50007:3000`.

```bash
make build     # docker image build
make run       # docker container run (detached)
make stop      # docker stop + rm
make update    # git pull + build + stop + run
docker logs -f base-mcp
```

Backup do SQLite:

```bash
docker run --rm -v base_data:/data -v $PWD:/backup \
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
- Não voltar pra URL subpath (`mcp.vivavox.com.br/base`):
  spec OAuth do MCP exige well-known na raiz do host. Subdomínio por
  MCP é a forma certa.
- Não gravar payloads sensíveis / PII de tools no `audit_log` — logue
  só o metadado necessário pra rastrear a chamada. Evita PII no banco
  local.
- Não persistir access tokens (JWTs) no banco — são stateless e
  validados por assinatura. Só refresh tokens (opacos) vão pra
  `oauth_refresh_tokens`.
- Não publicar o OAuth consent screen como **External**: perde a
  restrição automática de domínio do Workspace e exige verificação
  do Google (semanas de espera).
