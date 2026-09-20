import { filterFeatureSwitchOverrides } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

export const ORG_SENTINEL_USER_ID = "__org__";

const ORG_SCOPED_FEATURE_SWITCH_KEYS: readonly string[] = [
  FeatureSwitchKey.PersonalSubscriptionPriority,
  FeatureSwitchKey.PiDeferredSandbox,
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

export function withoutOrgScopedFeatureSwitches(
  switches: Record<string, boolean>,
): Record<string, boolean> {
  const next = { ...switches };
  for (const key of ORG_SCOPED_FEATURE_SWITCH_KEYS) {
    delete next[key];
  }
  return next;
}
