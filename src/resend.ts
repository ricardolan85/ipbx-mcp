// Cliente de envio de email via Resend (SDK oficial).
//
// O backend das tools e a API do Resend, autenticada por RESEND_API_KEY
// (Bearer). O cliente e um singleton lazy para nao recriar a cada
// chamada de tool.

import { Resend, type CreateEmailOptions } from "resend";

let client: Resend | null = null;

function getClient(): Resend {
  if (!client) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY nao definido");
    client = new Resend(key);
  }
  return client;
}

export interface SendEmailInput {
  from?: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  scheduledAt?: string;
}

export interface SendEmailResult {
  id: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const from = input.from ?? process.env.RESEND_FROM;
  if (!from) {
    throw new Error(
      "Remetente ausente: passe 'from' ou defina RESEND_FROM no ambiente.",
    );
  }
  if (!input.html && !input.text) {
    throw new Error("Informe ao menos um corpo: 'html' ou 'text'.");
  }

  const payload = {
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyTo,
    scheduledAt: input.scheduledAt,
  } as CreateEmailOptions;

  const { data, error } = await getClient().emails.send(payload);
  if (error) {
    throw new Error(`${error.name ?? "resend_error"}: ${error.message}`);
  }
  if (!data) {
    throw new Error("Resend retornou sem id e sem erro.");
  }
  return { id: data.id };
}
