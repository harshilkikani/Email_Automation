import { describe, it, expect, beforeEach } from 'vitest';
import { getConfig, validateConfig, resetConfigCache } from '../src/config.js';

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SES_') || k.startsWith('BOUNCER_') || k.startsWith('HUNTER_') || k.startsWith('YELP_')) delete process.env[k];
  }
  delete process.env.SAMPLE_MODE;
  delete process.env.NODE_ENV;
  delete process.env.DATABASE_URL;
  delete process.env.AUTH_TOKEN;
  delete process.env.AUTH_COOKIE_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.ENABLE_SES;
  delete process.env.ENABLE_BOUNCER;
  delete process.env.ENABLE_HUNTER;
  delete process.env.ENABLE_YELP;
  delete process.env.SES_PRODUCTION_ACCESS_CONFIRMED;
  resetConfigCache();
});

function setEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  resetConfigCache();
}

describe('config validation', () => {
  it('errors when DATABASE_URL is missing', () => {
    setEnv({ NODE_ENV: 'production', AUTH_TOKEN: 'x'.repeat(40), AUTH_COOKIE_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://x.com', SAMPLE_MODE: 'false' });
    const cfg = getConfig();
    const issues = validateConfig(cfg);
    expect(issues.some(i => i.code === 'database_url' && i.severity === 'error')).toBe(true);
  });
  it('errors when SAMPLE_MODE=true in production', () => {
    setEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', AUTH_TOKEN: 'x'.repeat(40), AUTH_COOKIE_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://x.com', SAMPLE_MODE: 'true' });
    const cfg = getConfig();
    const issues = validateConfig(cfg);
    expect(issues.some(i => i.code === 'sample_mode_in_prod' && i.severity === 'error')).toBe(true);
  });
  it('errors when AUTH_TOKEN is the default', () => {
    setEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', AUTH_TOKEN: 'change-me', AUTH_COOKIE_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://x.com' });
    const cfg = getConfig();
    const issues = validateConfig(cfg);
    expect(issues.some(i => i.code === 'auth_token_weak' && i.severity === 'error')).toBe(true);
  });
  it('errors when SES enabled without creds', () => {
    setEnv({
      NODE_ENV: 'production', DATABASE_URL: 'postgres://x',
      AUTH_TOKEN: 'x'.repeat(40), AUTH_COOKIE_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://x.com',
      ENABLE_SES: 'true', SES_PRODUCTION_ACCESS_CONFIRMED: 'true',
    });
    const cfg = getConfig();
    const issues = validateConfig(cfg);
    expect(issues.some(i => i.code === 'ses_missing_creds' && i.severity === 'error')).toBe(true);
  });
  it('errors when ENABLE_SES + SES sandbox in production', () => {
    setEnv({
      NODE_ENV: 'production', DATABASE_URL: 'postgres://x',
      AUTH_TOKEN: 'x'.repeat(40), AUTH_COOKIE_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://x.com',
      ENABLE_SES: 'true', SES_REGION: 'us-east-1', SES_ACCESS_KEY_ID: 'k', SES_SECRET_ACCESS_KEY: 's',
    });
    const cfg = getConfig();
    const issues = validateConfig(cfg);
    expect(issues.some(i => i.code === 'ses_sandbox_in_prod' && i.severity === 'error')).toBe(true);
  });
  it('passes when production config is complete', () => {
    setEnv({
      NODE_ENV: 'production', SAMPLE_MODE: 'false', DATABASE_URL: 'postgres://x',
      AUTH_TOKEN: 'x'.repeat(40), AUTH_COOKIE_SECRET: 'x'.repeat(40),
      PUBLIC_BASE_URL: 'https://x.com',
      ENABLE_SES: 'true', SES_REGION: 'us-east-1', SES_ACCESS_KEY_ID: 'k', SES_SECRET_ACCESS_KEY: 's',
      SES_PRODUCTION_ACCESS_CONFIRMED: 'true',
      PHYSICAL_ADDRESS: '1 Main St Austin TX',
      SEEDLIST_EMAILS: 'seed@example.com',
    });
    const cfg = getConfig();
    const issues = validateConfig(cfg);
    expect(issues.filter(i => i.severity === 'error')).toEqual([]);
  });
});
