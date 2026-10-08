import {
  filterFeatureSwitchOverrides,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { and, eq, inArray } from "drizzle-orm";

export const ORG_SENTINEL_USER_ID = "__org__";

export const ORG_SCOPED_FEATURE_SWITCH_KEYS: readonly string[] = [
  // Bot setup and native command availability must agree for all members.
  FeatureSwitchKey.LarkIntegration,
];

function isOrgScopedFeatureSwitchKey(key: string): boolean {
  return ORG_SCOPED_FEATURE_SWITCH_KEYS.includes(key);
}

export function splitFeatureSwitchesByScope(
  switches: Record<string, boolean>,
): {
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

export function userFeatureSwitchRowCondition(orgId: string, userId: string) {
  return and(
    eq(userFeatureSwitches.orgId, orgId),
    inArray(userFeatureSwitches.userId, [userId, ORG_SENTINEL_USER_ID]),
  );
}

export function featureSwitchContextFromRows(
  orgId: string,
  userId: string,
  rows: readonly UserFeatureSwitchOverrideRow[],
): FeatureSwitchContext & { readonly overrides: Record<string, boolean> } {
  return {
    orgId,
    userId,
    overrides: userFeatureSwitchOverridesFromRows(rows, userId),
  };
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
