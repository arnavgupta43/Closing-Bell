// Email goes through this interface: Mailpit (SMTP) locally, SES on AWS.
// The PDF worker only ever calls send(); swapping providers means swapping one class.

import nodemailer, { type Transporter } from "nodemailer";

export type Attachment = { filename: string; content: Buffer };

export interface EmailSender {
  send(to: string, subject: string, body: string, attachment: Attachment): Promise<void>;
}

const FROM = "notes@closingbell.local";

export class SmtpEmailSender implements EmailSender {
  private transport: Transporter;

  // Defaults point at Mailpit from the laptop. Inside a Lambda container (layer 2b)
  // SMTP_HOST will be set to "mailpit", because there "localhost" is the container itself.
  constructor(host = process.env.SMTP_HOST ?? "localhost", port = Number(process.env.SMTP_PORT ?? 1025)) {
    this.transport = nodemailer.createTransport({ host, port, secure: false });
  }

  async send(to: string, subject: string, body: string, attachment: Attachment): Promise<void> {
    await this.transport.sendMail({ from: FROM, to, subject, text: body, attachments: [attachment] });
  }
}
