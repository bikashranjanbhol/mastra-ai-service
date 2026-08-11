/**
 * Storage selection: LibSQL/SQLite locally, Postgres in production.
 *
 * The ONLY switch is DATABASE_URL. Nothing outside this file knows which
 * backend is live — agents and tools talk to `TicketStore`, never to a driver.
 */

export type StorageBackend = 'libsql-file' | 'libsql-remote' | 'postgres';

export interface StorageTarget {
  readonly backend: StorageBackend;
  readonly url: string;
  readonly authToken?: string;
  /** Safe to log — credentials stripped. */
  readonly describe: string;
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/**
 * Resolve the storage target from the environment.
 *
 * Precedence:
 *   1. DATABASE_URL starting postgres:// or postgresql://  → Postgres
 *   2. TURSO_DATABASE_URL                                  → hosted LibSQL
 *   3. default                                             → local SQLite file
 */
export function resolveStorageTarget(env: NodeJS.ProcessEnv = process.env): StorageTarget {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl)) {
    return { backend: 'postgres', url: databaseUrl, describe: `postgres ${redact(databaseUrl)}` };
  }

  const turso = env.TURSO_DATABASE_URL?.trim();
  if (turso) {
    return {
      backend: 'libsql-remote',
      url: turso,
      authToken: env.TURSO_AUTH_TOKEN?.trim() || undefined,
      describe: `libsql ${redact(turso)}`,
    };
  }

  const file = 'file:./mastra.db';
  return { backend: 'libsql-file', url: file, describe: `sqlite ${file}` };
}

/**
 * Build the Mastra storage instance for the resolved target.
 *
 * Dynamically imported so the Postgres driver is never loaded in a local SQLite
 * run (and vice versa) — keeps cold start down and avoids requiring a driver
 * you are not using.
 */
export async function createMastraStorage(target: StorageTarget = resolveStorageTarget()) {
  if (target.backend === 'postgres') {
    const { PostgresStore } = await import('@mastra/pg');
    return new PostgresStore({ id: 'mastra-storage', connectionString: target.url });
  }

  const { LibSQLStore } = await import('@mastra/libsql');
  return new LibSQLStore({ id: 'mastra-storage', url: target.url, authToken: target.authToken });
}
