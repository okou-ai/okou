import { settle } from "../utils";
import { command, computed } from "ccstate";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { object, uuid } from "zod";
import { projects } from "@okouai/db/schema/project";
import { projectEvents } from "@okouai/db/schema/project-event";
import { type Project } from "@okouai/api-contracts/contracts/projects";
import { isFreshProjectOperation } from "@okouai/core/project-operation-id";
import { now } from "../../lib/time";
import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";
import { parseRawRows } from "../../lib/db-raw-rows";
import { safeSqlStateCode } from "../../lib/pg-errors";

export interface ProjectOwner {
  readonly userId: string;
  readonly orgId: string;
}
export function projectList(owner: ProjectOwner) {
  return computed(async (get): Promise<Project[]> => {
    const rows = await get(db$)
      .select()
      .from(projects)
      .where(
        and(eq(projects.userId, owner.userId), eq(projects.orgId, owner.orgId)),
      )
      .orderBy(asc(projects.createdAt), asc(projects.id));
    return rows.map((row) => {
      return {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  });
}
export function projectById(owner: ProjectOwner, id: string) {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, id),
          eq(projects.userId, owner.userId),
          eq(projects.orgId, owner.orgId),
        ),
      );
    return row
      ? {
          id: row.id,
          name: row.name,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }
      : null;
  });
}
export function projectEventsAfter(owner: ProjectOwner, since: number) {
  return computed(async (get) => {
    const rows = await get(db$)
      .select()
      .from(projectEvents)
      .where(
        and(
          eq(projectEvents.userId, owner.userId),
          eq(projectEvents.orgId, owner.orgId),
          gt(projectEvents.seqId, since),
        ),
      )
      .orderBy(asc(projectEvents.seqId))
      .limit(1001);
    return {
      events: rows.slice(0, 1000).map((row) => {
        return { ...row, createdAt: row.createdAt.toISOString() };
      }),
      hasMore: rows.length > 1000,
    };
  });
}

const changedRow = object({ id: uuid() });
type ProjectMutation = {
  readonly kind: "created" | "renamed" | "deleted";
  readonly id: string;
  readonly eventId: string;
  readonly name?: string;
  readonly fromThreadId?: string;
};
const scopeSql = (owner: ProjectOwner) => {
  return sql`p.user_id = ${owner.userId} AND p.org_id = ${owner.orgId}`;
};

/** Receipt insertion has no conflict-ignore: a raced duplicate rolls back every CTE. */
export const mutateProject$ = command(
  async (
    { get, set },
    owner: ProjectOwner,
    input: ProjectMutation,
    signal: AbortSignal,
  ): Promise<"written" | "missing" | "conflict"> => {
    if (
      !isFreshProjectOperation(input.eventId, now()) ||
      (input.kind === "created" && input.id !== input.eventId)
    ) {
      return "conflict";
    }
    const read = get(db$);
    const existing = await read
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.id, input.eventId));
    signal.throwIfAborted();
    const receipt = existing[0];
    if (receipt) {
      return receipt.userId === owner.userId &&
        receipt.orgId === owner.orgId &&
        receipt.projectId === input.id &&
        receipt.kind === input.kind &&
        receipt.fromThreadId === (input.fromThreadId ?? null) &&
        (input.kind === "deleted" || receipt.name === input.name)
        ? "written"
        : "conflict";
    }
    signal.throwIfAborted();
    const threadGate =
      input.fromThreadId === undefined
        ? sql`true`
        : sql`EXISTS (SELECT 1 FROM chat_threads t JOIN agents a ON a.id=t.agent_id WHERE t.id=${input.fromThreadId}::uuid AND t.user_id=${owner.userId} AND a.org_id=${owner.orgId})`;
    const change =
      input.kind === "created"
        ? sql`INSERT INTO projects (id,user_id,org_id,name) SELECT ${input.id}::uuid,${owner.userId},${owner.orgId},${input.name} WHERE ${threadGate} AND (${input.fromThreadId ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM detached)) RETURNING id,name`
        : input.kind === "renamed"
          ? sql`UPDATE projects p SET name=${input.name},updated_at=timezone('UTC',now()) WHERE p.id=${input.id}::uuid AND ${scopeSql(owner)} RETURNING id,name`
          : sql`DELETE FROM projects p WHERE p.id=${input.id}::uuid AND ${scopeSql(owner)} AND (SELECT count(*) FROM detached)>=0 RETURNING id,name`;
    const detach =
      input.kind === "deleted"
        ? sql`UPDATE chat_threads t SET project_id=NULL,updated_at=timezone('UTC',now()) WHERE t.project_id=${input.id}::uuid AND EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND ${scopeSql(owner)}) RETURNING t.id,t.agent_id`
        : sql`UPDATE chat_threads t SET project_id=${input.id}::uuid,updated_at=timezone('UTC',now()) WHERE t.id=${input.fromThreadId ?? null}::uuid AND t.user_id=${owner.userId} AND ${threadGate} RETURNING t.id,t.agent_id`;
    const threadEventId =
      input.kind === "created"
        ? sql`${input.eventId}::uuid`
        : sql`gen_random_uuid()`;
    const detachedCte =
      input.kind !== "renamed"
        ? sql`detached AS (${detach}), changed AS (${change})`
        : sql`changed AS (${change}), detached AS (${detach})`;
    const membership =
      input.kind === "deleted" ? sql`NULL::uuid` : sql`${input.id}::uuid`;
    const outcome = await settle(
      (async () => {
        return parseRawRows(
          changedRow,
          await set(writeDb$).execute(sql`WITH ${detachedCte},
      thread_reserved AS (INSERT INTO chat_thread_event_sequences (user_id,org_id,last_seq_id)
        SELECT ${owner.userId},${owner.orgId},count(*) FROM detached HAVING count(*)>0
        ON CONFLICT (user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+EXCLUDED.last_seq_id RETURNING last_seq_id),
      thread_published AS (INSERT INTO chat_thread_events(id,user_id,org_id,seq_id,chat_thread_id,agent_id,kind,project_id)
        SELECT ${threadEventId},${owner.userId},${owner.orgId},r.last_seq_id-(SELECT count(*) FROM detached)+row_number() OVER(ORDER BY d.id),d.id,d.agent_id,'project_updated',${membership}
        FROM detached d CROSS JOIN thread_reserved r RETURNING id),
      reserved AS (INSERT INTO project_event_sequences (user_id,org_id,last_seq_id) SELECT ${owner.userId},${owner.orgId},1 FROM changed
        ON CONFLICT(user_id,org_id) DO UPDATE SET last_seq_id=project_event_sequences.last_seq_id+1 RETURNING last_seq_id),
      published AS (INSERT INTO project_events(id,user_id,org_id,seq_id,project_id,kind,name,from_thread_id)
        SELECT ${input.eventId}::uuid,${owner.userId},${owner.orgId},r.last_seq_id,c.id,${input.kind}::project_event_kind,c.name,${input.fromThreadId ?? null}::uuid FROM changed c CROSS JOIN reserved r RETURNING project_id)
      SELECT project_id AS id FROM published`),
        );
      })(),
      signal,
    );
    if (outcome.ok) {
      return outcome.value.length ? "written" : "missing";
    }
    const error = outcome.error;
    if (safeSqlStateCode(error) === "23503") {
      return input.kind === "deleted" ? "conflict" : "missing";
    }
    if (safeSqlStateCode(error) !== "23505") {
      throw error;
    }
    const [accepted] = await read
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.id, input.eventId));
    signal.throwIfAborted();
    return accepted &&
      accepted.userId === owner.userId &&
      accepted.orgId === owner.orgId &&
      accepted.projectId === input.id &&
      accepted.kind === input.kind &&
      accepted.fromThreadId === (input.fromThreadId ?? null) &&
      (input.kind === "deleted" || accepted.name === input.name)
      ? "written"
      : "conflict";
  },
);

const memberRow = object({ threadId: uuid(), projectId: uuid().nullable() });
export const setProjectMembership$ = command(
  async (
    { get, set },
    owner: ProjectOwner,
    input: {
      readonly threadId: string;
      readonly projectId: string | null;
      readonly eventId: string;
    },
    signal: AbortSignal,
  ): Promise<"written" | "missing" | "conflict"> => {
    if (!isFreshProjectOperation(input.eventId, now())) {
      return "conflict";
    }
    const read = get(rawSqlReadDb$);
    const accepted = await read.execute(
      sql`SELECT chat_thread_id AS "threadId",project_id AS "projectId" FROM chat_thread_events WHERE id=${input.eventId}::uuid AND user_id=${owner.userId} AND org_id=${owner.orgId} AND kind='project_updated'`,
    );
    signal.throwIfAborted();
    const receipt = parseRawRows(memberRow, accepted)[0];
    if (receipt) {
      return receipt.threadId === input.threadId &&
        receipt.projectId === input.projectId
        ? "written"
        : "conflict";
    }
    const outcome = await settle(
      (async () => {
        return parseRawRows(
          changedRow,
          await set(writeDb$).execute(sql`WITH changed AS (
      UPDATE chat_threads t SET project_id=${input.projectId}::uuid,updated_at=timezone('UTC',now()) FROM agents a
      WHERE t.id=${input.threadId}::uuid AND t.user_id=${owner.userId} AND t.agent_id=a.id AND a.org_id=${owner.orgId}
      AND (${input.projectId}::uuid IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=${input.projectId}::uuid AND ${scopeSql(owner)})) RETURNING t.id,t.agent_id),
      reserved AS (INSERT INTO chat_thread_event_sequences(user_id,org_id,last_seq_id) SELECT ${owner.userId},${owner.orgId},1 FROM changed
        ON CONFLICT(user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+1 RETURNING last_seq_id),
      published AS (INSERT INTO chat_thread_events(id,user_id,org_id,seq_id,chat_thread_id,agent_id,kind,project_id)
        SELECT ${input.eventId}::uuid,${owner.userId},${owner.orgId},r.last_seq_id,c.id,c.agent_id,'project_updated',${input.projectId}::uuid FROM changed c CROSS JOIN reserved r RETURNING chat_thread_id)
      SELECT chat_thread_id AS id FROM published`),
        );
      })(),
      signal,
    );
    if (outcome.ok) {
      return outcome.value.length ? "written" : "missing";
    }
    const error = outcome.error;
    if (safeSqlStateCode(error) === "23503") {
      return "missing";
    }
    if (safeSqlStateCode(error) !== "23505") {
      throw error;
    }
    const [row] = parseRawRows(
      memberRow,
      await read.execute(
        sql`SELECT chat_thread_id AS "threadId",project_id AS "projectId" FROM chat_thread_events WHERE id=${input.eventId}::uuid AND user_id=${owner.userId} AND org_id=${owner.orgId} AND kind='project_updated'`,
      ),
    );
    return row &&
      row.threadId === input.threadId &&
      row.projectId === input.projectId
      ? "written"
      : "conflict";
  },
);
