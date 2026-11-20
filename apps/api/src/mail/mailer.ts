import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

/** Transactional email (password reset, email verification). Plain text; no tracking. */
export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SmtpSettings {
  /** host:port, e.g. smtp.gmail.com:587 (465 = implicit TLS). */
  host: string;
  user: string;
  passwordFile: string;
  from: string;
  requireTls: boolean;
}

export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;
  constructor(private readonly s: SmtpSettings) {
    const [host, port = '587'] = s.host.split(':');
    this.transport = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: port === '465',
      requireTLS: s.requireTls,
      auth: { user: s.user, pass: readFileSync(s.passwordFile, 'utf8').trim() },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  async send(m: { to: string; subject: string; text: string }): Promise<void> {
    await this.transport.sendMail({
      from: `ARC <${this.s.from}>`,
      to: m.to,
      subject: m.subject,
      text: m.text,
    });
  }
}
