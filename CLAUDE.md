# CLAUDE.md

Guia para o Claude Code ao trabalhar neste repositório.

## Visão geral

Servidor MCP em TypeScript (módulo ESM, transporte **Streamable HTTP**
em modo stateless) que expõe tools para consultar dados de portabilidade
armazenados em um MySQL interno da Vivavox. A lógica de domínio fica
concentrada em stored procedures do banco — o servidor é uma camada
fina de validação e formatação.

URL pública canônica: `https://portabilidade.mcp.vivavox.com.br`.

## Stack

- `@modelcontextprotocol/sdk` — `McpServer` + `StreamableHTTPServerTransport`
  + `createMcpExpressApp` (Express embutido no SDK)
- `mysql2/promise` — pool de conexões
- `zod` — schemas de input das tools
- TypeScript estrito, alvo `ES2022`, `module: Node16`

## Infra de produção

- **URL canônica:** `https://portabilidade.mcp.vivavox.com.br`
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
  Subpath quebra discovery e mistura cookies entre MCPs. Próximos
  MCPs nascem como `outro.mcp.vivavox.com.br`.

## Arquitetura

- `src/index.ts` — bootstrap HTTP. Lê `PORT`, `HOST`, `MCP_ALLOWED_HOSTS`,
  cria o app Express via `createMcpExpressApp`, expõe `POST /mcp`,
  `GET /health` e `405` para `GET|DELETE /mcp`.
- `src/server.ts` — `createServer()` instancia o `McpServer` e registra
  cada tool. Chamado **uma vez por requisição** (modo stateless), então
  evite estado mutável no escopo do módulo.
- `src/db.ts` — `getPool()` lazy (lê env vars na primeira chamada) e
  wrappers tipados para cada stored procedure. Toda nova consulta a SP
  deve virar uma função aqui, não código solto na tool.
- `src/sqlite.ts` — `getDb()` lazy. Abre `SQLITE_PATH` (default
  `./data/app.db`), aplica pragmas (`journal_mode=WAL`,
  `foreign_keys=ON`) e roda todos os `sql/*.sql` em ordem alfabética
  (idempotente — schemas usam `IF NOT EXISTS`).
- `src/operadoras.ts` — carrega `data/idoperadora.txt` em cache e
  resolve `idoperadora -> nome`.

## Modo stateless e ciclo de vida

Cada `POST /mcp` faz: `createServer()` → novo `StreamableHTTPServerTransport`
com `sessionIdGenerator: undefined` → `server.connect(transport)` →
`transport.handleRequest`. No `res.on("close")` fechamos transport e server.
Não cacheie o `McpServer` no escopo do módulo: o ciclo é por requisição.
O **pool MySQL** (`getPool()`) é o único singleton, e isso é proposital
— reaproveitar conexões entre requisições é fundamental.

## Segurança

**Estado atual (em produção):**

- **Bearer token estático obrigatório** via header
  `Authorization: Bearer <MCP_AUTH_TOKEN>`. O servidor não inicia se a
  env não estiver definida (`process.exit(1)` no bootstrap).
- Comparação em tempo constante (`crypto.timingSafeEqual`).
- Auth aplicada nas rotas `/mcp` (POST/GET/DELETE). `/health` é público.

**OAuth 2.1 Google Workspace (em construção):**

Motivação: clientes via claude.ai (web/mobile) só aceitam Custom
Connectors com OAuth — bearer estático cobre Claude Desktop, CLI e
API, mas não claude.ai.

- Audiência: time interno + parceiros/consultorias, todos com email
  `@vivavox.com.br` (parceiros recebem guest account no Workspace).
- IdP: Google OAuth com parâmetro `hd=vivavox.com.br`. OAuth consent
  screen em modo **Internal** bloqueia logins fora do Workspace na
  origem (defesa em profundidade — código também valida o claim `hd`).
- Servidor implementa o shim OAuth do MCP spec (discovery + DCR +
  authorize + token) e delega autenticação pro Google.
- Access tokens são JWTs HS256 assinados pelo servidor —
  **não persistidos no DB**. Refresh tokens são opacos e ficam em
  `oauth_refresh_tokens`.
- Os dois caminhos coexistem no `requireAuth`: JWT primeiro, fallback
  pro bearer estático. Quando os clientes migrarem, mata o
  `MCP_AUTH_TOKEN`.

**Continua dependendo da infra (NPM):** TLS, rate limiting,
restrição de IP. Documente quando alguma for adicionada na
camada de aplicação.

## Convenções

- Variáveis de ambiente do MySQL são lidas só dentro de `getPool()`.
  Variáveis de transporte (`PORT`, `HOST`, `MCP_ALLOWED_HOSTS`,
  `MCP_AUTH_TOKEN`) são lidas no bootstrap em `src/index.ts`.
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

## Stored procedures conhecidas

- `consultaTN(numero VARCHAR)` → 1 linha com `idoperadora`, `CIO`,
  `IsPortado`. `IsPortado` chega como `0|1` e é convertido para boolean
  na tool.

## Persistência: dois bancos

O servidor fala com **dois bancos** com responsabilidades distintas:

- **MySQL da provedora** (read-only do nosso lado) — só pra chamar
  stored procedures como `consultaTN`. Não criamos schema/tabelas
  lá. Acesso via `src/db.ts` + pool `mysql2`.
- **SQLite local** — toda escrita do MCP: clients OAuth registrados
  via DCR, authorization codes, refresh tokens, audit log. Vive em
  arquivo apontado por `SQLITE_PATH` (default `./data/app.db` dev,
  `/data/app.db` em prod via volume Docker). Acesso via `src/sqlite.ts`
  + `better-sqlite3`.

Restrição: o MySQL pertence à provedora e não temos permissão pra
criar tabelas lá. Por isso o SQLite local — solução prática que evita
provisionar mais infra.

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

## Comandos úteis

```bash
npm run build      # tsc
npm run check      # tsc --noEmit
npm start          # node --env-file=.env dist/index.js
npm run dev        # tsc --watch
npm run inspect    # MCP Inspector
```

Smoke test rápido:

```bash
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## O que NÃO fazer

- Não commitar `.env` (já está no `.gitignore`).
- Não adicionar uma tool `ping` ou similar — o protocolo MCP já tem
  health check no `initialize` handshake.
- Não trocar `--env-file` por dotenv sem motivo: a flag nativa do Node
  20.6+ evita uma dependência.
- Não cachear o `McpServer` em escopo de módulo: stateless = um server
  por request.
- Não voltar pro transporte stdio: este servidor foi planejado pra
  rodar como daemon HTTP (systemd, Docker, etc.).
- Não bindar em `0.0.0.0` sem firewall/IP allowlist na frente — não
  há autenticação na camada da aplicação.
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
