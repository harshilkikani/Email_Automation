/**
 * Minimal read-only IMAP-over-TLS client (no external dependency).
 *
 * Just enough to poll a mailbox for bounce/NDR messages: LOGIN, SELECT INBOX,
 * SEARCH, and FETCH BODY.PEEK[] (PEEK = never sets \Seen, so we don't disturb
 * the operator's view of their inbox). Not a general-purpose IMAP library.
 */
import tls from 'node:tls';

export interface ImapConfig { host: string; port: number; user: string; pass: string }

export class ImapClient {
  private sock: tls.TLSSocket | null = null;
  private buf = '';
  private waiters: Array<{ tag: string; resolve: (t: string) => void; reject: (e: Error) => void; onContinuation?: () => void; continued?: boolean }> = [];
  private seq = 0;

  constructor(private cfg: ImapConfig) {}

  connect(timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host: this.cfg.host, port: this.cfg.port, servername: this.cfg.host });
      this.sock = sock;
      sock.setTimeout(timeoutMs);
      let greeted = false;
      sock.on('data', (d) => {
        this.buf += d.toString('utf8');
        if (!greeted) { greeted = true; this.buf = ''; resolve(); return; }
        this.drain();
      });
      sock.on('timeout', () => reject(new Error('imap timeout')));
      sock.on('error', (e) => { reject(e); this.failAll(e); });
      sock.on('close', () => this.failAll(new Error('imap closed')));
    });
  }

  private drain(): void {
    while (this.waiters[0]) {
      const w = this.waiters[0];
      /* Literal continuation: server replies "+ ..." asking for the payload. */
      if (w.onContinuation && !w.continued && /^\+/m.test(this.buf)) {
        this.buf = ''; w.continued = true; w.onContinuation(); continue;
      }
      if (new RegExp('^' + w.tag + ' (OK|NO|BAD)', 'm').test(this.buf)) {
        const text = this.buf; this.buf = ''; this.waiters.shift(); w.resolve(text);
      } else break;
    }
  }
  private failAll(e: Error): void { for (const w of this.waiters.splice(0)) w.reject(e); }

  private cmd(line: string): Promise<string> {
    const tag = 'a' + (++this.seq);
    return new Promise((resolve, reject) => {
      this.waiters.push({ tag, resolve, reject });
      this.sock!.write(`${tag} ${line}\r\n`);
    });
  }

  async login(): Promise<void> {
    const r = await this.cmd(`LOGIN "${this.cfg.user}" "${this.cfg.pass}"`);
    if (!new RegExp('^a\\d+ OK', 'm').test(r)) throw new Error('imap login failed');
  }

  async selectInbox(): Promise<number> {
    const r = await this.cmd('SELECT INBOX');
    return Number(r.match(/(\d+) EXISTS/)?.[1] ?? 0);
  }

  /** SEARCH; returns message sequence numbers. `criteria` e.g. `SINCE 14-Jun-2026 FROM "MAILER-DAEMON"`. */
  async search(criteria: string): Promise<number[]> {
    const r = await this.cmd(`SEARCH ${criteria}`);
    const m = r.match(/\* SEARCH([\d ]*)/);
    return (m?.[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
  }

  /** Fetch a full message body (read-only, PEEK). */
  async fetchRaw(seqNo: number): Promise<string> {
    const r = await this.cmd(`FETCH ${seqNo} (BODY.PEEK[])`);
    /* Strip the IMAP framing: first line is `* N FETCH (... {bytes}` and the
       trailing `)` + tagged OK. Return the literal payload between them. */
    const start = r.indexOf('\r\n');
    const end = r.lastIndexOf('\r\n)');
    return start >= 0 && end > start ? r.slice(start + 2, end) : r;
  }

  /** APPEND a full RFC822 message into a folder (e.g. "Sent"), flagged \Seen. */
  async append(folder: string, message: string, flags = '(\\Seen)'): Promise<void> {
    const msg = message.replace(/\r?\n/g, '\r\n');
    const bytes = Buffer.byteLength(msg, 'utf8');
    const tag = 'a' + (++this.seq);
    const text = await new Promise<string>((resolve, reject) => {
      this.waiters.push({ tag, resolve, reject, continued: false, onContinuation: () => this.sock!.write(msg + '\r\n') });
      this.sock!.write(`${tag} APPEND "${folder}" ${flags} {${bytes}}\r\n`);
    });
    if (!new RegExp('^' + tag + ' OK', 'm').test(text)) throw new Error('APPEND failed: ' + text.slice(0, 160));
  }

  async logout(): Promise<void> {
    try { await this.cmd('LOGOUT'); } catch { /* ignore */ }
    try { this.sock?.destroy(); } catch { /* ignore */ }
  }
}

/** Best-effort: save a copy of a sent message into the mailbox "Sent" folder. */
export async function saveToSentFolder(cfg: ImapConfig, rawMessage: string, folder = 'Sent'): Promise<void> {
  const client = new ImapClient(cfg);
  try {
    await client.connect();
    await client.login();
    await client.append(folder, rawMessage);
  } finally {
    await client.logout();
  }
}
