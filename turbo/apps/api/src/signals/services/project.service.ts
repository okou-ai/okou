import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { command, computed } from "ccstate";
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { array, boolean, number, object, uuid } from "zod";
import { projects } from "@okouai/db/schema/project";
import { projectEvents } from "@okouai/db/schema/project-event";
import {
  projectSchema,
  type Project,
} from "@okouai/api-contracts/contracts/projects";
import {
  compareProjectSortOrder,
  lastProjectSortOrder,
  moveProjectSortOrder,
  projectSortOrder,
} from "@okouai/core/project-sort-order";
import { isFreshProjectOperation } from "@okouai/core/project-operation-id";
import { now } from "../../lib/time";
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
    return rows
      .map((row) => {
        return {
          id: row.id,
          name: row.name,
          sortOrder: row.sortOrder,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      })
      .sort(compareProjectSortOrder);
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
          sortOrder: row.sortOrder,
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
  readonly kind: "created" | "renamed" | "deleted" | "sort_updated";
  readonly id: string;
  readonly eventId: string;
  readonly name?: string;
  readonly fromThreadId?: string;
  readonly targetId?: string;
  readonly side?: "before" | "after";
};
const scopeSql = (owner: ProjectOwner) => {
  return sql`p.user_id = ${owner.userId} AND p.org_id = ${owner.orgId}`;
};

function validProjectMutation(input: ProjectMutation) {
  return (
    isFreshProjectOperation(input.eventId, now()) &&
    (input.kind !== "created" || input.id === input.eventId)
  );
}

function receiptMatches(
  owner: ProjectOwner,
  input: ProjectMutation,
  receipt: typeof projectEvents.$inferSelect,
) {
  return (
    receipt.userId === owner.userId &&
    receipt.orgId === owner.orgId &&
    receipt.projectId === input.id &&
    receipt.kind === input.kind &&
    receipt.fromThreadId === (input.fromThreadId ?? null) &&
    receipt.reorderTargetId === (input.targetId ?? null) &&
    receipt.reorderSide === (input.side ?? null) &&
    (input.kind === "deleted" ||
      input.kind === "sort_updated" ||
      receipt.name === input.name)
  );
}

function projectChangeSql(
  owner: ProjectOwner,
  input: ProjectMutation,
  ranks: readonly { projectId: string; sortOrder: string }[],
  tail: string | null,
  threadGate: SQL,
) {
  return input.kind === "created"
    ? sql`INSERT INTO projects (id,user_id,org_id,name,sort_order) SELECT ${input.id}::uuid,${owner.userId},${owner.orgId},${input.name},${tail} FROM reserved WHERE ${threadGate} AND (${input.fromThreadId ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM detached)) RETURNING id,name,sort_order`
    : input.kind === "renamed"
      ? sql`UPDATE projects p SET name=${input.name},updated_at=timezone('UTC',now()) WHERE p.id=${input.id}::uuid AND ${scopeSql(owner)} AND EXISTS(SELECT 1 FROM reserved) RETURNING id,name,sort_order`
      : input.kind === "deleted"
        ? sql`DELETE FROM projects p WHERE p.id=${input.id}::uuid AND ${scopeSql(owner)} AND EXISTS(SELECT 1 FROM reserved) AND (SELECT count(*) FROM detached)>=0 RETURNING id,name,sort_order`
        : sql`UPDATE projects p SET sort_order=v.sort_order,updated_at=timezone('UTC',now()) FROM (VALUES ${sql.join(
            ranks.map((rank) => {
              return sql`(${rank.projectId}::uuid,${rank.sortOrder}::text)`;
            }),
            sql`,`,
          )}) AS v(id,sort_order) WHERE p.id=v.id AND ${scopeSql(owner)} AND EXISTS(SELECT 1 FROM reserved) RETURNING p.id,p.name,p.sort_order`;
}

function projectMutationStatement(
  owner: ProjectOwner,
  input: ProjectMutation,
  captured: { projects: Project[]; seq: number },
  threadGate: SQL,
) {
  const ranks =
    input.kind === "sort_updated" && input.targetId && input.side
      ? moveProjectSortOrder(
          captured.projects,
          input.id,
          input.targetId,
          input.side,
        )
      : [];
  // A move that is already satisfied still publishes its operation receipt.
  // This also lets optimistic clients settle the exact request event identity.
  if (input.kind === "sort_updated" && ranks.length === 0) {
    const moved = captured.projects.find((project) => {
      return project.id === input.id;
    });
    if (!moved) {
      throw new Error("Project move baseline is missing");
    }
    ranks.push({ projectId: moved.id, sortOrder: projectSortOrder(moved) });
  }
  const tail =
    input.kind === "created" ? lastProjectSortOrder(captured.projects) : null;
  const reservation = sql`INSERT INTO project_event_sequences(user_id,org_id,last_seq_id)
      VALUES (${owner.userId},${owner.orgId},${Math.max(1, ranks.length)})
      ON CONFLICT(user_id,org_id) DO UPDATE
      SET last_seq_id=project_event_sequences.last_seq_id+EXCLUDED.last_seq_id
      WHERE project_event_sequences.last_seq_id=${captured.seq}
      RETURNING last_seq_id`;
  const change = projectChangeSql(owner, input, ranks, tail, threadGate);
  const detach =
    input.kind === "deleted"
      ? sql`UPDATE chat_threads t SET project_id=NULL,updated_at=timezone('UTC',now()) WHERE t.project_id=${input.id}::uuid AND EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND ${scopeSql(owner)}) AND EXISTS(SELECT 1 FROM reserved) RETURNING t.id`
      : sql`UPDATE chat_threads t SET project_id=${input.id}::uuid,updated_at=timezone('UTC',now()) WHERE t.id=${input.fromThreadId ?? null}::uuid AND t.user_id=${owner.userId} AND ${threadGate} AND EXISTS(SELECT 1 FROM reserved) RETURNING t.id`;
  const threadEventId =
    input.kind === "created"
      ? sql`${input.eventId}::uuid`
      : sql`gen_random_uuid()`;
  const detachedCte =
    input.kind !== "renamed" && input.kind !== "sort_updated"
      ? sql`detached AS (${detach}), changed AS (${change})`
      : sql`changed AS (${change}), detached AS (${detach})`;
  const membership =
    input.kind === "deleted" ? sql`NULL::uuid` : sql`${input.id}::uuid`;
  return sql`WITH reserved AS (${reservation}), ${detachedCte},
      thread_reserved AS (INSERT INTO chat_thread_event_sequences (user_id,org_id,last_seq_id)
        SELECT ${owner.userId},${owner.orgId},count(*) FROM detached HAVING count(*)>0
        ON CONFLICT (user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+EXCLUDED.last_seq_id RETURNING last_seq_id),
      thread_published AS (INSERT INTO chat_thread_events(id,user_id,org_id,seq_id,chat_thread_id,kind,project_id)
        SELECT ${threadEventId},${owner.userId},${owner.orgId},r.last_seq_id-(SELECT count(*) FROM detached)+row_number() OVER(ORDER BY d.id),d.id,'project_updated',${membership}
        FROM detached d CROSS JOIN thread_reserved r RETURNING id),
      published AS (INSERT INTO project_events(id,user_id,org_id,seq_id,project_id,kind,name,sort_order,from_thread_id,reorder_target_id,reorder_side)
        SELECT CASE WHEN c.id=${input.id}::uuid THEN ${input.eventId}::uuid ELSE gen_random_uuid() END,
          ${owner.userId},${owner.orgId},r.last_seq_id-${Math.max(1, ranks.length)}+row_number() OVER(ORDER BY (c.id<>${input.id}::uuid),c.id),
          c.id,${input.kind}::project_event_kind,c.name,c.sort_order,${input.fromThreadId ?? null}::uuid,
          ${input.targetId ?? null}::uuid,${input.side ?? null}::text
        FROM changed c CROSS JOIN reserved r RETURNING project_id)
      SELECT EXISTS(SELECT 1 FROM published) AS written, EXISTS(SELECT 1 FROM reserved) AS reserved`;
}

function projectMutationAvailability(
  input: ProjectMutation,
  captured: { validThread: boolean; projects: Project[] },
): "missing" | "conflict" | null {
  if (
    !captured.validThread ||
    (input.kind !== "created" &&
      !captured.projects.some((project) => {
        return project.id === input.id;
      })) ||
    (input.kind === "sort_updated" &&
      !captured.projects.some((project) => {
        return project.id === input.targetId;
      }))
  ) {
    return "missing";
  }
  return input.kind === "sort_updated" &&
    (input.targetId === input.id || !input.targetId || !input.side)
    ? "conflict"
    : null;
}

/** Receipt insertion has no conflict-ignore: a raced duplicate rolls back every CTE. */
export const mutateProject$ = command(
  async (
    { get, set },
    owner: ProjectOwner,
    input: ProjectMutation,
    signal: AbortSignal,
  ): Promise<"written" | "missing" | "conflict"> => {
    if (!validProjectMutation(input)) {
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
      return receiptMatches(owner, input, receipt) ? "written" : "conflict";
    }
    const threadGate =
      input.fromThreadId === undefined
        ? sql`true`
        : sql`EXISTS (SELECT 1 FROM chat_threads t WHERE t.id=${input.fromThreadId}::uuid AND t.user_id=${owner.userId} AND t.org_id=${owner.orgId})`;
    // Capture the ordering and its event fence together. The existing owner
    // sequence arbitrates publication; stale calculations never mutate rows.
    const [captured] = parseRawRows(
      object({
        projects: array(projectSchema),
        seq: number(),
        validThread: boolean(),
      }),
      await get(rawSqlReadDb$).execute(sql`
        SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id',p.id,'name',p.name,'sortOrder',p.sort_order,
          'createdAt',to_char(p.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'updatedAt',to_char(p.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
          FROM projects p WHERE ${scopeSql(owner)}),'[]'::jsonb) AS projects,
        COALESCE((SELECT last_seq_id::float8 FROM project_event_sequences
          WHERE user_id=${owner.userId} AND org_id=${owner.orgId}),0) AS seq,
        ${threadGate} AS "validThread"`),
    );
    signal.throwIfAborted();
    if (!captured) {
      throw new Error("Project ordering capture is missing");
    }
    const unavailable = projectMutationAvailability(input, captured);
    if (unavailable) {
      return unavailable;
    }
    const outcome = await settle(
      (async () => {
        return parseRawRows(
          object({ written: boolean(), reserved: boolean() }),
          await set(writeDb$).execute(
            projectMutationStatement(owner, input, captured, threadGate),
          ),
        );
      })(),
      signal,
    );
    if (outcome.ok) {
      const result = outcome.value[0];
      if (result?.written) {
        return "written";
      }
      if (result?.reserved) {
        return "missing";
      }
      // Another identical request may have won the sequence CAS. Resolve its
      // receipt rather than rejecting a successfully committed duplicate.
    } else {
      const error = outcome.error;
      if (safeSqlStateCode(error) === "23503") {
        return input.kind === "deleted" ? "conflict" : "missing";
      }
      if (safeSqlStateCode(error) !== "23505") {
        throw error;
      }
    }
    const [accepted] = await read
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.id, input.eventId));
    signal.throwIfAborted();
    return accepted && receiptMatches(owner, input, accepted)
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
      UPDATE chat_threads t SET project_id=${input.projectId}::uuid,updated_at=timezone('UTC',now())
      WHERE t.id=${input.threadId}::uuid AND t.user_id=${owner.userId} AND t.org_id=${owner.orgId}
      AND (${input.projectId}::uuid IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=${input.projectId}::uuid AND ${scopeSql(owner)})) RETURNING t.id),
      reserved AS (INSERT INTO chat_thread_event_sequences(user_id,org_id,last_seq_id) SELECT ${owner.userId},${owner.orgId},1 FROM changed
        ON CONFLICT(user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+1 RETURNING last_seq_id),
      published AS (INSERT INTO chat_thread_events(id,user_id,org_id,seq_id,chat_thread_id,kind,project_id)
        SELECT ${input.eventId}::uuid,${owner.userId},${owner.orgId},r.last_seq_id,c.id,'project_updated',${input.projectId}::uuid FROM changed c CROSS JOIN reserved r RETURNING chat_thread_id)
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
