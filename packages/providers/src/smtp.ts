/**
 * SMTP adapter — sends pre-built RFC 5322 messages through any plain SMTP
 * mailbox (Spacemail, Private Email, Gmail SMTP, etc.). No API/ESP required:
 * a mailbox host + login is enough, which is what Spacemail (`mail.spacemail.com`)
 * provides for `ops@keresai.com`.
 *
 * Implemented directly on Node's `node:tls` / `node:net` — a small, focused
 * client (no nodemailer dependency) since the pipeline already hands us a fully
 * built `rawMessage`. We only need: greet -> EHLO -> AUTH -> MAIL/RCPT -> DATA.
 *
 * Note: a plain mailbox gives NO bounce/complaint webhooks (unlike SES/Mailgun),
 * so closed-loop scoring degrades to manual. Keep volume low and warm up. To
 * scale, swap `ENABLE_SMTP` for `ENABLE_RESEND`/`ENABLE_SES` — no pipeline change.
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { OutboundProvider, SendInput, SendResult } from './types.js';

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** true = implicit TLS on connect (465); false = plain + STARTTLS (587). */
  secure: boolean;
  user: string;
  pass: string;
  /** Envelope MAIL FROM. Defaults to `user` (Spacemail requires it to match). */
  fromEmail?: string;
  /** Socket idle timeout per command, ms. */
  timeoutMs?: number;
}

interface SmtpReply {
  code: number;
  lines: string[];
}

export class SmtpAdapter implements OutboundProvider {
  readonly name = 'smtp';
  constructor(private cfg: SmtpConfig) {}
  isEnabled() { return this.cfg.enabled; }

  async send(input: SendInput): Promise<SendResult> {
    if (!this.isEnabled()) throw new Error('SMTP disabled');
    if (!this.cfg.host || !this.cfg.user || !this.cfg.pass) {
      throw new Error('SMTP misconfigured: host, user and pass are required');
    }

    const envelopeFrom = this.cfg.fromEmail || this.cfg.user;
    const to = extractEnvelopeTo(input.rawMessage) ?? input.to;
    const conn = new SmtpConnection(this.cfg);

    try {
      await conn.connect();
      await conn.command(`MAIL FROM:<${envelopeFrom}>`, 250);
      await conn.command(`RCPT TO:<${to}>`, [250, 251]);
      await conn.command('DATA', 354);
      const reply = await conn.sendData(input.rawMessage);
      await conn.command('QUIT', [221, 250]).catch(() => undefined);
      return {
        provider: this.name,
        providerMessageId: parseQueueId(reply, input.customMessageId),
        costCents: 0,
      };
    } catch (err) {
      conn.destroy();
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      conn.end();
    }
  }
}

/** Pull the recipient out of the raw message so the envelope routes correctly. */
function extractEnvelopeTo(raw: string): string | null {
  const m = raw.match(/^To:\s*(.+)$/im);
  const header = m?.[1];
  if (!header) return null;
  const addr = header.match(/<([^>]+)>/);
  return (addr?.[1] ?? header).trim();
}

/** The 250 after DATA usually carries a queue id; fall back to our own id. */
function parseQueueId(reply: SmtpReply, fallback?: string): string {
  const line = reply.lines.join(' ');
  const q = line.match(/queued as ([A-Za-z0-9]+)/i)?.[1]
    ?? line.match(/\bid=([^\s;]+)/i)?.[1];
  return q ?? fallback ?? randomUUID();
}

/** Minimal line-buffered SMTP connection with multiline-reply parsing. */
class SmtpConnection {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer = '';
  private pending: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | null = null;
  private replyQueue: SmtpReply[] = [];
  private closed = false;
  private collectLines: string[] = [];
  private collectCode = 0;
  private readonly timeoutMs: number;

  constructor(private cfg: SmtpConfig) {
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    this.socket = this.cfg.secure
      ? tls.connect({ host: this.cfg.host, port: this.cfg.port, servername: this.cfg.host })
      : net.connect({ host: this.cfg.host, port: this.cfg.port });
    this.attach();
    await this.waitConnect();
    await this.expect(220);

    const ehloHost = localName();
    let ehlo = await this.command(`EHLO ${ehloHost}`, 250).catch(() => null);

    if (!this.cfg.secure) {
      const caps = (ehlo?.lines ?? []).join(' ').toUpperCase();
      if (caps.includes('STARTTLS')) {
        await this.command('STARTTLS', 220);
        await this.upgradeTls();
        ehlo = await this.command(`EHLO ${ehloHost}`, 250);
      }
    }

    const caps = (ehlo?.lines ?? []).join('\n').toUpperCase();
    await this.authenticate(caps);
  }

  private async authenticate(caps: string): Promise<void> {
    const { user, pass } = this.cfg;
    if (caps.includes('AUTH') && caps.includes('LOGIN')) {
      await this.command('AUTH LOGIN', 334);
      await this.command(b64(user), 334);
      await this.command(b64(pass), 235);
      return;
    }
    // Fallback: AUTH PLAIN — base64 of <authzid> NUL <authcid> NUL <passwd>.
    const NUL = String.fromCharCode(0);
    const plain = b64(`${NUL}${user}${NUL}${pass}`);
    await this.command(`AUTH PLAIN ${plain}`, 235);
  }

  /** Send one command line and assert the reply code is in `expected`. */
  async command(line: string, expected: number | number[]): Promise<SmtpReply> {
    this.write(line + '\r\n');
    return this.expect(expected);
  }

  /** Stream the DATA payload (dot-stuffed, CRLF-normalized) + terminator. */
  async sendData(rawMessage: string): Promise<SmtpReply> {
    const normalized = rawMessage.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const stuffed = normalized.replace(/\r\n\./g, '\r\n..');
    const trailer = stuffed.endsWith('\r\n') ? '' : '\r\n';
    this.write(stuffed + trailer + '.\r\n');
    return this.expect(250);
  }

  private async expect(expected: number | number[]): Promise<SmtpReply> {
    const reply = await this.readReply();
    const ok = Array.isArray(expected) ? expected.includes(reply.code) : reply.code === expected;
    if (!ok) {
      throw new Error(`SMTP ${this.cfg.host}: expected ${expected}, got ${reply.code} — ${reply.lines.join(' ')}`);
    }
    return reply;
  }

  private attach(): void {
    this.socket.setEncoding('utf8');
    this.socket.setTimeout(this.timeoutMs);
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (e: Error) => this.fail(e));
    this.socket.on('timeout', () => this.fail(new Error(`SMTP timeout after ${this.timeoutMs}ms`)));
    this.socket.on('close', () => { this.closed = true; });
  }

  private waitConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ev = this.cfg.secure ? 'secureConnect' : 'connect';
      this.socket.once(ev, () => resolve());
      this.socket.once('error', reject);
    });
  }

  private upgradeTls(): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket as net.Socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('timeout');
      const secure = tls.connect({ socket: plain, host: this.cfg.host, servername: this.cfg.host });
      this.socket = secure;
      this.attach();
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    // A complete reply ends with a line "NNN <SP> ...". Lines "NNN-..." continue.
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.collect(line);
    }
  }

  private collect(line: string): void {
    const m = line.match(/^(\d{3})([ -])(.*)$/);
    if (!m) { this.collectLines.push(line); return; }
    this.collectCode = Number(m[1]);
    this.collectLines.push(m[3] ?? '');
    if (m[2] === ' ') {
      const reply: SmtpReply = { code: this.collectCode, lines: this.collectLines };
      this.collectLines = [];
      this.deliver(reply);
    }
  }

  private deliver(reply: SmtpReply): void {
    if (this.pending) {
      const p = this.pending; this.pending = null;
      p.resolve(reply);
    } else {
      this.replyQueue.push(reply);
    }
  }

  private readReply(): Promise<SmtpReply> {
    if (this.replyQueue.length > 0) return Promise.resolve(this.replyQueue.shift()!);
    if (this.closed) return Promise.reject(new Error('SMTP connection closed'));
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  private fail(e: Error): void {
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(e); }
  }

  private write(s: string): void {
    if (!this.closed) this.socket.write(s);
  }

  end(): void { try { this.socket?.end(); } catch { /* ignore */ } }
  destroy(): void { try { this.socket?.destroy(); } catch { /* ignore */ } }
}

function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }
function localName(): string {
  const h = process.env.SMTP_EHLO_NAME || process.env.HOSTNAME || 'localhost';
  return /^[A-Za-z0-9.-]+$/.test(h) ? h : 'localhost';
}
