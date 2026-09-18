import { normalizeGoogleAdsAttribution } from "./google-ads-attribution";

// Historical migration validation only; App/API delivery is owned by Marketing.
// Campaign ownership verified against Google Ads on 2026-09-09. Keep in sync
// with vm0-marketing/vite-ssr/app/lib/googleAdsAccounts.ts. Provider IDs are
// attribution identifiers, so do not rename them with the product brand.
const CAMPAIGN_ACCOUNTS: Readonly<Record<string, string>> = {
  "23843514859": "1001302527",
  "23843604937": "1001302527",
  "23888527671": "1001302527",
  "23890207845": "1001302527",
  "23895240410": "1001302527",
  "23897724622": "1001302527",
  "23898746151": "1001302527",
  "23898746154": "1001302527",
  "23898746157": "1001302527",
  "23898746280": "1001302527",
  "23899030780": "1001302527",
  "24006983243": "1001302527",
  "24061743341": "1001302527",
  "24064707516": "1001302527",
  "24088318259": "1001302527",
  "24154967178": "1001302527",
  "24160551742": "1001302527",
  "24160760528": "1001302527",
  "24165608095": "1001302527",
  "24185301545": "1001302527",
  "24220469665": "7935750692",
  "24220530631": "7935750692",
  // Verified from Google Ads campaign.resource_name on 2026-09-14.
  "24239997272": "7935750692",
  "24240467199": "7935750692",
};

export function googleAdsAccountForAttribution(
  metadata: Readonly<Record<string, string | undefined>> | undefined,
): string | null {
  const attribution = normalizeGoogleAdsAttribution(metadata ?? {});
  const campaignId = attribution.okou_campaign_id;
  const adGroupId = attribution.okou_ad_group_id;
  if (
    !campaignId ||
    !/^\d+$/.test(campaignId) ||
    (adGroupId && !/^\d+$/.test(adGroupId))
  ) {
    return null;
  }
  return CAMPAIGN_ACCOUNTS[campaignId] ?? null;
}
