import {
  LARK_OFFICIAL_TENANT_SCOPES,
  LARK_OFFICIAL_OAUTH_SCOPES,
} from "@okouai/api-contracts/validators/lark-official";

// Import this JSON into the new store app. The custom app preset is independent.
process.stdout.write(
  JSON.stringify(
    {
      scopes: {
        tenant: LARK_OFFICIAL_TENANT_SCOPES,
        user: LARK_OFFICIAL_OAUTH_SCOPES,
      },
    },
    null,
    2,
  ) + "\n",
);
