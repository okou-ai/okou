import { command, computed, type Computed } from "ccstate";
import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { invalidateFeatureSwitchPiStableContexts$ } from "./pi-stable-context-generation.service";
import {
  ORG_SCOPED_FEATURE_SWITCH_KEYS,
  ORG_SENTINEL_USER_ID,
  splitFeatureSwitchesByScope,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";

export function userFeatureSwitchOverrides(
  orgId: string,
  userId: string,
): Computed<Promise<Record<string, boolean>>> {
  return computed(async (get) => {
    const rows = await get(db$)
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
  });
}

export const loadUserFeatureSwitchContext$ = command(
  async (
    { get },
    orgId: string,
    userId: string,
    abortSignal?: AbortSignal,
  ): Promise<FeatureSwitchContext & { overrides: Record<string, boolean> }> => {
    const rows = await get(db$)
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
    abortSignal?.throwIfAborted();
    return {
      orgId,
      userId,
      overrides: userFeatureSwitchOverridesFromRows(rows, userId),
    };
  },
);

export function userFeatureSwitchContext(
  orgId: string,
  userId: string,
): Computed<Promise<FeatureSwitchContext>> {
  const overrides$ = userFeatureSwitchOverrides(orgId, userId);
  return computed(async (get) => {
    return { orgId, userId, overrides: await get(overrides$) };
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
    const writes = [
      { userId: args.userId, switches: userSwitches },
      { userId: ORG_SENTINEL_USER_ID, switches: orgSwitches },
    ].filter((row) => {
      return Object.keys(row.switches).length > 0;
    });
    if (writes.length > 0) {
      const updatedAt = nowDate();
      // Merge against the conflict winner in PostgreSQL, not a stale pre-read.
      // Filter historical retired keys just as the former application merge did.
      await writeDb
        .insert(userFeatureSwitches)
        .values(
          writes.map((row) => {
            return { ...row, orgId: args.orgId, updatedAt };
          }),
        )
        .onConflictDoUpdate({
          target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
          set: {
            switches: sql`COALESCE((
              SELECT jsonb_object_agg(entry.key, entry.value)
              FROM jsonb_each(${userFeatureSwitches.switches}) AS entry
              WHERE entry.key = ANY(${sql.param(Object.keys(getAllFeatureStates({})))}::text[])
            ), '{}'::jsonb) || excluded.switches`,
            updatedAt,
          },
        });
      signal.throwIfAborted();
      await set(
        invalidateFeatureSwitchPiStableContexts$,
        {
          orgId: args.orgId,
          ...(Object.keys(orgSwitches).length > 0
            ? {}
            : { userId: args.userId }),
        },
        signal,
      );
    }
    const context = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    return context.overrides;
  },
);

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
    const orgCondition = and(
      eq(userFeatureSwitches.orgId, args.orgId),
      eq(userFeatureSwitches.userId, ORG_SENTINEL_USER_ID),
    );
    // Subtraction touches only organization keys and preserves concurrent unrelated keys.
    await writeDb
      .update(userFeatureSwitches)
      .set({
        switches: sql`${userFeatureSwitches.switches} - ${sql.param(ORG_SCOPED_FEATURE_SWITCH_KEYS)}::text[]`,
        updatedAt: nowDate(),
      })
      .where(orgCondition);
    signal.throwIfAborted();
    await writeDb
      .delete(userFeatureSwitches)
      .where(and(orgCondition, eq(userFeatureSwitches.switches, {})));
    signal.throwIfAborted();
    await set(
      invalidateFeatureSwitchPiStableContexts$,
      { orgId: args.orgId },
      signal,
    );
  },
);
