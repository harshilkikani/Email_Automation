/**
 * Centralised env-driven configuration.
 *
 * One job: read `process.env` once, validate, return a frozen object. The rest
 * of the server imports from here so nobody reads `process.env` ad-hoc.
 */
/* `.env` loading is the launcher's job (Fly secrets, docker-compose, Node 20+ `--env-file`).
   We keep the runtime dependency surface small and never bundle dotenv. */

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}
function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export interface KeresConfig {
  nodeEnv: string;
  sampleMode: boolean;
  budgetMode: 'free' | 'low' | 'normal';
  port: number;
  webPort: number;
  publicBaseUrl: string;

  authToken: string;
  authCookieName: string;
  authCookieSecret: string;
  /**
   * Dedicated signing key for unsubscribe + seedlist tokens. Independent from
   * the session cookie secret so compromise of one doesn't compromise the
   * other. Falls back to `authCookieSecret` if unset (backwards-compatible).
   */
  unsubscribeSigningSecret: string;
  /** Allowed CORS origins in production. Falls back to `publicBaseUrl`. */
  corsOrigin: string[];

  databaseUrl: string;
  databaseDriver: 'node' | 'neon-serverless';

  org: {
    name: string;
    fromName: string;
    fromEmail: string;
    replyTo: string;
    physicalAddress: string;
    outreachSubdomain: string;
    defaultBookingLink: string;
  };

  ses: {
    enabled: boolean;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    configurationSet: string;
    snsTopicArn: string;
    productionAccessConfirmed: boolean;
  };

  postmarkInbound: {
    enabled: boolean;
    token: string;
    basicUser: string;
    basicPass: string;
    inboundAddress: string;
  };

  osm: {
    enabled: boolean;
    overpassUrl: string;
    userAgent: string;
    contactEmail: string;
  };

  yelp: { enabled: boolean; apiKey: string; monthlyBudgetUsd: number };
  places: { enabled: boolean; apiKey: string; monthlyBudgetUsd: number };
  hunter: { enabled: boolean; apiKey: string; monthlyFreeCredits: number };
  bouncer: { enabled: boolean; apiKey: string; monthlyBudgetCents: number };

  seedlistEmails: string[];
  bouncePausePct: number;
  complaintPausePct: number;
  dailySendCapDefault: number;
  logLevel: string;

  /** When true, the API process also serves the React SPA from `apps/web/dist`. */
  serveWeb: boolean;
  webDistPath: string;

  /** Observability — all optional. Sentry/OTel each activate only when their endpoint is set. */
  observability: {
    sentryDsn: string;
    otelEndpoint: string;        // e.g. http://localhost:4318
    serviceName: string;
    serviceVersion: string;
    release: string;
  };

  /** Hybrid queue tier. `db` = existing job_runs; `pg-boss` = pg-boss for high-volume work. */
  queue: {
    tier: 'db' | 'pg-boss';
    /** Optional, lets pg-boss talk to a different DB if you want to isolate it. Defaults to DATABASE_URL. */
    connectionString: string;
    workerConcurrency: number;
    /** Per-tick max sends — overridable so tests can pin batch size. */
    sendBatchSize: number;
  };

  /** Offline AI adapter. Default off; when on, only batch endpoints are allowed. */
  ai: {
    enabled: boolean;
    runtime: 'noop' | 'ollama';
    ollamaUrl: string;
    ollamaModel: string;
    requestTimeoutMs: number;
  };

  /** Market saturation hard cap (% of zip's eligible leads reachable in the rolling window). */
  saturation: {
    rollingDays: number;
    hardCapPct: number;       // refuse send when > this
    softCapPct: number;       // deboost score when > this
    decayTauDays: number;     // e^(-t/tau)
  };

  /** Send-time window — only fire outbound during business hours to protect deliverability. */
  sendWindow: {
    /** UTC hour to start sending, inclusive (default 14 = 10am ET / 9am CT). */
    startHour: number;
    /** UTC hour to stop sending, exclusive (default 22 = 6pm ET / 5pm CT). */
    endHour: number;
    /** Days of week to send: 0=Sun 1=Mon...6=Sat. Default Mon-Fri. */
    daysOfWeek: number[];
  };

  /** Per-organization token-bucket request rate limit. In-memory; bounded to
   *  one process. Fails open on resolver error so a DB hiccup never blocks
   *  the API. */
  perOrgRateLimit: {
    enabled: boolean;
    /** Tokens added per second. */
    rps: number;
    /** Bucket capacity = max burst above the steady rate. */
    burst: number;
  };
}

let cached: Readonly<KeresConfig> | null = null;

export function getConfig(): Readonly<KeresConfig> {
  if (cached) return cached;
  const cfg: KeresConfig = {
    nodeEnv: str('NODE_ENV', 'development'),
    sampleMode: bool('SAMPLE_MODE', true),
    budgetMode: (str('BUDGET_MODE', 'free') as KeresConfig['budgetMode']),
    port: num('PORT', 8080),
    webPort: num('WEB_PORT', 5173),
    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:8080'),

    authToken: str('AUTH_TOKEN', 'change-me'),
    authCookieName: str('AUTH_COOKIE_NAME', 'keres_session'),
    authCookieSecret: str('AUTH_COOKIE_SECRET', 'change-me-too'),
    unsubscribeSigningSecret: str('UNSUBSCRIBE_SIGNING_SECRET') || str('AUTH_COOKIE_SECRET', 'change-me-too'),
    corsOrigin: (str('CORS_ORIGIN') || '').split(',').map(s => s.trim()).filter(Boolean),

    databaseUrl: str('DATABASE_URL', ''),
    databaseDriver: (str('DATABASE_DRIVER', 'node') as KeresConfig['databaseDriver']),

    org: {
      name: str('ORG_NAME', 'Keres AI'),
      fromName: str('FROM_NAME', 'Keres AI Outreach'),
      fromEmail: str('FROM_EMAIL', 'hello@outreach.keresai.com'),
      replyTo: str('REPLY_TO', 'replies@outreach.keresai.com'),
      physicalAddress: str('PHYSICAL_ADDRESS', ''),
      outreachSubdomain: str('OUTREACH_SUBDOMAIN', 'outreach.keresai.com'),
      defaultBookingLink: str('DEFAULT_BOOKING_LINK', 'https://cal.keresai.com/intro'),
    },

    ses: {
      enabled: bool('ENABLE_SES', false),
      region: str('SES_REGION', 'us-east-1'),
      accessKeyId: str('SES_ACCESS_KEY_ID'),
      secretAccessKey: str('SES_SECRET_ACCESS_KEY'),
      configurationSet: str('SES_CONFIGURATION_SET', 'keres-outreach'),
      snsTopicArn: str('SES_SNS_TOPIC_ARN'),
      productionAccessConfirmed: bool('SES_PRODUCTION_ACCESS_CONFIRMED', false),
    },

    postmarkInbound: {
      enabled: bool('ENABLE_POSTMARK_INBOUND', false),
      token: str('POSTMARK_INBOUND_TOKEN'),
      basicUser: str('POSTMARK_INBOUND_USERNAME'),
      basicPass: str('POSTMARK_INBOUND_PASSWORD'),
      inboundAddress: str('INBOUND_ADDRESS', 'replies@outreach.keresai.com'),
    },

    osm: {
      enabled: bool('ENABLE_OSM', true),
      overpassUrl: str('OSM_OVERPASS_URL', 'https://overpass-api.de/api/interpreter'),
      userAgent: str('OSM_USER_AGENT', 'KeresAI/0.1 (ops@keresai.com)'),
      contactEmail: str('OSM_CONTACT_EMAIL', 'ops@keresai.com'),
    },

    yelp:    { enabled: bool('ENABLE_YELP', false),    apiKey: str('YELP_API_KEY'),    monthlyBudgetUsd: num('YELP_MONTHLY_BUDGET_USD', 0) },
    places:  { enabled: bool('ENABLE_PLACES', false),  apiKey: str('PLACES_API_KEY'),  monthlyBudgetUsd: num('PLACES_MONTHLY_BUDGET_USD', 0) },
    hunter:  { enabled: bool('ENABLE_HUNTER', false),  apiKey: str('HUNTER_API_KEY'),  monthlyFreeCredits: num('HUNTER_MONTHLY_FREE_CREDITS', 50) },
    bouncer: { enabled: bool('ENABLE_BOUNCER', false), apiKey: str('BOUNCER_API_KEY'), monthlyBudgetCents: num('BOUNCER_MONTHLY_BUDGET_USD', 5) * 100 },

    seedlistEmails: str('SEEDLIST_EMAILS').split(',').map(s => s.trim()).filter(Boolean),
    bouncePausePct: num('BOUNCE_PAUSE_PCT', 4),
    complaintPausePct: num('COMPLAINT_PAUSE_PCT', 0.1),
    dailySendCapDefault: num('DAILY_SEND_CAP_DEFAULT', 50),
    logLevel: str('LOG_LEVEL', 'info'),
    serveWeb: bool('SERVE_WEB', false),
    webDistPath: str('WEB_DIST_PATH', ''),

    observability: {
      sentryDsn: str('SENTRY_DSN', ''),
      otelEndpoint: str('OTEL_EXPORTER_OTLP_ENDPOINT', ''),
      serviceName: str('OTEL_SERVICE_NAME', 'keres-server'),
      serviceVersion: str('OTEL_SERVICE_VERSION', '0.1.0'),
      release: str('RELEASE_SHA', ''),
    },

    queue: {
      tier: (str('QUEUE_TIER', 'db') as 'db' | 'pg-boss'),
      connectionString: str('QUEUE_DATABASE_URL') || str('DATABASE_URL', ''),
      workerConcurrency: num('QUEUE_WORKER_CONCURRENCY', 4),
      sendBatchSize: num('SEND_BATCH_SIZE', 5),
    },

    ai: {
      enabled: bool('ENABLE_LOCAL_AI', false),
      runtime: (str('AI_RUNTIME', 'noop') as 'noop' | 'ollama'),
      ollamaUrl: str('OLLAMA_URL', 'http://localhost:11434'),
      ollamaModel: str('OLLAMA_MODEL', 'llama3.1:8b-instruct-q4_K_M'),
      requestTimeoutMs: num('AI_REQUEST_TIMEOUT_MS', 60_000),
    },

    saturation: {
      rollingDays: num('SATURATION_ROLLING_DAYS', 30),
      hardCapPct: num('SATURATION_HARD_CAP_PCT', 60),
      softCapPct: num('SATURATION_SOFT_CAP_PCT', 30),
      decayTauDays: num('SATURATION_DECAY_TAU_DAYS', 14),
    },

    sendWindow: {
      startHour: num('SEND_WINDOW_START_HOUR', 14),
      endHour:   num('SEND_WINDOW_END_HOUR', 22),
      daysOfWeek: (str('SEND_WINDOW_DAYS', '1,2,3,4,5')).split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isFinite(n) && n >= 0 && n <= 6),
    },

    perOrgRateLimit: {
      enabled: bool('PER_ORG_RATE_LIMIT_ENABLED', true),
      rps:     num('PER_ORG_RATE_LIMIT_RPS', 10),
      burst:   num('PER_ORG_RATE_LIMIT_BURST', 100),
    },
  };
  cached = Object.freeze(cfg);
  return cached;
}

/**
 * Test helper: rebuild the cached config (used in tests that set env vars).
 * Never call from production code.
 */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Startup validation. Throws a concise, actionable error if a critical setting
 * is missing or obviously unsafe. The server entrypoint catches and exits
 * non-zero so misconfigured deployments fail fast rather than running with
 * defaults.
 */
export interface ValidationIssue {
  severity: 'error' | 'warn';
  code: string;
  message: string;
}

export function validateConfig(cfg: Readonly<KeresConfig>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!cfg.databaseUrl || cfg.databaseUrl.length < 10) {
    issues.push({ severity: 'error', code: 'database_url', message: 'DATABASE_URL is not set.' });
  }
  if (!cfg.authToken || cfg.authToken === 'change-me' || cfg.authToken.length < 16) {
    issues.push({
      severity: cfg.nodeEnv === 'production' ? 'error' : 'warn',
      code: 'auth_token_weak',
      message: 'AUTH_TOKEN is empty or weak. Set it to a long random string (>= 32 chars).',
    });
  }
  if (!cfg.authCookieSecret || cfg.authCookieSecret === 'change-me-too' || cfg.authCookieSecret.length < 32) {
    issues.push({
      severity: cfg.nodeEnv === 'production' ? 'error' : 'warn',
      code: 'cookie_secret_weak',
      message: 'AUTH_COOKIE_SECRET is empty or weak (must be >= 32 chars).',
    });
  }
  if (!cfg.unsubscribeSigningSecret || cfg.unsubscribeSigningSecret.length < 32) {
    issues.push({
      severity: cfg.nodeEnv === 'production' ? 'error' : 'warn',
      code: 'unsub_secret_weak',
      message: 'UNSUBSCRIBE_SIGNING_SECRET is empty or weak (must be >= 32 chars). If unset it falls back to AUTH_COOKIE_SECRET — separating the two is defense-in-depth.',
    });
  }
  if (cfg.nodeEnv === 'production' && cfg.sampleMode) {
    issues.push({ severity: 'error', code: 'sample_mode_in_prod', message: 'SAMPLE_MODE=true in production. Refusing to start.' });
  }
  if (cfg.nodeEnv === 'production' && !cfg.publicBaseUrl.startsWith('https://')) {
    issues.push({ severity: 'error', code: 'public_base_url_insecure', message: 'PUBLIC_BASE_URL must be https in production.' });
  }
  if (cfg.ses.enabled && (!cfg.ses.region || !cfg.ses.accessKeyId || !cfg.ses.secretAccessKey)) {
    issues.push({ severity: 'error', code: 'ses_missing_creds', message: 'ENABLE_SES=true but SES_REGION / SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY are missing.' });
  }
  if (cfg.ses.enabled && !cfg.ses.productionAccessConfirmed && cfg.nodeEnv === 'production') {
    issues.push({ severity: 'error', code: 'ses_sandbox_in_prod', message: 'SES_PRODUCTION_ACCESS_CONFIRMED must be true in production.' });
  }
  if (cfg.bouncer.enabled && !cfg.bouncer.apiKey) {
    issues.push({ severity: 'error', code: 'bouncer_no_key', message: 'ENABLE_BOUNCER=true but BOUNCER_API_KEY is empty.' });
  }
  if (cfg.hunter.enabled && !cfg.hunter.apiKey) {
    issues.push({ severity: 'error', code: 'hunter_no_key', message: 'ENABLE_HUNTER=true but HUNTER_API_KEY is empty.' });
  }
  if (cfg.yelp.enabled && !cfg.yelp.apiKey) {
    issues.push({ severity: 'error', code: 'yelp_no_key', message: 'ENABLE_YELP=true but YELP_API_KEY is empty.' });
  }
  if (cfg.seedlistEmails.length === 0 && cfg.nodeEnv === 'production') {
    issues.push({ severity: 'warn', code: 'no_seedlist', message: 'SEEDLIST_EMAILS is empty. Validation Mode cannot insert seedlist recipients.' });
  }
  if (!cfg.org.physicalAddress && cfg.nodeEnv === 'production') {
    issues.push({ severity: 'warn', code: 'no_physical_address', message: 'PHYSICAL_ADDRESS is empty. CAN-SPAM-compliant sends are blocked until set.' });
  }
  if (cfg.queue.tier !== 'db' && cfg.queue.tier !== 'pg-boss') {
    issues.push({ severity: 'error', code: 'queue_tier_invalid', message: `QUEUE_TIER must be 'db' or 'pg-boss' (got ${cfg.queue.tier}).` });
  }
  if (cfg.ai.enabled && cfg.ai.runtime === 'ollama' && !cfg.ai.ollamaUrl) {
    issues.push({ severity: 'error', code: 'ai_ollama_no_url', message: 'ENABLE_LOCAL_AI=true with AI_RUNTIME=ollama but OLLAMA_URL is empty.' });
  }
  if (cfg.saturation.softCapPct > cfg.saturation.hardCapPct) {
    issues.push({ severity: 'warn', code: 'saturation_caps_inverted', message: 'SATURATION_SOFT_CAP_PCT > SATURATION_HARD_CAP_PCT — soft cap will never fire.' });
  }
  return issues;
}
