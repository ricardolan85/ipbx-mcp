import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendEmail } from "./resend.js";
import { logToolCall, type AuthIdentity } from "./audit.js";

export function createServer(identity: AuthIdentity): McpServer {
  const server = new McpServer({
    name: "mcp-resend",
    version: "0.1.0",
  });

  // Um ou mais emails. Aceita string unica ou array (Resend permite ate 50).
  const emailList = z.union([
    z.string().email(),
    z.array(z.string().email()).min(1),
  ]);

  server.registerTool(
    "send-email",
    {
      description:
        "Envia um email transacional via Resend. Informe ao menos 'html' ou " +
        "'text'. Se 'from' for omitido, usa RESEND_FROM do ambiente.",
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe(
            "Remetente, ex: 'Vivavox <no-reply@vivavox.com.br>'. Omitido usa RESEND_FROM.",
          ),
        to: emailList.describe("Destinatario(s). String ou array de emails (ate 50)."),
        subject: z.string().min(1).describe("Assunto do email."),
        html: z.string().optional().describe("Corpo em HTML."),
        text: z.string().optional().describe("Corpo em texto puro."),
        cc: emailList.optional().describe("Copia (cc)."),
        bcc: emailList.optional().describe("Copia oculta (bcc)."),
        replyTo: emailList.optional().describe("Endereco(s) de reply-to."),
        scheduledAt: z
          .string()
          .optional()
          .describe("Agendamento: ISO 8601 ou linguagem natural ('in 1 hour')."),
      },
    },
    async (input) => {
      const start = Date.now();
      // No audit so vai metadado de roteamento - nunca o corpo do email (PII).
      const auditArgs = {
        from: input.from,
        to: input.to,
        subject: input.subject,
        scheduledAt: input.scheduledAt,
      };
      try {
        const { id } = await sendEmail(input);

        logToolCall({
          identity,
          tool: "send-email",
          args: auditArgs,
          resultOk: true,
          durationMs: Date.now() - start,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { id, status: input.scheduledAt ? "agendado" : "enviado" },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logToolCall({
          identity,
          tool: "send-email",
          args: auditArgs,
          resultOk: false,
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `Erro ao enviar email: ${msg}` }],
        };
      }
    },
  );

  return server;
}
