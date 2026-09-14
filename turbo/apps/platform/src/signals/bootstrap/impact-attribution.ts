import {
  featureSwitchHydrated$,
  featureSwitchState$,
} from "../external/feature-switch-state.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  IMPACT_ATTRIBUTION_COOKIE,
  parseImpactAttribution,
  parseEncodedImpactAttribution,
  type ImpactAttribution,
} from "@okouai/api-contracts/contracts/impact-attribution";
import { command } from "ccstate";
import { now } from "../../lib/time.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";

const impactStorage = sessionStorageSignals("okou.impactAttribution");

export const recordImpactAttribution$ = command(
  ({ get, set }): ImpactAttribution | undefined => {
    if (!get(featureSwitchHydrated$)) {
      return undefined;
    }
    if (get(featureSwitchState$)[FeatureSwitchKey.ImpactMarketingAttribution]) {
      set(impactStorage.clear$);
      return undefined;
    }
    const stored = parseEncodedImpactAttribution(
      get(impactStorage.get$),
      now(),
    );
    const cookie = document.cookie.split(";").find((part) => {
      return part.trim().startsWith(`${IMPACT_ATTRIBUTION_COOKIE}=`);
    });
    const shared = parseEncodedImpactAttribution(
      cookie?.trim().slice(IMPACT_ATTRIBUTION_COOKIE.length + 1),
      now(),
    );
    const latest = [stored, shared]
      .filter((value) => {
        return value !== undefined;
      })
      .sort((a, b) => {
        return b.capturedAt.localeCompare(a.capturedAt);
      })[0];
    const params = new URLSearchParams(window.location.search);
    const clickId = params.get("im_ref");
    const fromUrl = clickId
      ? parseImpactAttribution(
          {
            clickId,
            capturedAt:
              params.get("im_ref_at") ??
              (latest?.clickId === clickId
                ? latest.capturedAt
                : new Date(now()).toISOString()),
          },
          now(),
        )
      : undefined;
    const attribution =
      fromUrl && (!latest || fromUrl.capturedAt > latest.capturedAt)
        ? fromUrl
        : latest;
    if (attribution) {
      set(impactStorage.set$, encodeURIComponent(JSON.stringify(attribution)));
    }
    return attribution;
  },
);
