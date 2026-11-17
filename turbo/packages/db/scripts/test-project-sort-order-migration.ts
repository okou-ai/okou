import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { array } from "zod";
import {
  projectSchema,
  projectEventSchema,
} from "@okouai/api-contracts/validators/projects";
import { replayProjectEvents } from "@okouai/core/project-event-replay";
import {
  compareProjectSortOrder,
  lastProjectSortOrder,
  projectSortOrder,
} from "@okouai/core/project-sort-order";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required; use an owned disposable PostgreSQL cluster",
  );
}
const database = `project_sort_migration_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString });
const url = new URL(connectionString);
url.pathname = `/${database}`;
const client = new Client({ connectionString: url.toString() });
const migration = async (name: string) => {
  return readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
};
const projectQuery = `SELECT id,name,sort_order AS "sortOrder",to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt" FROM projects WHERE user_id='owner' AND org_id='org' ORDER BY created_at,id`;

await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${database}`);
  await client.connect();
  await client.query("SET timezone='UTC'");
  // Replay the actual outgoing Project migration with only its unrelated Thread
  // dependencies stubbed. Fixtures retain sub-millisecond ordering and ID ties.
  await client.query(
    "CREATE TYPE chat_thread_event_kind AS ENUM ('created'); CREATE TABLE chat_threads(id uuid PRIMARY KEY,user_id text NOT NULL); CREATE TABLE chat_thread_events(id uuid PRIMARY KEY)",
  );
  for (const statement of (
    await migration("1510_project_reader_preparation")
  ).split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
  const earlier = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const later = "00000000-0000-4000-8000-000000000001";
  const tied = "00000000-0000-4000-8000-000000000002";
  await client.query(
    `INSERT INTO projects(id,user_id,org_id,name,created_at,updated_at) VALUES
    ($1,'owner','org','Earlier','2026-11-17 12:00:00.000001','2026-11-17 12:00:00'),
    ($2,'owner','org','Later','2026-11-17 12:00:00.000002','2026-11-17 12:00:00'),
    ($3,'owner','org','Tied','2026-11-17 12:00:00.000002','2026-11-17 12:00:00'),
    ($4,'colleague','org','Colleague','2026-11-17','2026-11-17'),
    ($5,'owner','elsewhere','Elsewhere','2026-11-17','2026-11-17')`,
    [earlier, later, tied, randomUUID(), randomUUID()],
  );
  await client.query(
    "INSERT INTO project_event_sequences(user_id,org_id,last_seq_id) VALUES ('owner','org',7)",
  );
  const snapshotId = randomUUID();
  await client.query(
    "INSERT INTO project_snapshots(user_id,org_id,latest_event_id,latest_event_seq_id,object_key,content_digest) VALUES ('owner','org',$1,7,'old-immutable-object','old-digest')",
    [snapshotId],
  );
  const original = array(projectSchema).parse(
    (await client.query(projectQuery.replace('sort_order AS "sortOrder",', "")))
      .rows,
  );
  await client.query(await migration("1569_project_sort_order"));
  const backfill = await migration("1570_backfill_project_sort_order");
  // The event insertion failure must roll back ranks and sequence reservations.
  await client.query(
    "ALTER TABLE project_events ADD CONSTRAINT reject_sort_fixture CHECK (kind <> 'sort_updated')",
  );
  await assert.rejects(client.query(backfill), { code: "23514" });
  assert.deepEqual(
    array(projectSchema)
      .parse((await client.query(projectQuery)).rows)
      .map((project) => {
        return project.sortOrder;
      }),
    [null, null, null],
  );
  assert.equal(
    (
      await client.query(
        "SELECT last_seq_id::int AS seq FROM project_event_sequences WHERE user_id='owner' AND org_id='org'",
      )
    ).rows[0]?.seq,
    7,
  );
  await client.query(
    "ALTER TABLE project_events DROP CONSTRAINT reject_sort_fixture",
  );
  await client.query(backfill);
  const persisted = array(projectSchema).parse(
    (await client.query(projectQuery)).rows,
  );
  const events = array(projectEventSchema).parse(
    (
      await client.query(
        `SELECT id,seq_id::int AS "seqId",project_id AS "projectId",kind,name,sort_order AS "sortOrder",to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt" FROM project_events WHERE user_id='owner' AND org_id='org' AND seq_id>7 ORDER BY seq_id`,
      )
    ).rows,
  );
  assert.deepEqual(
    events.map((event) => {
      return event.seqId;
    }),
    [8, 9, 10],
  );
  assert.deepEqual(
    persisted.map((project) => {
      return project.id;
    }),
    [earlier, later, tied],
  );
  assert.ok(
    persisted.every((project) => {
      return (
        project.sortOrder && lastProjectSortOrder([project]) > project.sortOrder
      );
    }),
  );
  assert.deepEqual(replayProjectEvents(original, events), persisted);
  assert.deepEqual(
    (
      await client.query(
        "SELECT latest_event_id,latest_event_seq_id::int,object_key,content_digest FROM project_snapshots WHERE user_id='owner' AND org_id='org'",
      )
    ).rows,
    [
      {
        latest_event_id: snapshotId,
        latest_event_seq_id: 7,
        object_key: "old-immutable-object",
        content_digest: "old-digest",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT user_id,org_id,seq_id::int FROM project_events WHERE user_id<>'owner' OR org_id<>'org' ORDER BY user_id,org_id",
      )
    ).rows,
    [
      { user_id: "colleague", org_id: "org", seq_id: 1 },
      { user_id: "owner", org_id: "elsewhere", seq_id: 1 },
    ],
  );
  // Frozen outgoing writer remains legal after migration. Its nullable rank uses
  // the shared historical fallback; a new API tail must include that key.
  const outgoingId = randomUUID();
  await client.query(
    "INSERT INTO projects(id,user_id,org_id,name) VALUES($1,'owner','org','Outgoing API')",
    [outgoingId],
  );
  const mixed = array(projectSchema).parse(
    (await client.query(projectQuery)).rows,
  );
  const outgoing = mixed.find((project) => {
    return project.id === outgoingId;
  });
  assert.ok(outgoing);
  assert.equal(outgoing.sortOrder, null);
  assert.equal([...mixed].sort(compareProjectSortOrder).at(-1)?.id, outgoingId);
  assert.ok(lastProjectSortOrder(mixed) > projectSortOrder(outgoing));
  console.log(
    "Project sort migration: atomic rollback, exact historical order, owner sequences, snapshot replay equality, nullable outgoing writer and effective tail passed",
  );
} finally {
  await client.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
}
