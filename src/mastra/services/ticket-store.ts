/**
 * Ticket persistence.
 *
 * Tools call this interface; they never see a driver, a connection string or a
 * dialect. Swapping SQLite for Postgres is DATABASE_URL only. Swapping either
 * for a real tracker (Linear, Jira) means adding an adapter here and changing
 * nothing in agents/, tools/ or workflows/.
 */
import { resolveStorageTarget, type StorageTarget } from '../config/storage';
import { logger } from '../config/logger';

export interface TicketInput {
  readonly title: string;
  readonly body: string;
  readonly severity: 'sev1' | 'sev2' | 'sev3';
  readonly team: string;
  readonly sourceDocIds: readonly string[];
}

export interface Ticket extends TicketInput {
  readonly id: string;
  readonly createdAt: string;
}

export interface TicketStore {
  init(): Promise<void>;
  create(input: TicketInput): Promise<Ticket>;
  get(id: string): Promise<Ticket | undefined>;
  list(limit?: number): Promise<Ticket[]>;
  close(): Promise<void>;
}

function newTicketId(): string {
  // Short, sortable, human-quotable in a support thread.
  return `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LibSQL / SQLite adapter
// ─────────────────────────────────────────────────────────────────────────────

class LibSqlTicketStore implements TicketStore {
  #client?: import('@libsql/client').Client;
  #ready?: Promise<void>;

  constructor(private readonly target: StorageTarget) {}

  async #connect() {
    if (!this.#client) {
      const { createClient } = await import('@libsql/client');
      this.#client = createClient({ url: this.target.url, authToken: this.target.authToken });
    }
    return this.#client;
  }

  init(): Promise<void> {
    this.#ready ??= (async () => {
      const client = await this.#connect();
      await client.execute(`
        CREATE TABLE IF NOT EXISTS tickets (
          id            TEXT PRIMARY KEY,
          title         TEXT NOT NULL,
          body          TEXT NOT NULL,
          severity      TEXT NOT NULL,
          team          TEXT NOT NULL,
          source_doc_ids TEXT NOT NULL,
          created_at    TEXT NOT NULL
        )
      `);
    })();
    return this.#ready;
  }

  async create(input: TicketInput): Promise<Ticket> {
    await this.init();
    const client = await this.#connect();
    const ticket: Ticket = { ...input, id: newTicketId(), createdAt: new Date().toISOString() };
    await client.execute({
      sql: `INSERT INTO tickets (id, title, body, severity, team, source_doc_ids, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ticket.id,
        ticket.title,
        ticket.body,
        ticket.severity,
        ticket.team,
        JSON.stringify(ticket.sourceDocIds),
        ticket.createdAt,
      ],
    });
    return ticket;
  }

  async get(id: string): Promise<Ticket | undefined> {
    await this.init();
    const client = await this.#connect();
    const res = await client.execute({ sql: 'SELECT * FROM tickets WHERE id = ?', args: [id] });
    const row = res.rows[0];
    return row ? rowToTicket(row as Record<string, unknown>) : undefined;
  }

  async list(limit = 50): Promise<Ticket[]> {
    await this.init();
    const client = await this.#connect();
    const res = await client.execute({
      sql: 'SELECT * FROM tickets ORDER BY created_at DESC LIMIT ?',
      args: [limit],
    });
    return res.rows.map((r) => rowToTicket(r as Record<string, unknown>));
  }

  async close(): Promise<void> {
    this.#client?.close();
    this.#client = undefined;
    this.#ready = undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Postgres adapter
// ─────────────────────────────────────────────────────────────────────────────

class PostgresTicketStore implements TicketStore {
  #pool?: import('pg').Pool;
  #ready?: Promise<void>;

  constructor(private readonly target: StorageTarget) {}

  async #connect() {
    if (!this.#pool) {
      const { Pool } = await import('pg');
      this.#pool = new Pool({ connectionString: this.target.url });
    }
    return this.#pool;
  }

  init(): Promise<void> {
    this.#ready ??= (async () => {
      const pool = await this.#connect();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
          id             TEXT PRIMARY KEY,
          title          TEXT NOT NULL,
          body           TEXT NOT NULL,
          severity       TEXT NOT NULL,
          team           TEXT NOT NULL,
          source_doc_ids JSONB NOT NULL,
          created_at     TIMESTAMPTZ NOT NULL
        )
      `);
    })();
    return this.#ready;
  }

  async create(input: TicketInput): Promise<Ticket> {
    await this.init();
    const pool = await this.#connect();
    const ticket: Ticket = { ...input, id: newTicketId(), createdAt: new Date().toISOString() };
    await pool.query(
      `INSERT INTO tickets (id, title, body, severity, team, source_doc_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ticket.id,
        ticket.title,
        ticket.body,
        ticket.severity,
        ticket.team,
        JSON.stringify(ticket.sourceDocIds),
        ticket.createdAt,
      ],
    );
    return ticket;
  }

  async get(id: string): Promise<Ticket | undefined> {
    await this.init();
    const pool = await this.#connect();
    const res = await pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
    return res.rows[0] ? rowToTicket(res.rows[0]) : undefined;
  }

  async list(limit = 50): Promise<Ticket[]> {
    await this.init();
    const pool = await this.#connect();
    const res = await pool.query('SELECT * FROM tickets ORDER BY created_at DESC LIMIT $1', [limit]);
    return res.rows.map(rowToTicket);
  }

  async close(): Promise<void> {
    await this.#pool?.end();
    this.#pool = undefined;
    this.#ready = undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

function rowToTicket(row: Record<string, unknown>): Ticket {
  const raw = row.source_doc_ids;
  let sourceDocIds: string[] = [];
  if (Array.isArray(raw)) sourceDocIds = raw as string[];
  else if (typeof raw === 'string') {
    try {
      sourceDocIds = JSON.parse(raw) as string[];
    } catch {
      sourceDocIds = [];
    }
  }

  const createdAt = row.created_at;
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    severity: String(row.severity) as Ticket['severity'],
    team: String(row.team),
    sourceDocIds,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  };
}

let singleton: TicketStore | undefined;

/** Process-wide ticket store for the resolved backend. */
export function getTicketStore(): TicketStore {
  if (!singleton) {
    const target = resolveStorageTarget();
    logger.info('ticket store initialised', { backend: target.backend, target: target.describe });
    singleton = target.backend === 'postgres' ? new PostgresTicketStore(target) : new LibSqlTicketStore(target);
  }
  return singleton;
}

/** Test seam. */
export function setTicketStore(store: TicketStore | undefined): void {
  singleton = store;
}
