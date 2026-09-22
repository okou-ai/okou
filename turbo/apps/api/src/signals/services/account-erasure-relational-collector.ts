import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import {
  ACCOUNT_OWNERSHIP_INVENTORY,
  userOwnedErasureRoots,
} from "./account-erasure-ownership-inventory";

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
  /** Root pairs that reference each other, so no single order satisfies both. */
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
                 AS parent_columns
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
  return {
    order: order.map((table) => {
      return { table, owners: ownership.get(table) ?? [] };
    }),
    descendants,
    unreachableDescendants: unreachableDescendants.sort(),
    unreachableRoots: unreachableRoots.sort(),
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
