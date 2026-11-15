import { androidUpdatesContract } from "@okouai/api-contracts/contracts/android-updates";
import { command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { androidMinimumSupportedVersion } from "../../lib/android-client-compatibility";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import {
  AndroidUpdateUnavailable,
  loadAndroidRelease,
} from "../services/android-updates.service";
import { settle } from "../utils";

const getAndroidUpdate$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const loaded = await settle(loadAndroidRelease(signal), signal);
  if (!loaded.ok) {
    if (!(loaded.error instanceof AndroidUpdateUnavailable)) {
      throw loaded.error;
    }
    set(setResHeader$, "Retry-After", "60");
    return {
      status: 503 as const,
      body: {
        error: {
          code: "ANDROID_UPDATE_UNAVAILABLE",
          message: loaded.error.message,
        },
      },
    };
  }
  return {
    status: 200 as const,
    body: {
      optionalUpdatesEnabled: isFeatureEnabled(
        FeatureSwitchKey.AndroidUpdateAnnouncements,
        {},
      ),
      minimumSupportedVersion: androidMinimumSupportedVersion(),
      release: loaded.value,
    },
  };
});
export const androidUpdateRoutes: readonly RouteEntry[] = [
  { route: androidUpdatesContract.get, handler: getAndroidUpdate$ },
];
