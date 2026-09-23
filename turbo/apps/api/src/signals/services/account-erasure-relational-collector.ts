import { sql, type SQL } from "drizzle-orm";
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
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import { releaseDeletedConversationReferences } from "./conversation-history-deletion.service";
import {
  ACCOUNT_OWNERSHIP_INVENTORY,
  DESCENDANT_REACH,
  UNATTRIBUTABLE_DESCENDANTS,
  userOwnedErasureRoots,
  type DescendantReachHop,
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
const presenceSchema = z.object({ present: z.boolean() });
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

/** One join step of a descendant path, resolved against the live catalogue. */
export interface RelationalDescendantHop {
  readonly childColumns: readonly string[];
  readonly parent: string;
  readonly parentColumns: readonly string[];
}

/** How the sweep reaches one declared descendant from the root that names the
 * account.
 *
 * `catalogue` paths are a single foreign key the server enforces. `declared`
 * paths come from `DESCENDANT_REACH`, where the schema deliberately declines
 * the key — a durable receipt, a retryable cleanup intent or a projection has
 * to outlive its producer — and `basis` records why the join key is still
 * right. Both are the same shape so the sweep has one code path, and a path
 * may be longer than one hop when the only key lands on an intermediate that
 * is itself a descendant.
 */
export interface RelationalDescendantPath {
  readonly child: string;
  /** The account-owned root the path terminates at. */
  readonly root: string;
  /** Ordered child to root. `hops[0].childColumns` are columns on `child`. */
  readonly hops: readonly RelationalDescendantHop[];
  readonly source: "catalogue" | "declared";
  readonly basis: string | null;
}

export interface RelationalErasurePlan {
  /** Account-owned roots, every root ordered before the roots it references. */
  readonly order: readonly RelationalErasureRoot[];
  /** Declared descendants reachable through a parent root's ownership, ordered
   * so every path runs before the tables it joins through still lose their
   * rows.
   */
  readonly descendants: readonly RelationalDescendantPath[];
  /** Declared descendants with neither a catalogue foreign key to a declared
   * parent nor a declared reach, plus any whose paths join through each other
   * so that no single order satisfies them all. Nothing in this sink can prove
   * those rows are gone, so they are reported as an explicit residual rather
   * than silently omitted.
   */
  readonly unreachableDescendants: readonly string[];
  /** Declared descendants whose account attribution does not exist in the
   * schema at all, listed with their basis in `UNATTRIBUTABLE_DESCENDANTS`.
   * Separated from `unreachableDescendants` because the remedy is a schema
   * change rather than a selector, but it blocks a completion claim the same
   * way: the rows hold account data and no join identifies whose.
   */
  readonly unattributableDescendants: readonly string[];
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

/** Whether the live catalogue has every column a declared reach names.
 *
 * `ownershipColumnTypes` reads `pg_attribute`, so a column present there is a
 * column the server actually has. The inventory guard checks the declaration
 * against the schema modules; this checks it against the database, which is
 * the same two-source rule `assertCatalogueInventoryCoverage` applies to
 * tables. A reach that fails here is reported as unreachable rather than
 * emitted as a `DELETE` on a column that does not exist.
 */
function catalogueResolves(
  child: string,
  path: readonly DescendantReachHop[],
  types: ReadonlyMap<string, string>,
): boolean {
  let below = child;
  for (const hop of path) {
    const resolved =
      hop.childColumns.length === hop.parentColumns.length &&
      hop.childColumns.every((column) => {
        return types.has(`${below}.${column}`);
      }) &&
      hop.parentColumns.every((column) => {
        return types.has(`${hop.parent}.${column}`);
      });
    if (!resolved) {
      return false;
    }
    below = hop.parent;
  }
  return path.length > 0;
}

/** Resolves every declared descendant to the paths the sweep can delete it by.
 *
 * A catalogue foreign key to a declared parent is the ordinary case. Where the
 * schema deliberately declines the key, the inventory's declared reach supplies
 * the same join with a recorded basis, and it is only trusted as far as the
 * catalogue confirms it: every column it names must exist on the table it
 * names, or the descendant stays unreachable rather than becoming a `DELETE`
 * on a column the server does not have.
 */
function resolveDescendantPaths(
  keys: readonly RelationalForeignKey[],
  types: ReadonlyMap<string, string>,
): {
  readonly descendants: RelationalDescendantPath[];
  readonly unreachable: string[];
  readonly unattributable: string[];
} {
  const descendants: RelationalDescendantPath[] = [];
  const unreachable: string[] = [];
  const unattributable: string[] = [];
  for (const [table, entry] of Object.entries(ACCOUNT_OWNERSHIP_INVENTORY)) {
    if (entry.coverage !== "user_descendant") {
      continue;
    }
    if (table in UNATTRIBUTABLE_DESCENDANTS) {
      unattributable.push(table);
      continue;
    }
    const resolved: RelationalDescendantPath[] = keys
      .filter((key) => {
        return key.child === table && entry.parents.includes(key.parent);
      })
      .map((key) => {
        return {
          child: table,
          root: key.parent,
          hops: [
            {
              childColumns: key.childColumns,
              parent: key.parent,
              parentColumns: key.parentColumns,
            },
          ],
          source: "catalogue" as const,
          basis: null,
        };
      });
    for (const reach of DESCENDANT_REACH[table] ?? []) {
      const last = reach.path[reach.path.length - 1];
      if (!last || !catalogueResolves(table, reach.path, types)) {
        continue;
      }
      resolved.push({
        child: table,
        root: last.parent,
        hops: reach.path,
        source: "declared",
        basis: reach.basis,
      });
    }
    if (resolved.length === 0) {
      unreachable.push(table);
      continue;
    }
    descendants.push(...resolved);
  }
  return { descendants, unreachable, unattributable };
}

/** Deterministic order for the paths of one descendant table. */
function compareDescendantPaths(
  left: RelationalDescendantPath,
  right: RelationalDescendantPath,
): number {
  return (
    left.root.localeCompare(right.root) ||
    left.source.localeCompare(right.source) ||
    right.hops.length - left.hops.length
  );
}

/** The order the descendant phase deletes in, derived from the join graph.
 *
 * A path longer than one hop joins through an intermediate table, and when
 * that intermediate is itself a descendant its rows are deleted by a path of
 * its own. Deleting the intermediate first leaves the path through it matching
 * nothing, which is a silent under-delete rather than an error.
 *
 * Hop count does not decide this. A table's own reach is declared
 * independently of the paths that traverse it, so nothing makes an
 * intermediate's path the shorter one; ordering by length would be a fact
 * about today's catalogue rather than an invariant. Precedence is therefore
 * derived the way `topologicalRootOrder` derives the root order: a path's
 * child must be deleted before every table that path joins through. The
 * terminal root is not one of those, because roots are deleted afterwards.
 *
 * A cycle has no order that satisfies every path through it. Its members are
 * returned rather than emitted in an arbitrary order, so the sweep skips them
 * and the completeness gate refuses the claim instead of guessing.
 */
function orderDescendantPaths(paths: readonly RelationalDescendantPath[]): {
  readonly ordered: RelationalDescendantPath[];
  readonly cycles: string[];
} {
  interface DescendantGroup {
    readonly child: string;
    readonly paths: RelationalDescendantPath[];
    readonly blockedBy: Set<string>;
    readonly blocking: Set<DescendantGroup>;
  }
  const groups = new Map<string, DescendantGroup>();
  for (const path of paths) {
    const group = groups.get(path.child);
    if (group) {
      group.paths.push(path);
      continue;
    }
    groups.set(path.child, {
      child: path.child,
      paths: [path],
      blockedBy: new Set(),
      blocking: new Set(),
    });
  }
  for (const group of groups.values()) {
    for (const path of group.paths) {
      for (const hop of path.hops.slice(0, -1)) {
        // A hop parent that is not a descendant is a root or a table erasure
        // never deletes, so it constrains nothing here.
        const intermediate = groups.get(hop.parent);
        if (!intermediate || intermediate === group) {
          continue;
        }
        intermediate.blockedBy.add(group.child);
        group.blocking.add(intermediate);
      }
    }
  }
  const byChild = (left: DescendantGroup, right: DescendantGroup): number => {
    return left.child.localeCompare(right.child);
  };
  const ready = [...groups.values()]
    .filter((group) => {
      return group.blockedBy.size === 0;
    })
    .sort(byChild);
  const ordered: RelationalDescendantPath[] = [];
  const placed = new Set<string>();
  while (ready.length > 0) {
    const group = ready.shift();
    if (group === undefined) {
      break;
    }
    ordered.push(...[...group.paths].sort(compareDescendantPaths));
    placed.add(group.child);
    for (const next of [...group.blocking].sort(byChild)) {
      next.blockedBy.delete(group.child);
      if (next.blockedBy.size === 0) {
        // Keep the frontier sorted so one catalogue yields exactly one order.
        ready.push(next);
        ready.sort(byChild);
      }
    }
  }
  return {
    ordered,
    cycles: [...groups.values()]
      .filter((group) => {
        return !placed.has(group.child);
      })
      .map((group) => {
        return group.child;
      })
      .sort(),
  };
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

  const { descendants, unreachable, unattributable } = resolveDescendantPaths(
    keys,
    types,
  );
  const sweep = orderDescendantPaths(descendants);

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
  // Additive attribution columns do not identify rows written before the new
  // producers shipped. Neither a recipient address nor a Feishu installation
  // alone proves account ownership. Until every legacy row is attributed or
  // separately remediated, block all completion claims rather than allowing a
  // root/descendant sweep to silently ignore its NULL owner key.
  const [legacyEmail] = await executeRawRows(
    db,
    sql`SELECT EXISTS (
      SELECT 1 FROM email_outbox WHERE owner_user_id IS NULL
    ) AS present`,
    presenceSchema,
  );
  const [legacyFeishu] = await executeRawRows(
    db,
    sql`SELECT EXISTS (
      SELECT 1 FROM feishu_chat_ingress WHERE sender_open_id IS NULL
    ) AS present`,
    presenceSchema,
  );
  const legacyUnattributed = [
    ...(legacyEmail?.present ? ["email_outbox"] : []),
    ...(legacyFeishu?.present ? ["feishu_chat_ingress"] : []),
  ];
  return {
    order: order.map((table) => {
      return { table, owners: ownership.get(table) ?? [] };
    }),
    descendants: sweep.ordered,
    unreachableDescendants: [...unreachable, ...sweep.cycles].sort(),
    unattributableDescendants: [
      ...unattributable,
      ...legacyUnattributed,
    ].sort(),
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
  // A descendant whose account attribution does not exist in the schema is
  // still a descendant this sink cannot prove clean. It gets its own code so
  // the remedy is legible — a schema change, not another selector — but it
  // blocks a completion claim exactly as an unreachable one does.
  const [unattributable] = plan.unattributableDescendants;
  if (unattributable !== undefined) {
    throw new Error(
      `account_erasure_relational:descendant_unattributable:${unattributable}`,
    );
  }
}

function subjectPredicate(root: RelationalErasureRoot, id: string) {
  const owner = sql.join(
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
  // The durable user.deleted task is the executor's control record. Erasing
  // it inside its own sweep loses the lease before the worker can verify and
  // complete the B1 job. Other background work remains account-owned.
  return root.table === "background_jobs"
    ? sql`(${owner}) AND ${sql.identifier(root.table)}.${sql.identifier("kind")} <> 'clerk-user-deletion'`
    : owner;
}

/** The descendant's own membership test, built from the path's hops.
 *
 * One nested `IN` per hop, innermost first, so the deepest subquery is the
 * root's ownership predicate and each enclosing level selects the key column
 * of the row above. A single-hop catalogue path renders exactly the statement
 * this sink issued before paths existed.
 */
function descendantPredicate(path: RelationalDescendantPath, owned: SQL): SQL {
  const columns = (names: readonly string[]): SQL => {
    return sql.join(
      names.map((name) => {
        return sql.identifier(name);
      }),
      sql`, `,
    );
  };
  let predicate = owned;
  for (const hop of [...path.hops].reverse()) {
    predicate = sql`(${columns(hop.childColumns)}) IN (
      SELECT ${columns(hop.parentColumns)} FROM ${sql.identifier(hop.parent)}
      WHERE ${predicate}
    )`;
  }
  return predicate;
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
 *
 * Roots only, and that is structural rather than an omission. A descendant is
 * attributed by joining up to a root the sweep has already deleted, so the
 * same read after the sweep can only ever return zero and would assert
 * nothing. What protects a descendant is the completeness gate, which refuses
 * a claim while any of them is unreachable.
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
  "a296ba1a-e288-4ad9-9238-29ad0ab2e36e";

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

/** The catalog has no foreign keys to its five sources. Remove projections
 * while every source row is still present, including rows the generic sweep
 * will delete through a parent cascade. A catalog author can differ from the
 * source owner, so filtering `artifacts.author_user_id` is insufficient.
 *
 * Lock in the projector's order: generated media before its file, and a site
 * before its presentation. Projectors that started before the sweep then
 * finish before this deletion; projectors that start later see the source gone.
 */
export async function deleteErasedArtifactCatalog(
  tx: Tx,
  subjectId: string,
): Promise<number> {
  const affectedRuns = sql`
    SELECT run.id FROM agent_runs run
    WHERE run.user_id = ${subjectId}
      OR EXISTS (
        SELECT 1 FROM agent_sessions session
        WHERE session.id = run.session_id
          AND (
            session.user_id = ${subjectId}
            OR EXISTS (
              SELECT 1 FROM agents agent
              WHERE agent.id = session.agent_id AND agent.owner = ${subjectId}
            )
          )
      )
  `;
  const affectedFiles = sql`
    SELECT file.id FROM run_uploaded_files file
    WHERE file.user_id = ${subjectId}
      OR file.run_id IN (${affectedRuns})
  `;
  const affectedSites = sql`
    SELECT site.id FROM hosted_sites site WHERE site.user_id = ${subjectId}
  `;
  const affectedImages = sql`
    SELECT image.id FROM image_artifacts image
    WHERE image.file_id IN (${affectedFiles})
      OR EXISTS (
        SELECT 1 FROM built_in_generation_jobs job
        WHERE job.id = image.generation_job_id AND job.user_id = ${subjectId}
      )
  `;
  const affectedVideos = sql`
    SELECT video.id FROM video_artifacts video
    WHERE video.file_id IN (${affectedFiles})
      OR EXISTS (
        SELECT 1 FROM built_in_generation_jobs job
        WHERE job.id = video.generation_job_id AND job.user_id = ${subjectId}
      )
  `;
  const affectedPresentations = sql`
    SELECT presentation.id FROM presentation_artifacts presentation
    WHERE presentation.hosted_site_id IN (${affectedSites})
      OR EXISTS (
        SELECT 1 FROM built_in_generation_jobs job
        WHERE job.id = presentation.generation_job_id
          AND job.user_id = ${subjectId}
      )
  `;

  // Count the locked subquery so a large account does not load every id into
  // the API process. These locks are held through the catalog and source DELETEs.
  await tx.execute(sql`
    SELECT count(*) FROM (
      SELECT image.id FROM image_artifacts image
      WHERE image.id IN (${affectedImages}) ORDER BY image.id FOR UPDATE
    ) locked
  `);
  await tx.execute(sql`
    SELECT count(*) FROM (
      SELECT video.id FROM video_artifacts video
      WHERE video.id IN (${affectedVideos}) ORDER BY video.id FOR UPDATE
    ) locked
  `);
  await tx.execute(sql`
    SELECT count(*) FROM (
      SELECT site.id FROM hosted_sites site
      WHERE site.id IN (${affectedSites})
        OR EXISTS (
          SELECT 1 FROM presentation_artifacts presentation
          JOIN built_in_generation_jobs job
            ON job.id = presentation.generation_job_id
          WHERE presentation.hosted_site_id = site.id
            AND job.user_id = ${subjectId}
        )
      ORDER BY site.id FOR UPDATE
    ) locked
  `);
  await tx.execute(sql`
    SELECT count(*) FROM (
      SELECT presentation.id FROM presentation_artifacts presentation
      WHERE presentation.id IN (${affectedPresentations})
      ORDER BY presentation.id FOR UPDATE
    ) locked
  `);
  await tx.execute(sql`
    SELECT count(*) FROM (
      SELECT file.id FROM run_uploaded_files file
      WHERE file.id IN (${affectedFiles})
      ORDER BY file.id FOR UPDATE
    ) locked
  `);

  const deleted = await tx.execute(sql`
    DELETE FROM artifacts catalog
    WHERE (catalog.kind = 'file' AND catalog.entity_id IN (${affectedFiles}))
      OR (catalog.kind = 'hosted-site'
        AND catalog.entity_id IN (${affectedSites}))
      OR (catalog.kind = 'image'
        AND catalog.entity_id IN (${affectedImages}))
      OR (catalog.kind = 'video'
        AND catalog.entity_id IN (${affectedVideos}))
      OR (catalog.kind = 'presentation'
        AND catalog.entity_id IN (${affectedPresentations}))
  `);
  return deleted.rowCount ?? 0;
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
    // A user-export worker can still write result or staging bytes after D1
    // closes new admissions. Its durable row is the cleanup coordinator; do
    // not sweep that row until export cleanup has quiesced the writer, aborted
    // uploads and removed the row itself.
    const [activeExport] = await executeRawRows(
      tx,
      sql`SELECT id FROM background_jobs
          WHERE user_id = ${subject.subjectId} AND kind = 'user-export'
          LIMIT 1`,
      z.object({ id: z.uuid() }),
    );
    if (activeExport) {
      throw new Error("account_erasure_relational:export_work_unresolved");
    }
    const owned = plan.order.map((root) => {
      return {
        table: root.table,
        predicate: subjectPredicate(root, subject.subjectId),
      };
    });
    const byRoot = new Map(
      owned.map((root) => {
        return [root.table, root.predicate];
      }),
    );
    let deleted = await deleteErasedArtifactCatalog(tx, subject.subjectId);
    const blobReferences = new Map<string, number>();
    let deletedConversations = 0;
    const retainRemovedHash = (hash: string | null): void => {
      if (hash !== null) {
        blobReferences.set(hash, (blobReferences.get(hash) ?? 0) + 1);
      }
    };
    // Descendants first, every one of them, before any root is deleted. A
    // path joins upwards through rows that must still be there, and a path
    // longer than one hop passes through an intermediate owned by a different
    // root than the one it ends at. Deleting each root's descendants just
    // before that root would leave those paths matching nothing.
    for (const path of plan.descendants) {
      const predicate = byRoot.get(path.root);
      // A path anchored on a root the plan could not reach has no predicate to
      // build from. `assertRelationalSweepComplete` already refuses to call
      // such a plan complete, so skipping here drops no claim.
      if (!predicate) {
        continue;
      }
      // Swept through the key explicitly, not left to a cascade: a declared
      // descendant whose key is `NO ACTION` would otherwise stay behind.
      if (path.child === "conversations") {
        // A conversation owns one content-addressed blob retain. Capture the
        // actually deleted hashes in the same transaction; a later retry sees
        // no rows and cannot double-release a shared blob.
        const removed = await executeRawRows(
          tx,
          sql`DELETE FROM conversations
              WHERE ${descendantPredicate(path, predicate)}
              RETURNING cli_agent_session_history_hash AS hash`,
          z.object({ hash: z.string().nullable() }),
        );
        deleted += removed.length;
        deletedConversations += removed.length;
        for (const row of removed) {
          retainRemovedHash(row.hash);
        }
        continue;
      }
      deleted +=
        (
          await tx.execute(
            sql`DELETE FROM ${sql.identifier(path.child)}
                WHERE ${descendantPredicate(path, predicate)}`,
          )
        ).rowCount ?? 0;
    }
    // Delete candidate roots before storage roots. The storage FK cascades, so
    // leaving candidate deletion to the generic root order could make the
    // candidate rows vanish before their blob hashes are returned. Their
    // descendants are already gone, and candidates have no incoming blocking
    // root FK; the refcount update still waits until after all root deletion.
    const candidateRoot = owned.find((root) => {
      return root.table === "pi_memory_stage1_candidates";
    });
    if (candidateRoot) {
      const removed = await executeRawRows(
        tx,
        sql`DELETE FROM pi_memory_stage1_candidates
            WHERE ${candidateRoot.predicate}
            RETURNING source_history_hash AS hash`,
        z.object({ hash: z.string() }),
      );
      deleted += removed.length;
      for (const row of removed) {
        retainRemovedHash(row.hash);
      }
    }
    for (const root of owned) {
      if (root.table === "pi_memory_stage1_candidates") {
        continue;
      }
      deleted +=
        (
          await tx.execute(
            sql`DELETE FROM ${sql.identifier(root.table)}
                WHERE ${root.predicate}`,
          )
        ).rowCount ?? 0;
    }
    if (blobReferences.size > 0) {
      await releaseDeletedConversationReferences(tx, {
        references: blobReferences,
        deletedConversations,
      });
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
    plan.descendants.map((path) => {
      return [
        path.child,
        path.root,
        path.source,
        path.hops.map((hop) => {
          return [hop.childColumns, hop.parent, hop.parentColumns];
        }),
      ];
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
    plan.unreachableDescendants.length > 0 ||
    plan.unattributableDescendants.length > 0
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
    erase: async (lease, signal) => {
      const subject = await leaseSubject(db, lease);
      if (!subject) {
        return unresolved("selector_missing");
      }
      const boundary = lease.producerBoundaryRef;
      if (boundary === null) {
        return unresolved("boundary_unproven");
      }
      const sweep = await settle(
        sweepRelationalErasure(
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
        ),
        signal,
      );
      if (!sweep.ok) {
        const { error } = sweep;
        if (
          error instanceof Error &&
          error.message === "account_erasure_relational:export_work_unresolved"
        ) {
          return {
            outcome: "pending",
            errorCode: "boundary_unproven",
            requestRef: null,
            retryAt: new Date(nowDate().getTime() + 60_000),
          };
        }
        throw error;
      }
      return {
        requestRef: requestReference(
          lease,
          sweep.value > 0 ? "erased" : "empty",
        ),
      };
    },
    verify: async (lease, producerBoundary) => {
      return await verifyRelationalErasure(db, plan, lease, producerBoundary);
    },
  };
}
