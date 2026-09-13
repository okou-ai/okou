import { normalizeGoogleAdsAttribution } from "@okouai/core/google-ads-attribution";
import {
  adAttributionMetadataSchema,
  type AdAttributionMetadata,
} from "@okouai/api-contracts/contracts/acquisition-attribution";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, isNull } from "drizzle-orm";
import { command } from "ccstate";

import { googleAdsAccountForAttribution } from "@okouai/core/google-ads-account";
import { clerk$ } from "../external/clerk";
import { clerkAttributionDisabled } from "../../lib/clerk-attribution";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const ORG_ATTRIBUTION_FIELDS = [
  ["source_type", "acquisitionSourceType"],
  ["vm0_source", "acquisitionFirstPartySource"],
  ["okou_campaign_id", "acquisitionCampaignId"],
  ["okou_ad_group_id", "acquisitionAdGroupId"],
  ["utm_campaign", "acquisitionCampaign"],
  ["utm_source", "acquisitionUtmSource"],
  ["utm_medium", "acquisitionUtmMedium"],
  ["utm_content", "acquisitionUtmContent"],
  ["utm_term", "acquisitionUtmTerm"],
  ["gclid", "acquisitionGclid"],
  ["gbraid", "acquisitionGbraid"],
  ["wbraid", "acquisitionWbraid"],
  ["ga_client_id", "acquisitionGaClientId"],
  ["landing_host", "acquisitionLandingHost"],
  ["landing_path", "acquisitionLandingPath"],
  ["referrer_domain", "acquisitionReferrerDomain"],
] as const;

type OrgAttributionField = (typeof ORG_ATTRIBUTION_FIELDS)[number][1];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clerk stores a bookkeeping timestamp alongside the attribution payload.
 * Keep that implementation detail out of the strict API contract when the
 * value is read back for checkout or org persistence.
 */
export function parseStoredSignupAttribution(
  value: unknown,
): AdAttributionMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { recorded_at: _recordedAt, ...metadata } = value;
  const parsed = adAttributionMetadataSchema.safeParse(metadata);
  return parsed.success
    ? normalizeGoogleAdsAttribution(parsed.data)
    : undefined;
}

export const googleAdsAccountForUser$ = command(
  async (
    { get },
    userId: string,
    provided: AdAttributionMetadata | undefined,
    signal: AbortSignal,
  ) => {
    if (clerkAttributionDisabled()) {
      return null;
    }
    const users = await get(clerk$).users.getUserList(
      { userId: [userId], limit: 1 },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    const user = users.data.find((candidate) => {
      return candidate.id === userId;
    });
    if (!user) {
      throw new Error(`No Clerk user found for user ${userId}`);
    }
    const metadata = user.privateMetadata;
    // An existing unresolved or malformed first touch cannot borrow a later
    // visit's campaign. Only users with no saved touch may use the captured one.
    const attribution = Object.prototype.hasOwnProperty.call(
      metadata,
      "signup_attribution",
    )
      ? parseStoredSignupAttribution(metadata.signup_attribution)
      : provided;
    return googleAdsAccountForAttribution(attribution);
  },
);

function orgAttributionValues(
  attribution: Readonly<Record<string, string | undefined>> | undefined,
): Partial<Record<OrgAttributionField, string>> {
  const values: Partial<Record<OrgAttributionField, string>> = {};
  const normalized = normalizeGoogleAdsAttribution(attribution ?? {});
  for (const [sourceKey, targetKey] of ORG_ATTRIBUTION_FIELDS) {
    const value = normalized[sourceKey]?.trim();
    if (value) {
      values[targetKey] = value;
    }
  }
  return values;
}

export function mergeFirstTouchAttribution(
  provided: AdAttributionMetadata | undefined,
  stored: AdAttributionMetadata | undefined,
): AdAttributionMetadata | undefined {
  if (!provided && !stored) {
    return undefined;
  }

  if (!stored) {
    return provided ? normalizeGoogleAdsAttribution(provided) : undefined;
  }

  // The click and its campaign belong to one touch. Filling missing campaign
  // fields from a later visit can send the original click to another Ads account.
  // A GA client identifier is independent of that advertising attribution.
  const gaClientId = stored.ga_client_id ?? provided?.ga_client_id;
  return {
    ...normalizeGoogleAdsAttribution(stored),
    ...(gaClientId ? { ga_client_id: gaClientId } : {}),
  };
}

export const persistOrgAcquisitionAttribution$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly attribution:
        | Readonly<Record<string, string | undefined>>
        | undefined;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const values = orgAttributionValues(args.attribution);
    if (Object.keys(values).length === 0) {
      return false;
    }

    const recordedAt = nowDate();
    const db = set(writeDb$);

    // An org can be created just before the first billing request. Ensure the
    // metadata row exists, then only fill the attribution columns once. The
    // timestamp is the immutable first-touch guard under concurrent checkouts.
    const [inserted] = await db
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId: args.orgId,
        credits: 0,
        ...values,
        acquisitionRecordedAt: recordedAt,
        updatedAt: recordedAt,
      })
      .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
      .returning({ orgId: orgMetadataCanonicalWrites.orgId });
    signal.throwIfAborted();
    if (inserted) {
      return true;
    }

    const [updated] = await db
      .update(orgMetadata)
      .set({
        ...values,
        acquisitionRecordedAt: recordedAt,
        updatedAt: recordedAt,
      })
      .where(
        and(
          eq(orgMetadata.orgId, args.orgId),
          isNull(orgMetadata.acquisitionRecordedAt),
        ),
      )
      .returning({ orgId: orgMetadata.orgId });
    signal.throwIfAborted();
    return Boolean(updated);
  },
);
