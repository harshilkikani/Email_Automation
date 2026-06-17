/**
 * SMTP mailbox probe — confirms a specific mailbox actually exists before we
 * send, by opening an SMTP conversation with the recipient's MX and issuing
 * RCPT TO without ever sending data (we QUIT before DATA).
 *
 *   250/251 at RCPT  → mailbox accepted        → true  (valid)
 *   5xx    at RCPT   → mailbox rejected         → false (invalid — would bounce)
 *   4xx / timeout / connect fail → ambiguous    → null  (greylist / can't tell)
 *
 * Honest limits: domains hosted on Microsoft 365 / Google Workspace often
 * "accept-all" at RCPT (return 250 for everything) or block probes, so this
 * can't catch every dead mailbox — but it removes the obvious bounces (the
 * "550 user unknown" class) for free. Port 25 outbound works from Fly.
 */
import net from 'node:net';

export interface SmtpProbeOptions {
  fromDomain?: string;   // HELO/MAIL FROM domain — use our real sending domain
  fromEmail?: string;
  timeoutMs?: number;
}

/** Parse the latest (possibly multi-line) SMTP reply out of the buffer. */
function latestReply(buf: string): { code: number; complete: boolean } {
  const lines = buf.split(/\r?\n/).filter(l => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last) return { code: 0, complete: false };
  const m = last.match(/^(\d{3})([ -])/);
  if (!m) return { code: 0, complete: false };
  return { code: parseInt(m[1]!, 10), complete: m[2] === ' ' };
}

export async function smtpRcptProbe(email: string, mx: string, opts: SmtpProbeOptions = {}): Promise<boolean | null> {
  const fromDomain = opts.fromDomain ?? 'keresai.com';
  const fromEmail = opts.fromEmail ?? `postmaster@${fromDomain}`;
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise<boolean | null>((resolve) => {
    let settled = false;
    let stage: 'greet' | 'ehlo' | 'mail' | 'rcpt' = 'greet';
    let buf = '';
    const sock = net.connect({ host: mx, port: 25 });
    sock.setTimeout(timeoutMs);

    const finish = (v: boolean | null) => {
      if (settled) return;
      settled = true;
      try { sock.write('QUIT\r\n'); } catch { /* ignore */ }
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };

    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));

    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const { code, complete } = latestReply(buf);
      if (!complete) return;
      buf = '';
      switch (stage) {
        case 'greet':
          if (code !== 220) return finish(null);
          stage = 'ehlo';
          sock.write(`EHLO ${fromDomain}\r\n`);
          return;
        case 'ehlo':
          if (code !== 250) return finish(null);
          stage = 'mail';
          sock.write(`MAIL FROM:<${fromEmail}>\r\n`);
          return;
        case 'mail':
          if (code !== 250) return finish(null);
          stage = 'rcpt';
          sock.write(`RCPT TO:<${email}>\r\n`);
          return;
        case 'rcpt':
          if (code === 250 || code === 251) return finish(true);
          if (code >= 500) return finish(false);
          return finish(null);   // 4xx greylist / ambiguous
      }
    });
  });
}
