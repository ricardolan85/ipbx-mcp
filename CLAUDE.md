# CLAUDE.md

Guia para o Claude Code ao trabalhar neste repositório.

## Visão geral

Servidor MCP em TypeScript (módulo ESM, transporte stdio) que expõe tools
para consultar dados de portabilidade armazenados em um MySQL interno da
Vivavox. A lógica de domínio fica concentrada em stored procedures do
banco — o servidor é uma camada fina de validação e formatação.

## Stack

- `@modelcontextprotocol/sdk` — `McpServer` + `StdioServerTransport`
- `mysql2/promise` — pool de conexões
- `zod` — schemas de input das tools
- TypeScript estrito, alvo `ES2022`, `module: Node16`

## Arquitetura

- `src/index.ts` — instancia o `McpServer`, registra cada tool com
  `server.tool(name, description, zodSchema, handler)` e conecta ao
  transporte stdio.
- `src/db.ts` — `getPool()` lazy (lê env vars na primeira chamada) e
  wrappers tipados para cada stored procedure. Toda nova consulta a SP
  deve virar uma função aqui, não código solto na tool.

## Convenções

- Variáveis de ambiente são lidas só dentro de `getPool()`. Nunca leia
  `process.env` no top-level — quebra os testes e dificulta override.
- Tools devem capturar erros e devolver `{ isError: true, content: [...] }`
  em vez de deixar a exceção propagar pro transporte.
- Validação de input via `zod` é obrigatória — o número é normalizado
  para apenas dígitos (regex `/^\d{10,13}$/`).
- O retorno padrão de uma tool é um único bloco `text` com JSON
  `JSON.stringify(obj, null, 2)`.

## Stored procedures conhecidas

- `consultaTN(numero VARCHAR)` → 1 linha com `idoperadora`, `CIO`,
  `IsPortado`. `IsPortado` chega como `0|1` e é convertido para boolean
  na tool.

## Comandos úteis

```bash
npm run build      # tsc
npm start          # node --env-file=.env dist/index.js
npm run inspect    # MCP Inspector
npm run dev        # tsc --watch
```

## O que NÃO fazer

- Não commitar `.env` (já está no `.gitignore`).
- Não adicionar uma tool `ping` ou similar — o protocolo MCP já tem
  health check no `initialize` handshake.
- Não trocar `--env-file` por dotenv sem motivo: a flag nativa do Node
  20.6+ evita uma dependência.
- Não usar `console.log` no servidor — stdio é o canal MCP. Use
  `console.error` para logs.
