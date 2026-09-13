import { command, computed, type Computed } from "ccstate";
import {
  filterFeatureSwitchOverrides,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { and, eq, inArray } from "drizzle-orm";

import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";

export const ORG_SENTINEL_USER_ID = "__org__";

const ORG_SCOPED_FEATURE_SWITCH_KEYS: readonly string[] = [
  FeatureSwitchKey.PiLoop,
  FeatureSwitchKey.ReferenceImages,
];

function isOrgScopedFeatureSwitchKey(key: string): boolean {
  return ORG_SCOPED_FEATURE_SWITCH_KEYS.includes(key);
}

function splitFeatureSwitchesByScope(switches: Record<string, boolean>): {
  readonly userSwitches: Record<string, boolean>;
  readonly orgSwitches: Record<string, boolean>;
} {
  const registeredSwitches = filterFeatureSwitchOverrides(switches);
  const userSwitches: Record<string, boolean> = {};
  const orgSwitches: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(registeredSwitches)) {
    if (isOrgScopedFeatureSwitchKey(key)) {
      orgSwitches[key] = value;
    } else {
      userSwitches[key] = value;
    }
  }

  return { userSwitches, orgSwitches };
}

function hasSwitches(switches: Record<string, boolean>): boolean {
  return Object.keys(switches).length > 0;
}

function mergeScopedFeatureSwitches(
  userSwitches: Record<string, boolean>,
  orgSwitches: Record<string, boolean>,
): Record<string, boolean> {
  const merged: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(userSwitches)) {
    if (!isOrgScopedFeatureSwitchKey(key)) {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(orgSwitches)) {
    if (isOrgScopedFeatureSwitchKey(key)) {
      merged[key] = value;
    }
  }

  return merged;
}

export interface UserFeatureSwitchOverrideRow {
  readonly userId: string;
  readonly switches: Record<string, boolean>;
}

export function userFeatureSwitchOverridesFromRows(
  rows: readonly UserFeatureSwitchOverrideRow[],
  userId: string,
): Record<string, boolean> {
  let userSwitches: Record<string, boolean> = {};
  let orgSwitches: Record<string, boolean> = {};

  for (const row of rows) {
    const switches = filterFeatureSwitchOverrides(row.switches);
    if (row.userId === userId) {
      userSwitches = switches;
    }
    if (row.userId === ORG_SENTINEL_USER_ID) {
      orgSwitches = switches;
    }
  }

  return mergeScopedFeatureSwitches(userSwitches, orgSwitches);
}

async function loadUserFeatureSwitchOverrides(
  db: Pick<ReadonlyDb, "select">,
  orgId: string,
  userId: string,
): Promise<Record<string, boolean>> {
  const rows = await db
    .select({
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        inArray(userFeatureSwitches.userId, [userId, ORG_SENTINEL_USER_ID]),
      ),
    );

  return userFeatureSwitchOverridesFromRows(rows, userId);
}

export function userFeatureSwitchOverrides(
  orgId: string,
  userId: string,
): Computed<Promise<Record<string, boolean>>> {
  return computed(async (get): Promise<Record<string, boolean>> => {
    const db = get(db$);
    return await loadUserFeatureSwitchOverrides(db, orgId, userId);
  });
}

export async function loadUserFeatureSwitchContext(
  db: Pick<ReadonlyDb, "select">,
  orgId: string,
  userId: string,
): Promise<FeatureSwitchContext> {
  return {
    orgId,
    userId,
    overrides: await loadUserFeatureSwitchOverrides(db, orgId, userId),
  };
}

export function userFeatureSwitchContext(
  orgId: string,
  userId: string,
): Computed<Promise<FeatureSwitchContext>> {
  return computed(async (get): Promise<FeatureSwitchContext> => {
    return {
      orgId,
      userId,
      overrides: await get(userFeatureSwitchOverrides(orgId, userId)),
    };
  });
}

export const updateUserFeatureSwitches$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly switches: Record<string, boolean>;
    },
    signal: AbortSignal,
  ): Promise<Record<string, boolean>> => {
    const writeDb = set(writeDb$);
    const { userSwitches, orgSwitches } = splitFeatureSwitchesByScope(
      args.switches,
    );

    if (hasSwitches(userSwitches)) {
      await upsertFeatureSwitches(
        writeDb,
        args.orgId,
        args.userId,
        userSwitches,
        signal,
      );
    }

    if (hasSwitches(orgSwitches)) {
      await upsertFeatureSwitches(
        writeDb,
        args.orgId,
        ORG_SENTINEL_USER_ID,
        orgSwitches,
        signal,
      );
    }

    return await loadUserFeatureSwitchOverrides(
      writeDb,
      args.orgId,
      args.userId,
    );
  },
);

async function upsertFeatureSwitches(
  writeDb: Db,
  orgId: string,
  userId: string,
  switches: Record<string, boolean>,
  signal: AbortSignal,
): Promise<void> {
  const [existingRow] = await writeDb
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  const existing =
    (existingRow?.switches as Record<string, boolean> | undefined) ?? {};
  const merged: Record<string, boolean> = {
    ...filterFeatureSwitchOverrides(existing),
    ...filterFeatureSwitchOverrides(switches),
  };
  const now = nowDate();

  await writeDb
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: merged,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches: merged, updatedAt: now },
    });
  signal.throwIfAborted();
}

export const deleteUserFeatureSwitches$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, args.orgId),
          eq(userFeatureSwitches.userId, args.userId),
        ),
      );
    signal.throwIfAborted();

    await removeOrgScopedFeatureSwitches(writeDb, args.orgId, signal);
  },
);

async function removeOrgScopedFeatureSwitches(
  writeDb: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const [existingRow] = await writeDb
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, ORG_SENTINEL_USER_ID),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!existingRow) {
    return;
  }

  const next = { ...existingRow.switches };
  for (const key of ORG_SCOPED_FEATURE_SWITCH_KEYS) {
    delete next[key];
  }

  if (Object.keys(next).length === 0) {
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, orgId),
          eq(userFeatureSwitches.userId, ORG_SENTINEL_USER_ID),
        ),
      );
    signal.throwIfAborted();
    return;
  }

  await writeDb
    .update(userFeatureSwitches)
    .set({ switches: next, updatedAt: nowDate() })
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, ORG_SENTINEL_USER_ID),
      ),
    );
  signal.throwIfAborted();
}
