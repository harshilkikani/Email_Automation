import { describe, it, expect } from 'vitest';
import { Scraper } from '../src/scraper.js';

/** Encode an email the way Cloudflare email-protection does (XOR with a key byte). */
function cfEncode(email: string, key = 0x2a): string {
  let h = key.toString(16).padStart(2, '0');
  for (const ch of email) h += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0');
  return h;
}

const HTML = `<!doctype html><html><head>
  <script type="application/ld+json">{"@type":"Plumber","email":"jsonld@ldsite.com"}</script>
</head><body>
  <a href="mailto:plain@mailtosite.com">Email us</a>
  <a class="cf" data-cfemail="${cfEncode('owner@cfsite.com')}">[email&#160;protected]</a>
  <p>Or reach us at hello [at] obfsite [dot] com any time.</p>
  <p>Form sample: example@domain.com</p>
  <img src="/logo@2x.png">
</body></html>`;

describe('Scraper email extraction (hidden-email recovery)', () => {
  it('recovers mailto, Cloudflare, JSON-LD, and [at]/[dot] obfuscated emails; drops junk', async () => {
    const fetcher = async () => ({ status: 200, html: HTML, finalUrl: 'https://x.com' });
    const sc = new Scraper({ enabled: true, fetcher });
    const r = await sc.probe('https://x.com');
    const set = new Set(r.emails);
    expect(set.has('plain@mailtosite.com')).toBe(true);   // mailto
    expect(set.has('owner@cfsite.com')).toBe(true);        // Cloudflare-decoded
    expect(set.has('jsonld@ldsite.com')).toBe(true);       // JSON-LD
    expect(set.has('hello@obfsite.com')).toBe(true);       // [at]/[dot] deobfuscated
    expect(set.has('example@domain.com')).toBe(false);     // placeholder dropped
    expect([...set].some(e => e.includes('logo@2x'))).toBe(false);  // asset filename dropped
  });
});
