interface GoogleAdsAttributionIds {
  readonly vm0_campaign_id?: string;
  readonly vm0_ad_group_id?: string;
  readonly okou_campaign_id?: string;
  readonly okou_ad_group_id?: string;
}

function mergeIds(legacy: string | undefined, canonical: string | undefined) {
  if (legacy === undefined) {
    return canonical;
  }
  if (canonical === undefined || canonical === legacy) {
    return legacy;
  }
  // Preserve conflicting evidence so it cannot select a numeric campaign ID.
  return `${legacy},${canonical}`;
}

export function normalizeGoogleAdsAttribution<
  T extends GoogleAdsAttributionIds,
>(metadata: T) {
  const {
    vm0_campaign_id: legacyCampaignId,
    vm0_ad_group_id: legacyAdGroupId,
    okou_campaign_id: canonicalCampaignId,
    okou_ad_group_id: canonicalAdGroupId,
    ...rest
  } = metadata;
  const campaignId = mergeIds(legacyCampaignId, canonicalCampaignId);
  const adGroupId = mergeIds(legacyAdGroupId, canonicalAdGroupId);
  return {
    ...rest,
    ...(campaignId !== undefined ? { okou_campaign_id: campaignId } : {}),
    ...(adGroupId !== undefined ? { okou_ad_group_id: adGroupId } : {}),
  };
}

// Existing analytics and Stripe recovery consumers still need equal aliases.
function legacyGoogleAdsAttribution<T extends GoogleAdsAttributionIds>(
  metadata: T,
) {
  const {
    okou_campaign_id: campaignId,
    okou_ad_group_id: adGroupId,
    ...rest
  } = normalizeGoogleAdsAttribution(metadata);
  return {
    ...rest,
    ...(campaignId !== undefined ? { vm0_campaign_id: campaignId } : {}),
    ...(adGroupId !== undefined ? { vm0_ad_group_id: adGroupId } : {}),
  };
}

// Stripe consumers and existing analytics reports still read the old keys.
// Retire the aliases after those consumers migrate; tracked in #33059.
export function compatibleGoogleAdsAttribution<
  T extends GoogleAdsAttributionIds,
>(metadata: T) {
  const normalized = normalizeGoogleAdsAttribution(metadata);
  return { ...normalized, ...legacyGoogleAdsAttribution(normalized) };
}

export function normalizeGoogleAdsAttributionParams(
  input: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(input);
  for (const [legacy, canonical] of [
    ["vm0_campaign_id", "okou_campaign_id"],
    ["vm0_ad_group_id", "okou_ad_group_id"],
  ] as const) {
    const values = [
      ...new Set(
        [...params.getAll(legacy), ...params.getAll(canonical)]
          .map((value) => {
            return value.trim();
          })
          .filter(Boolean),
      ),
    ];
    params.delete(legacy);
    params.delete(canonical);
    if (values.length > 0) {
      params.set(canonical, values.join(","));
    }
  }
  return params;
}
