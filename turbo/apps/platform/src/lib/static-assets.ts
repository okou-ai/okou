import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

const PLATFORM_RUNTIME_CONFIG = resolvePlatformRuntimeConfig();

export function platformStaticAssetUrl(path: string) {
  return `${PLATFORM_RUNTIME_CONFIG.publicStaticAssetsBaseUrl}/platform/${path.replace(/^\/+/u, "")}`;
}

export const platformEmptyPrivateAgentsImg = platformStaticAssetUrl(
  "views/agents-page/assets/empty-private-agents-9a8d7e3750b6.png",
);
export const platformOkouWordmarkDarkImg =
  "https://static.okou.io/public/okou-logo-wordmark-dark-40e256bb155e.svg";
export const platformOkouWordmarkLightImg =
  "https://static.okou.io/public/okou-logo-wordmark-light-1ebf9d0e7a50.svg";
export const platformOkouMarkDarkImg =
  "https://static.okou.io/public/okou-logo-mark-dark-00337dd44485.svg";
export const platformFeishuAppIconImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/app-icon-okou-fefdc683bf5c.png",
);
export const platformFeishuCreateEnterpriseCustomAppImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/create-enterprise-custom-app-bfcbb0ba2ffb.png",
  );
export const platformLarkCreateAppForAgentImg = platformStaticAssetUrl(
  "views/zero-page/assets/lark/create-app-for-agent-3f059c49315e.png",
);
export const platformFeishuAppCreatedCredentialsImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/app-created-credentials-e58acd598bca.png",
);
export const platformFeishuEventSubscriptionModeImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/event-subscription-mode-ac2109302528.png",
);
export const platformFeishuEventRequestUrlImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/event-request-url-de3be5a1b88b.png",
);
export const platformFeishuEncryptionStrategyImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/encryption-strategy-e50ee6b26d77.png",
);
export const platformFeishuVersionManagementCreateVersionImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/version-management-create-version-43e32042dc81.png",
  );
export const platformFeishuVersionAvailabilityEditImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/version-availability-edit-5990fd6c7eae.png",
);
export const platformFeishuAvailabilitySettingsAllMembersImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/availability-settings-all-members-2cf582a888ed.png",
  );
export const platformFeishuSecuritySettingsRedirectUrlImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/security-settings-redirect-url-e7cf83ec76d4.png",
  );
export const platformFeishuPermissionsScopesBatchImportMenuImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/permissions-scopes-batch-import-menu-ade9686a2b72.png",
  );
export const platformFeishuPermissionsScopesBatchImportReviewImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/permissions-scopes-batch-import-review-667a5136ad85.png",
  );
