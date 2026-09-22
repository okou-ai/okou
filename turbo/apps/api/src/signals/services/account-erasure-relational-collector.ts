import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import {
  assertErasureSourceCaptured,
  setErasureFenceDeadlines,
  type ErasureHandler,
  type ErasureLease,
  type ErasureProof,
  type ErasureSubject,
  type ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import {
  ACCOUNT_OWNERSHIP_INVENTORY,
  userOwnedErasureRoots,
} from "./account-erasure-ownership-inventory";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";

type Db = NodePgDatabase<Record<string, never>>;
type Executor = Db | Tx;

/** Tables in `public` that are not application data. They carry no account
 * rows, so the ownership inventory deliberately does not describe them.
 */
const NON_APPLICATION_TABLES = ["__drizzle_migrations"] as const;

const MAX_PLANNED_TABLES = 512;

const catalogueTableSchema = z.object({ table_name: z.string().min(1) });
// The two column lists are positional pairs. Enforcing equal length at the
// decode boundary turns a misaligned join key into a parse failure instead of
// a `DELETE` matched on the wrong column.
const foreignKeySchema = z
  .object({
    child: z.string().min(1),
    parent: z.string().min(1),
    child_columns: z.array(z.string().min(1)).min(1),
    parent_columns: z.array(z.string().min(1)).min(1),
    on_delete: z.enum(["a", "r", "c", "n", "d"]),
  })
  .refine(
    (row) => {
      return row.child_columns.length === row.parent_columns.length;
    },
    { error: "foreign key column lists are not positional pairs" },
  );
const rowCountSchema = z.object({ rows: z.number().int().nonnegative() });
const columnTypeSchema = z.object({
  table_name: z.string().min(1),
  column_name: z.string().min(1),
  type_name: z.string().min(1),
});

// An Okou account id is Clerk text. A column of any other type cannot hold
// one, so a root declaring it must be reached through the row it references.
const ACCOUNT_ID_TYPES = [
  "text",
  "character varying",
  "character",
  "name",
] as const;

function isAccountIdType(type: string | undefined): boolean {
  return (
    type !== undefined &&
    ACCOUNT_ID_TYPES.some((candidate) => {
      return candidate === type;
    })
  );
}

/** A catalogue foreign key, with the column pairs that join child to parent. */
export interface RelationalForeignKey {
  readonly child: string;
  readonly parent: string;
  readonly childColumns: readonly string[];
  readonly parentColumns: readonly string[];
  /** `pg_constraint.confdeltype`: `a` no action, `r` restrict, `c` cascade,
   * `n` set null, `d` set default.
   */
  readonly onDelete: "a" | "r" | "c" | "n" | "d";
}

/** Only a key the server will refuse to violate constrains deletion order.
 *
 * A cascading key deletes the child for us and a nulling key rewrites it, so
 * neither requires the child to go first. Treating every key as an ordering
 * constraint is what made `chat_threads`, `agents`, `agent_runs` and
 * `agent_sessions` look mutually blocked when the catalogue never said so.
 */
function ordersDeletion(key: RelationalForeignKey): boolean {
  return key.onDelete === "a" || key.onDelete === "r";
}

/** How one root reaches the account.
 *
 * `direct` is the ordinary case: the column holds the account id. `indirect`
 * covers a column that references a link row instead — `agentphone_user_links`
 * and the two Telegram link tables are keyed by uuid, so the account is one
 * hop away and the sweep must join rather than compare.
 */
export type RelationalErasureOwner =
  | { readonly kind: "direct"; readonly column: string }
  | {
      readonly kind: "indirect";
      readonly column: string;
      readonly parent: string;
      readonly parentColumn: string;
      readonly parentOwnership: readonly string[];
    };

export interface RelationalErasureRoot {
  readonly table: string;
  readonly owners: readonly RelationalErasureOwner[];
}

export interface RelationalErasurePlan {
  /** Account-owned roots, every root ordered before the roots it references. */
  readonly order: readonly RelationalErasureRoot[];
  /** Declared descendants reachable through a parent root's ownership. */
  readonly descendants: readonly RelationalForeignKey[];
  /** Declared descendants with no catalogue foreign key to any declared
   * parent. Nothing in this sink can prove those rows are gone, so they are
   * reported as an explicit residual rather than silently omitted.
   */
  readonly unreachableDescendants: readonly string[];
  /** Roots whose declared ownership column can hold no account id and has no
   * resolvable link to a root that does. The sweep cannot reach them, so they
   * are reported rather than swept on a predicate that never matches.
   */
  readonly unreachableRoots: readonly string[];
  /** Root-to-root keys that rewrite a surviving row instead of deleting it.
   * Deleting this account's rows nulls or defaults a column on rows that may
   * belong to another account, which is the schema's declared behaviour rather
   * than a choice the sweep makes, but it is a cross-account effect and is
   * reported rather than left for somebody to discover.
   */
  readonly rewritingEdges: readonly RelationalForeignKey[];
  /** Root pairs that reference each other through keys the server will refuse
   * to violate, so no single order satisfies both. A cascading or nulling key
   * is not one of these.
   */
  readonly cycles: readonly (readonly [string, string])[];
}

/** Every base table the database actually has in `public`.
 *
 * `pg_class` rather than a TypeScript export: a table reaches production
 * through a migration whether or not any module mentions it, and this sink
 * deletes from the database rather than from the schema barrel.
 */
export async function catalogueTables(db: Executor): Promise<string[]> {
  const rows = await executeRawRows(
    db,
    sql`SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    catalogueTableSchema,
  );
  return rows
    .map((row) => {
      return row.table_name;
    })
    .filter((name) => {
      return !NON_APPLICATION_TABLES.some((ignored) => {
        return ignored === name;
      });
    });
}

/** Cross-table foreign keys in `public`, with their joining columns.
 *
 * Self-references are excluded: a table that points at itself constrains rows
 * inside one delete, not the order two tables are deleted in.
 *
 * The column names are aggregated with `json_agg`, not `array_agg`. A
 * PostgreSQL array comes back from the driver as its text literal
 * (`{job_id,sink_id}`), so consuming it would mean parsing array syntax —
 * quoting, embedded commas, escapes and NULLs — on a path that ends in a
 * `DELETE`. A quoting defect there would silently resolve the wrong column
 * name, while `json_agg` returns a value the driver has already parsed.
 *
 * `ORDER BY k.ord` stays *inside* each aggregate. The two lists are positional
 * pairs, so dropping it would still parse cleanly and still align child to
 * parent by aggregation order, which is unspecified: a loud type error would
 * become a silently mismatched join key.
 */
export async function catalogueForeignKeys(
  db: Executor,
): Promise<RelationalForeignKey[]> {
  const rows = await executeRawRows(
    db,
    sql`SELECT child.relname AS child,
               parent.relname AS parent,
               (SELECT json_agg(a.attname ORDER BY k.ord)
                  FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a
                    ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
                 AS child_columns,
               (SELECT json_agg(a.attname ORDER BY k.ord)
                  FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a
                    ON a.attrelid = con.confrelid AND a.attnum = k.attnum)
                 AS parent_columns,
               con.confdeltype::text AS on_delete
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_class parent ON parent.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = child.relnamespace
        WHERE con.contype = 'f'
          AND n.nspname = 'public'
          AND con.conrelid <> con.confrelid
        ORDER BY child.relname, parent.relname, con.conname`,
    foreignKeySchema,
  );
  return rows.map((row) => {
    return {
      child: row.child,
      parent: row.parent,
      childColumns: row.child_columns,
      parentColumns: row.parent_columns,
      onDelete: row.on_delete,
    };
  });
}

/** The declared type of every ownership column the inventory names. */
async function ownershipColumnTypes(
  db: Executor,
): Promise<Map<string, string>> {
  const rows = await executeRawRows(
    db,
    sql`SELECT c.relname AS table_name,
               a.attname AS column_name,
               format_type(a.atttypid, NULL) AS type_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT a.attisdropped
        ORDER BY c.relname, a.attname`,
    columnTypeSchema,
  );
  const types = new Map<string, string>();
  for (const row of rows) {
    types.set(`${row.table_name}.${row.column_name}`, row.type_name);
  }
  return types;
}

/** Fails when the live database and the ownership inventory disagree.
 *
 * The inventory's own guard compares against the schema modules and the
 * migration ledger. This is the third and final source: what the server
 * reports it actually has. A table present here and absent there would be
 * deleted from by nothing, which is the September 12 defect.
 */
export async function assertCatalogueInventoryCoverage(
  db: Executor,
): Promise<void> {
  const tables = await catalogueTables(db);
  for (const table of tables) {
    if (!(table in ACCOUNT_OWNERSHIP_INVENTORY)) {
      throw new Error(
        `account_erasure_relational:catalogue_uncovered:${table}`,
      );
    }
  }
  const present = new Set(tables);
  for (const table of Object.keys(ACCOUNT_OWNERSHIP_INVENTORY)) {
    if (!present.has(table)) {
      throw new Error(`account_erasure_relational:catalogue_absent:${table}`);
    }
  }
}

function topologicalRootOrder(
  tables: readonly string[],
  keys: readonly RelationalForeignKey[],
): { readonly order: string[]; readonly cycles: [string, string][] } {
  // Precedence: a referencing root must be deleted before the root it
  // references, so `child -> parent` is the precedence edge and a parent waits
  // for every root child that points at it.
  const pending = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const table of tables) {
    pending.set(table, new Set());
    dependents.set(table, new Set());
  }
  for (const key of keys) {
    if (!ordersDeletion(key)) {
      continue;
    }
    const waiting = pending.get(key.parent);
    const onwards = dependents.get(key.child);
    if (!waiting || !onwards) {
      continue;
    }
    waiting.add(key.child);
    onwards.add(key.parent);
  }
  const ready = [...pending.entries()]
    .filter((entry) => {
      return entry[1].size === 0;
    })
    .map((entry) => {
      return entry[0];
    })
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift();
    if (table === undefined) {
      break;
    }
    order.push(table);
    for (const parent of [...(dependents.get(table) ?? [])].sort()) {
      const waiting = pending.get(parent);
      if (!waiting) {
        continue;
      }
      waiting.delete(table);
      if (waiting.size === 0) {
        // Keep the frontier sorted so one catalogue yields exactly one order.
        ready.push(parent);
        ready.sort();
      }
    }
  }
  // A cycle between two roots has no order satisfying both directions. Report
  // the exact pairs and append the members by name: an unreported cycle would
  // be a silent guess about which side is safe to delete first.
  const placed = new Set(order);
  const cycles: [string, string][] = [];
  for (const table of [...pending.keys()].sort()) {
    if (placed.has(table)) {
      continue;
    }
    for (const child of [...(pending.get(table) ?? [])].sort()) {
      if (!placed.has(child)) {
        cycles.push([child, table]);
      }
    }
    order.push(table);
    placed.add(table);
  }
  return { order, cycles };
}

/** Derives what an account's relational sweep must delete, and in what order.
 *
 * Order is derived, never declared. A hand-written order rots the moment
 * somebody adds a foreign key, and discovering the order by retrying failed
 * deletes would make correctness emerge from a retry budget.
 */
export async function planRelationalErasure(
  db: Executor,
): Promise<RelationalErasurePlan> {
  await assertCatalogueInventoryCoverage(db);
  const roots = userOwnedErasureRoots();
  if (roots.length === 0 || roots.length > MAX_PLANNED_TABLES) {
    throw new Error("account_erasure_relational:root_limit");
  }
  const declared = new Map(
    roots.map((root) => {
      return [root.table, root.ownership];
    }),
  );
  const keys = await catalogueForeignKeys(db);
  const types = await ownershipColumnTypes(db);

  function directColumns(table: string): string[] {
    return (declared.get(table) ?? []).filter((column) => {
      return isAccountIdType(types.get(`${table}.${column}`));
    });
  }

  // A uuid ownership column cannot hold a Clerk account id: it references a
  // link row. Resolve that hop from the catalogue so the sweep joins instead
  // of comparing, and report a column with no resolvable hop rather than
  // sweeping it on a predicate that silently never matches.
  const ownership = new Map<string, RelationalErasureOwner[]>();
  const unreachableRoots: string[] = [];
  for (const root of roots) {
    const owners: RelationalErasureOwner[] = [];
    for (const column of root.ownership) {
      if (isAccountIdType(types.get(`${root.table}.${column}`))) {
        owners.push({ kind: "direct", column });
        continue;
      }
      const edge = keys.find((key) => {
        return (
          key.child === root.table &&
          key.childColumns.length === 1 &&
          key.childColumns[0] === column &&
          directColumns(key.parent).length > 0
        );
      });
      const parentColumn = edge?.parentColumns[0];
      if (!edge || parentColumn === undefined) {
        continue;
      }
      owners.push({
        kind: "indirect",
        column,
        parent: edge.parent,
        parentColumn,
        parentOwnership: directColumns(edge.parent),
      });
    }
    if (owners.length === 0) {
      unreachableRoots.push(root.table);
      continue;
    }
    ownership.set(root.table, owners);
  }

  // Every declared descendant is swept through a real foreign key to one of
  // its declared parents. A cascade usually does it, but relying on the
  // cascade would leave a descendant whose foreign key is `NO ACTION` behind.
  const descendants: RelationalForeignKey[] = [];
  const unreachableDescendants: string[] = [];
  for (const [table, entry] of Object.entries(ACCOUNT_OWNERSHIP_INVENTORY)) {
    if (entry.coverage !== "user_descendant") {
      continue;
    }
    const edges = keys.filter((key) => {
      return key.child === table && entry.parents.includes(key.parent);
    });
    if (edges.length === 0) {
      unreachableDescendants.push(table);
      continue;
    }
    descendants.push(...edges);
  }

  const reachable = roots
    .filter((root) => {
      return ownership.has(root.table);
    })
    .map((root) => {
      return root.table;
    });
  const { order, cycles } = topologicalRootOrder(reachable, keys);
  const planned = new Set(reachable);
  const rewritingEdges = keys.filter((key) => {
    return (
      (key.onDelete === "n" || key.onDelete === "d") &&
      planned.has(key.child) &&
      planned.has(key.parent)
    );
  });
  return {
    order: order.map((table) => {
      return { table, owners: ownership.get(table) ?? [] };
    }),
    descendants,
    unreachableDescendants: unreachableDescendants.sort(),
    unreachableRoots: unreachableRoots.sort(),
    rewritingEdges,
    cycles,
  };
}

/** Fails while any part of the account's relational graph is unreachable.
 *
 * `unreachableRoots` and `unreachableDescendants` are rows this sink cannot
 * reach from the subject, so a sweep that ran anyway would leave them and a
 * residual read that skipped them would report clean. Segment 3's verification
 * calls this before it may claim erasure, so the gap blocks a completion claim
 * instead of hiding inside one.
 */
export function assertRelationalSweepComplete(
  plan: RelationalErasurePlan,
): void {
  const [root] = plan.unreachableRoots;
  if (root !== undefined) {
    throw new Error(`account_erasure_relational:root_unreachable:${root}`);
  }
  const [descendant] = plan.unreachableDescendants;
  if (descendant !== undefined) {
    throw new Error(
      `account_erasure_relational:descendant_unreachable:${descendant}`,
    );
  }
}

function subjectPredicate(root: RelationalErasureRoot, id: string) {
  return sql.join(
    root.owners.map((owner) => {
      const column = sql`${sql.identifier(root.table)}.${sql.identifier(owner.column)}`;
      if (owner.kind === "direct") {
        return sql`${column} = ${id}`;
      }
      const linked = sql.join(
        owner.parentOwnership.map((parentColumn) => {
          return sql`${sql.identifier(owner.parent)}.${sql.identifier(parentColumn)} = ${id}`;
        }),
        sql` OR `,
      );
      return sql`${column} IN (
        SELECT ${sql.identifier(owner.parent)}.${sql.identifier(owner.parentColumn)}
        FROM ${sql.identifier(owner.parent)}
        WHERE ${linked}
      )`;
    }),
    sql` OR `,
  );
}

async function subjectRowCount(
  db: Executor,
  root: RelationalErasureRoot,
  subjectId: string,
): Promise<number> {
  const [row] = await executeRawRows(
    db,
    sql`SELECT COUNT(*)::int AS rows
        FROM ${sql.identifier(root.table)}
        WHERE ${subjectPredicate(root, subjectId)}`,
    rowCountSchema,
  );
  return row?.rows ?? 0;
}

/** Relational rows still attributed to the subject, per root.
 *
 * This is the relational half of the contract only. Object absence, revoked
 * public and credential access, remote terminal results and remaining derived
 * copies belong to the object, provider and recovery sinks, so an empty result
 * here is not account erasure and must never be reported as one.
 */
export async function relationalErasureResidual(
  db: Executor,
  subject: ErasureSubject,
  plan: RelationalErasurePlan,
): Promise<{ readonly table: string; readonly rows: number }[]> {
  const residual: { table: string; rows: number }[] = [];
  for (const root of plan.order) {
    const rows = await subjectRowCount(db, root, subject.subjectId);
    if (rows > 0) {
      residual.push({ table: root.table, rows });
    }
  }
  return residual;
}

// Immutable v1 namespace. Names are JSON tuples, never concatenation, so two
// different reference inputs cannot collide on one string.
const RELATIONAL_NAMESPACE = "6f5d2a90-5a1e-4c6a-9b6f-1d0c8a4b7e33";

/** The sink's collector version. `executeErasureWork` refuses to run a handler
 * whose version does not equal the registered sink's `collectorVersion`, so
 * this changes whenever the sweep's observable behaviour changes.
 */
export const RELATIONAL_ERASURE_COLLECTOR_VERSION =
  "b1c7e4d2-3f80-4a19-8d5e-2c9f6a0b4517";

// The fence's own deadlines. A sweep waits for admission behind the exclusive
// subject lock, so its lock timeout is the fence's, not a route's.
const FENCE_DEADLINES = {
  lockTimeout: "5s",
  statementTimeout: "120s",
} as const;

function reference(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), RELATIONAL_NAMESPACE);
}

// `clock_timestamp()` arrives as text on this path, so the observation time is
// rendered as an explicit UTC ISO-8601 string and parsed, rather than relying
// on a driver type parser that does not apply to a raw execute.
const observedAtSchema = z.object({
  observed_at: z
    .string()
    .transform((value) => {
      return new Date(value);
    })
    .pipe(z.date()),
});
const readerSchema = z.object({ reader: z.string().min(1) });

/** What the sweep needs from its lease to prove it is still the current,
 * sealed capture of this job before it touches a business row.
 */
export interface RelationalSweepBinding {
  readonly jobId: string;
  readonly generation: number;
  readonly captureRevision: number;
  readonly inventoryRevision: number;
  readonly producerBoundaryRef: string;
  readonly required: readonly {
    readonly sinkId: string;
    readonly itemKey: string;
  }[];
}

/** Deletes the account's relational graph in one transaction.
 *
 * `assertErasureSourceCaptured` runs first and owns the fence: it takes the
 * exclusive subject advisory lock, then the job row, and verifies the job is
 * the current generation, sealed at this capture revision, bound to this
 * producer boundary, with every required selector captured. Only then does a
 * business row get touched, which keeps D1's lock order — advisory keys, then
 * job, then business rows — and holds all of it through COMMIT.
 *
 * One transaction, not one per table. Deleting a root while a sibling root
 * still references it has to be atomic, and the closed subject means no writer
 * is admitted to race it. The sweep is also idempotent, so a statement timeout
 * on an unusually large account re-runs and finds less work rather than
 * needing a resume cursor.
 */
export async function sweepRelationalErasure(
  db: Db,
  subject: ErasureSubject,
  binding: RelationalSweepBinding,
  plan: RelationalErasurePlan,
): Promise<number> {
  return await db.transaction(async (tx) => {
    await setErasureFenceDeadlines(tx, FENCE_DEADLINES);
    await assertErasureSourceCaptured(
      tx,
      subject,
      binding.jobId,
      {
        generation: binding.generation,
        captureRevision: binding.captureRevision,
        inventoryRevision: binding.inventoryRevision,
        producerBoundaryRef: binding.producerBoundaryRef,
      },
      binding.required,
    );
    let deleted = 0;
    for (const root of plan.order) {
      const owned = subjectPredicate(root, subject.subjectId);
      for (const edge of plan.descendants) {
        if (edge.parent !== root.table) {
          continue;
        }
        const childKey = sql.join(
          edge.childColumns.map((column) => {
            return sql.identifier(column);
          }),
          sql`, `,
        );
        const parentKey = sql.join(
          edge.parentColumns.map((column) => {
            return sql.identifier(column);
          }),
          sql`, `,
        );
        // Swept through the key explicitly, not left to a cascade: a declared
        // descendant whose key is `NO ACTION` would otherwise stay behind.
        deleted +=
          (
            await tx.execute(
              sql`DELETE FROM ${sql.identifier(edge.child)}
                  WHERE (${childKey}) IN (
                    SELECT ${parentKey} FROM ${sql.identifier(root.table)}
                    WHERE ${owned}
                  )`,
            )
          ).rowCount ?? 0;
      }
      deleted +=
        (
          await tx.execute(
            sql`DELETE FROM ${sql.identifier(root.table)} WHERE ${owned}`,
          )
        ).rowCount ?? 0;
    }
    return deleted;
  });
}

function enumerationReference(plan: RelationalErasurePlan): string {
  return reference([
    "relational-enumeration",
    RELATIONAL_ERASURE_COLLECTOR_VERSION,
    plan.order.map((root) => {
      return [root.table, root.owners];
    }),
    plan.descendants.map((edge) => {
      return [edge.child, edge.parent, edge.childColumns, edge.parentColumns];
    }),
  ]);
}

function requestReference(
  lease: ErasureLease,
  outcome: "erased" | "empty",
): string {
  return reference([
    "relational-erase",
    lease.jobId,
    lease.item.sinkId,
    lease.item.itemKey,
    lease.captureRevision,
    outcome,
  ]);
}

async function leaseSubject(
  db: Db,
  lease: ErasureLease,
): Promise<ErasureSubject | undefined> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  // A relational sink is keyed by the subject itself. The fence revalidates it
  // against the job, so a selector naming another account cannot be swept.
  return selector.kind === "subject"
    ? { subjectKind: selector.subjectKind, subjectId: selector.subjectId }
    : undefined;
}

const unresolved = (
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved => {
  return { outcome, errorCode, requestRef: null };
};

/** Residual verification for the relational sink.
 *
 * Extracted from the handler so the completeness gate, the residual read
 * and the proof it constructs are one reviewable unit.
 */
async function verifyRelationalErasure(
  db: Db,
  plan: RelationalErasurePlan,
  lease: ErasureLease,
  producerBoundary: string,
): Promise<ErasureProof | ErasureUnresolved> {
  // Rows this sink cannot reach are not rows it may report clean. The gate
  // is here rather than inside a `catch`, so the outcome is a typed
  // disposition rather than an exception the engine has to interpret.
  if (
    plan.unreachableRoots.length > 0 ||
    plan.unreachableDescendants.length > 0
  ) {
    return unresolved("ownership_unknown");
  }
  const subject = await leaseSubject(db, lease);
  if (!subject) {
    return unresolved("selector_missing");
  }
  const residual = await relationalErasureResidual(db, subject, plan);
  if (residual.length > 0) {
    return unresolved("verification_failed", "retryable_failure");
  }
  const [reader] = await executeRawRows(
    db,
    sql`SELECT current_user AS reader`,
    readerSchema,
  );
  const [observed] = await executeRawRows(
    db,
    sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at`,
    observedAtSchema,
  );
  if (!reader || !observed) {
    return unresolved("verification_failed", "retryable_failure");
  }
  return {
    workId: lease.workId,
    sinkId: lease.item.sinkId,
    generation: lease.generation,
    captureRevision: lease.captureRevision,
    inventoryRevision: lease.inventoryRevision,
    producerBoundaryRef: producerBoundary,
    outcome:
      lease.item.requestRef === requestReference(lease, "erased")
        ? "verified_erased"
        : "verified_no_applicable_data",
    evidenceRef: reference([
      "relational-residual",
      lease.jobId,
      lease.item.itemKey,
      lease.captureRevision,
      plan.order.map((root) => {
        return root.table;
      }),
    ]),
    authenticatedReaderRef: reference([
      "relational-reader",
      RELATIONAL_ERASURE_COLLECTOR_VERSION,
      reader.reader,
    ]),
    enumerationRef: enumerationReference(plan),
    observedAt: observed.observed_at,
  };
}

/** The relational sink's handler.
 *
 * The plan is supplied rather than derived per call: it is one catalogue read
 * per job, and a caller that recomputed it between `erase` and `verify` could
 * verify a different set of roots than it deleted.
 */
export function createRelationalErasureCollector(
  db: Db,
  plan: RelationalErasurePlan,
): ErasureHandler {
  return {
    version: RELATIONAL_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor) => {
      const subject = await leaseSubject(db, lease);
      if (!subject) {
        return unresolved("selector_missing");
      }
      if (cursor !== null) {
        // The relational graph is one bounded enumeration derived from the
        // catalogue, so there is no page to resume from.
        return unresolved("verification_failed", "retryable_failure");
      }
      const item = {
        sinkId: lease.item.sinkId,
        itemKey: reference([
          "relational-item",
          subject.subjectKind,
          subject.subjectId,
        ]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "subject",
          subjectKind: subject.subjectKind,
          subjectId: subject.subjectId,
        }),
        dependencies: [],
      };
      return {
        pageKey: reference([
          "relational-page",
          lease.jobId,
          lease.captureRevision,
        ]),
        inputCursorDigest: lease.item.cursorDigest,
        nextCursor: null,
        enumerationRef: enumerationReference(plan),
        items: [item],
      };
    },
    erase: async (lease) => {
      const subject = await leaseSubject(db, lease);
      if (!subject) {
        return unresolved("selector_missing");
      }
      const boundary = lease.producerBoundaryRef;
      if (boundary === null) {
        return unresolved("boundary_unproven");
      }
      const deleted = await sweepRelationalErasure(
        db,
        subject,
        {
          jobId: lease.jobId,
          generation: lease.generation,
          captureRevision: lease.captureRevision,
          inventoryRevision: lease.inventoryRevision,
          producerBoundaryRef: boundary,
          required: [
            { sinkId: lease.item.sinkId, itemKey: lease.item.itemKey },
          ],
        },
        plan,
      );
      return {
        requestRef: requestReference(lease, deleted > 0 ? "erased" : "empty"),
      };
    },
    verify: async (lease, producerBoundary) => {
      return await verifyRelationalErasure(db, plan, lease, producerBoundary);
    },
  };
}
