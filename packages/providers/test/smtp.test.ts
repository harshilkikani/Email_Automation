/**
 * SmtpAdapter against a scripted in-process SMTP server (plain TCP, no TLS).
 * Asserts the full EHLO → AUTH LOGIN → MAIL/RCPT → DATA handshake and that the
 * returned providerMessageId comes from the server's "queued as" line.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { SmtpAdapter } from '../src/smtp.js';

interface Captured {
  ehlo?: string;
  authUser?: string;
  authPass?: string;
  mailFrom?: string;
  rcptTo?: string;
  data: string;
}

/** A tiny SMTP server that walks the expected dialog and records what it got. */
function startMockSmtp(): Promise<{ port: number; captured: Captured; close: () => void }> {
  const captured: Captured = { data: '' };
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      let buf = '';
      let inData = false;
      let expecting: 'user' | 'pass' | null = null;
      sock.write('220 mock ESMTP\r\n');

      sock.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          if (inData) {
            if (line === '.') {
              inData = false;
              sock.write('250 OK queued as ABC123XYZ\r\n');
            } else {
              // Un-stuff: a wire line beginning with '.' had one dot prepended.
              captured.data += (line.startsWith('.') ? line.slice(1) : line) + '\n';
            }
            continue;
          }
          if (expecting === 'user') {
            captured.authUser = Buffer.from(line, 'base64').toString('utf8');
            expecting = 'pass';
            sock.write('334 UGFzc3dvcmQ6\r\n');
            continue;
          }
          if (expecting === 'pass') {
            captured.authPass = Buffer.from(line, 'base64').toString('utf8');
            expecting = null;
            sock.write('235 2.7.0 Authentication successful\r\n');
            continue;
          }

          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO')) {
            captured.ehlo = line;
            sock.write('250-mock greets you\r\n250 AUTH LOGIN PLAIN\r\n');
          } else if (upper === 'AUTH LOGIN') {
            expecting = 'user';
            sock.write('334 VXNlcm5hbWU6\r\n');
          } else if (upper.startsWith('MAIL FROM')) {
            captured.mailFrom = line;
            sock.write('250 OK\r\n');
          } else if (upper.startsWith('RCPT TO')) {
            captured.rcptTo = line;
            sock.write('250 OK\r\n');
          } else if (upper === 'DATA') {
            inData = true;
            sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            sock.write('221 Bye\r\n');
            sock.end();
          } else {
            sock.write('250 OK\r\n');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, captured, close: () => server.close() });
    });
  });
}

describe('SmtpAdapter', () => {
  let closeServer: (() => void) | null = null;
  afterEach(() => { closeServer?.(); closeServer = null; });

  it('performs the full SMTP handshake and returns the queue id', async () => {
    const mock = await startMockSmtp();
    closeServer = mock.close;

    const adapter = new SmtpAdapter({
      enabled: true,
      host: '127.0.0.1',
      port: mock.port,
      secure: false,
      user: 'ops@keresai.com',
      pass: 's3cr3t-pass',
      fromEmail: 'ops@keresai.com',
    });

    const raw = [
      'From: Keres AI <ops@keresai.com>',
      'To: Lead <lead@example.com>',
      'Subject: Hello',
      '',
      'Body line one.',
      '.dot-stuff-me',
      'Body line three.',
    ].join('\r\n');

    const res = await adapter.send({ to: 'lead@example.com', subject: 'Hello', rawMessage: raw });

    expect(res.provider).toBe('smtp');
    expect(res.providerMessageId).toBe('ABC123XYZ');
    expect(mock.captured.authUser).toBe('ops@keresai.com');
    expect(mock.captured.authPass).toBe('s3cr3t-pass');
    expect(mock.captured.mailFrom).toBe('MAIL FROM:<ops@keresai.com>');
    // Envelope recipient parsed from the To: header's angle-addr.
    expect(mock.captured.rcptTo).toBe('RCPT TO:<lead@example.com>');
    // Body delivered, and the leading-dot line was dot-stuffed on the wire then
    // un-stuffed by the server back to a single dot.
    expect(mock.captured.data).toContain('Body line one.');
    expect(mock.captured.data).toContain('.dot-stuff-me');
    expect(mock.captured.data).toContain('Subject: Hello');
  });

  it('is disabled when enabled=false', async () => {
    const adapter = new SmtpAdapter({
      enabled: false, host: 'x', port: 25, secure: false, user: 'u', pass: 'p',
    });
    expect(adapter.isEnabled()).toBe(false);
    await expect(adapter.send({ to: 'a@b.c', subject: 's', rawMessage: 'x' })).rejects.toThrow(/disabled/i);
  });
});
