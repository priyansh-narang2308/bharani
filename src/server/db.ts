import { PGlite } from "@electric-sql/pglite";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
};

function wrap(q: Queryable, root: PGlite): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await q.query<T>(sql, params)).rows;
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
    tx: (fn) => root.transaction((t) => fn(wrap(t as unknown as Queryable, root))),
    close: () => root.close(),
  };
}

export const SCHEMA = `
create table if not exists events (
  seq bigserial primary key,
  id text unique not null,
  type text not null,
  at text not null,
  actor text not null,
  evidence text[] not null default '{}',
  body jsonb not null,
  recorded_at timestamptz not null default now()
);
create table if not exists evidence (
  id text primary key,
  kind text not null,
  sha256 text unique not null,
  party text not null,
  content text,
  created_at timestamptz not null default now()
);
create table if not exists drafts (
  id text primary key,
  evidence_id text not null references evidence(id),
  party text not null,
  status text not null check (status in ('pending','accepted','discarded')),
  draft jsonb not null,
  events jsonb not null,
  warnings jsonb not null,
  extractor jsonb not null,
  decided_by text,
  created_at timestamptz not null default now()
);
create table if not exists investigations (
  id text primary key,
  flagged text[] not null,
  reason text not null,
  state text not null,
  opened_by text not null,
  closed_by text,
  created_at timestamptz not null default now()
);
create table if not exists agent_steps (
  investigation_id text not null references investigations(id),
  step_key text not null,
  status text not null check (status in ('running','done','failed')),
  output jsonb,
  attempts int not null default 0,
  error text,
  updated_at timestamptz not null default now(),
  primary key (investigation_id, step_key)
);
create table if not exists notices (
  id text primary key,
  investigation_id text not null references investigations(id),
  recipient text not null,
  channel text not null,
  body text not null,
  facts jsonb not null,
  body_hash text not null
);
create table if not exists approvals (
  id text primary key,
  investigation_id text not null references investigations(id),
  action text not null,
  notice_ids text[] not null,
  payload_hash text not null,
  status text not null check (status in ('pending','approved','rejected')),
  decided_by text,
  decided_at timestamptz
);
create table if not exists outbox (
  idem_key text primary key,
  approval_id text not null references approvals(id),
  notice_id text not null references notices(id),
  status text not null check (status in ('queued','sent','failed')),
  attempts int not null default 0,
  last_error text,
  external_ref text
);
create table if not exists receipts (
  external_ref text not null,
  kind text not null,
  received_count int not null default 1,
  first_at timestamptz not null default now(),
  primary key (external_ref, kind)
);
create table if not exists audit (
  seq bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  subject text,
  outcome text not null,
  detail jsonb not null default '{}'
);
`;

/** Opens the embedded Postgres. With a directory it persists across restarts. */
export async function openDb(dataDir?: string): Promise<Db> {
  const pg = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
  await pg.exec(SCHEMA);
  return wrap(pg as unknown as Queryable, pg);
}
