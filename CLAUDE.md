# CLAUDE.md

Guia para o Claude Code ao trabalhar neste repositório.

## Visão geral

Servidor MCP em TypeScript (módulo ESM, transporte **Streamable HTTP**
em modo stateless) que expõe tools para consultar dados de portabilidade
armazenados em um MySQL interno da Vivavox. A lógica de domínio fica
concentrada em stored procedures do banco — o servidor é uma camada
fina de validação e formatação.

## Stack

- `@modelcontextprotocol/sdk` — `McpServer` + `StreamableHTTPServerTransport`
  + `createMcpExpressApp` (Express embutido no SDK)
- `mysql2/promise` — pool de conexões
- `zod` — schemas de input das tools
- TypeScript estrito, alvo `ES2022`, `module: Node16`

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
- `src/operadoras.ts` — carrega `data/idoperadora.txt` em cache e
  resolve `idoperadora -> nome`.

## Modo stateless e ciclo de vida

Cada `POST /mcp` faz: `createServer()` → novo `StreamableHTTPServerTransport`
com `sessionIdGenerator: undefined` → `server.connect(transport)` →
`transport.handleRequest`. No `res.on("close")` fechamos transport e server.
Não cacheie o `McpServer` no escopo do módulo: o ciclo é por requisição.
O **pool MySQL** (`getPool()`) é o único singleton, e isso é proposital
— reaproveitar conexões entre requisições é fundamental.

## Convenções

- Variáveis de ambiente do MySQL são lidas só dentro de `getPool()`.
  Variáveis de transporte (`PORT`, `HOST`, `MCP_ALLOWED_HOSTS`) são
  lidas no bootstrap em `src/index.ts`.
- Tools devem capturar erros e devolver `{ isError: true, content: [...] }`
  em vez de deixar a exceção propagar pro transporte.
- Validação de input via `zod` é obrigatória — o número é normalizado
  para apenas dígitos (regex `/^\d{10,13}$/`).
- O retorno padrão de uma tool é um único bloco `text` com JSON
  `JSON.stringify(obj, null, 2)`.
- Logs em `console.error` (vai pro stderr/journald). `console.log` está
  livre agora que não usamos stdio, mas mantenha tudo em stderr para
  consistência.

## Stored procedures conhecidas

- `consultaTN(numero VARCHAR)` → 1 linha com `idoperadora`, `CIO`,
  `IsPortado`. `IsPortado` chega como `0|1` e é convertido para boolean
  na tool.

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
