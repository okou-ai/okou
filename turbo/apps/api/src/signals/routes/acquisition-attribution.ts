import {
  legacyGoogleAdsAttribution,
  normalizeGoogleAdsAttribution,
} from "@okouai/core/google-ads-attribution";
import { command } from "ccstate";
import {
  googleAdsAccountForAttribution,
  GOOGLE_ADS_ADSMARCH_ACCOUNT_ID,
} from "@okouai/core/google-ads-account";
import {
  acquisitionAttributionContract,
  type AdAttributionMetadata,
} from "@okouai/api-contracts/contracts/acquisition-attribution";

import {
  IMPACT_ATTRIBUTION_METADATA_KEY,
  parseImpactAttribution,
} from "@okouai/api-contracts/contracts/impact-attribution";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { clerkAttributionDisabled } from "../../lib/clerk-attribution";
import { nowDate } from "../../lib/time";
import {
  googleAdsAccountForUser$,
  parseStoredSignupAttribution,
  persistOrgAcquisitionAttribution$,
} from "../services/acquisition-attribution.service";
import { googleAdsConversionMilestonesForUser$ } from "../services/google-ads-conversion-milestones.service";
import { syncImpactStripeCustomer$ } from "../services/impact-attribution.service";
import type { RouteEntry } from "../route-entry";

const SIGNUP_ATTRIBUTION_KEY = "signup_attribution";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const recordSignupBody$ = bodyResultOf(
  acquisitionAttributionContract.recordSignup,
);

const resolveGoogleAdsAccountInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(
      bodyResultOf(acquisitionAttributionContract.resolveGoogleAdsAccount),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const googleAdsAccountId = await set(
      googleAdsAccountForUser$,
      get(authContext$).userId,
      body.data.attribution,
      signal,
    );
    return { status: 200 as const, body: { googleAdsAccountId } };
  },
);

const googleAdsMilestonesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const googleAdsAccountId = await set(
      googleAdsAccountForUser$,
      auth.userId,
      undefined,
      signal,
    );
    if (googleAdsAccountId !== GOOGLE_ADS_ADSMARCH_ACCOUNT_ID) {
      return {
        status: 200 as const,
        body: { milestones: [], googleAdsAccountId },
      };
    }
    const milestones = await set(
      googleAdsConversionMilestonesForUser$,
      auth.userId,
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { milestones, googleAdsAccountId } };
  },
);

const recordSignupInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const bodyResult = await get(recordSignupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    if (clerkAttributionDisabled()) {
      return {
        status: 200 as const,
        body: { recorded: false, googleAdsAccountId: null },
      };
    }

    const clerk = get(clerk$);
    const users = await clerk.users.getUserList({
      userId: [auth.userId],
      limit: 1,
    });
    signal.throwIfAborted();

    const user = users.data.find((candidate) => {
      return candidate.id === auth.userId;
    });
    if (!user) {
      throw new Error(`No Clerk user found for user ${auth.userId}`);
    }

    const privateMetadata = isRecord(user.privateMetadata)
      ? user.privateMetadata
      : {};
    const impact = parseImpactAttribution(
      bodyResult.data.impactAttribution,
      nowDate().getTime(),
    );
    const previousImpact = parseImpactAttribution(
      privateMetadata[IMPACT_ATTRIBUTION_METADATA_KEY],
      nowDate().getTime(),
    );
    if (
      impact &&
      (!previousImpact || impact.capturedAt > previousImpact.capturedAt)
    ) {
      await clerk.users.updateUserMetadata(auth.userId, {
        privateMetadata: { [IMPACT_ATTRIBUTION_METADATA_KEY]: impact },
      });
      signal.throwIfAborted();
      privateMetadata[IMPACT_ATTRIBUTION_METADATA_KEY] = impact;
    }
    const currentImpact = parseImpactAttribution(
      privateMetadata[IMPACT_ATTRIBUTION_METADATA_KEY],
      nowDate().getTime(),
    );
    if (impact && currentImpact) {
      await set(
        syncImpactStripeCustomer$,
        {
          impact_click_id: currentImpact.clickId,
          impact_click_at: currentImpact.capturedAt,
        },
        signal,
      );
    }
    const existingAttribution = parseStoredSignupAttribution(
      privateMetadata[SIGNUP_ATTRIBUTION_KEY],
    );
    if (
      Object.prototype.hasOwnProperty.call(
        privateMetadata,
        SIGNUP_ATTRIBUTION_KEY,
      )
    ) {
      if (auth.orgId && existingAttribution) {
        await set(
          persistOrgAcquisitionAttribution$,
          {
            orgId: auth.orgId,
            attribution: existingAttribution,
          },
          signal,
        );
      }
      return {
        status: 200 as const,
        body: {
          recorded: false,
          googleAdsAccountId:
            googleAdsAccountForAttribution(existingAttribution),
        },
      };
    }

    const attribution: AdAttributionMetadata = normalizeGoogleAdsAttribution(
      bodyResult.data.attribution,
    );
    if (Object.keys(attribution).length === 0) {
      return {
        status: 200 as const,
        body: { recorded: false, googleAdsAccountId: null },
      };
    }
    await clerk.users.updateUserMetadata(auth.userId, {
      privateMetadata: {
        ...privateMetadata,
        [SIGNUP_ATTRIBUTION_KEY]: {
          ...legacyGoogleAdsAttribution(attribution),
          recorded_at: nowDate().toISOString(),
        },
      },
    });
    signal.throwIfAborted();

    if (auth.orgId) {
      await set(
        persistOrgAcquisitionAttribution$,
        { orgId: auth.orgId, attribution },
        signal,
      );
    }

    return {
      status: 200 as const,
      body: {
        recorded: true,
        googleAdsAccountId: googleAdsAccountForAttribution(attribution),
      },
    };
  },
);

export const acquisitionAttributionRoutes: readonly RouteEntry[] = [
  {
    route: acquisitionAttributionContract.resolveGoogleAdsAccount,
    handler: authRoute({ accept: ["session"] }, resolveGoogleAdsAccountInner$),
  },
  {
    route: acquisitionAttributionContract.googleAdsMilestones,
    handler: authRoute({ accept: ["session"] }, googleAdsMilestonesInner$),
  },
  {
    route: acquisitionAttributionContract.recordSignup,
    handler: authRoute({ accept: ["session"] }, recordSignupInner$),
  },
];
