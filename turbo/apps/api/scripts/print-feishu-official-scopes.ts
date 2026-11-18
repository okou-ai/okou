import {
  FEISHU_OFFICIAL_TENANT_SCOPES,
  FEISHU_OFFICIAL_OAUTH_SCOPES,
} from "@okouai/api-contracts/validators/feishu-official";

// Import this JSON into the new store app. The custom app preset is independent.
console.log(
  JSON.stringify(
    {
      scopes: {
        tenant: FEISHU_OFFICIAL_TENANT_SCOPES,
        user: FEISHU_OFFICIAL_OAUTH_SCOPES,
      },
    },
    null,
    2,
  ),
);
