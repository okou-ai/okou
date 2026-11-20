import { command, computed, state } from "ccstate";
import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/validators/user-permission-grants";

import { now } from "../../lib/time.ts";
import { i18n } from "../../i18n/index.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN: UserPermissionGrantExpiresIn =
  "1h";

export const USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS: readonly UserPermissionGrantExpiresIn[] =
  ["1h", "24h", "7d", "always"];

export function parseUserPermissionGrantExpiresIn(
  value: string | null,
): UserPermissionGrantExpiresIn | null {
  for (const option of USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS) {
    if (option === value) {
      return option;
    }
  }
  return null;
}

export function permissionGrantExpiryText(
  expiresAt: string | null,
  nowMs = now(),
): string | null {
  if (!expiresAt) {
    return null;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) {
    return i18n.t(($) => {
      return $.authorization.permission.expiration.expired;
    });
  }
  // Round before choosing a unit so tiny clock differences keep the same label.
  const hourCount = Math.round(remainingMs / HOUR_MS);
  if (hourCount > 24) {
    return i18n.t(
      ($) => {
        return $.authorization.permission.expiration.inDays;
      },
      { count: Math.round(remainingMs / DAY_MS) },
    );
  }
  if (hourCount < 1) {
    return i18n.t(($) => {
      return $.authorization.permission.expiration.lessThanHour;
    });
  }
  return i18n.t(
    ($) => {
      return $.authorization.permission.expiration.inHours;
    },
    { count: hourCount },
  );
}

const internalPermissionGrantExpiresInByScope$ = state<
  Record<string, UserPermissionGrantExpiresIn>
>({});

export const permissionGrantExpiresInByScope$ = computed((get) => {
  return get(internalPermissionGrantExpiresInByScope$);
});

export const setPermissionGrantExpiresIn$ = command(
  ({ get, set }, scope: string, expiresIn: UserPermissionGrantExpiresIn) => {
    const current = get(internalPermissionGrantExpiresInByScope$);
    set(internalPermissionGrantExpiresInByScope$, {
      ...current,
      [scope]: expiresIn,
    });
  },
);
