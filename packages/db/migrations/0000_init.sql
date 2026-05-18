-- Keres AI bootstrap migration.
-- Extensions first; Drizzle-generated tables next when `pnpm db:generate` is run.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
