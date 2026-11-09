import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

const PLATFORM_RUNTIME_CONFIG = resolvePlatformRuntimeConfig();

export function platformStaticAssetUrl(path: string) {
  return `${PLATFORM_RUNTIME_CONFIG.publicStaticAssetsBaseUrl}/platform/${path.replace(/^\/+/u, "")}`;
}

export const platformMessagePdfFontUrls = Object.freeze({
  regular: platformStaticAssetUrl(
    "message-pdf/fonts/NotoSansCJKsc-Regular-2c76254f6fc3.otf",
  ),
  bold: platformStaticAssetUrl(
    "message-pdf/fonts/NotoSansCJKsc-Bold-b5f0d1a190a7.otf",
  ),
  italic: platformStaticAssetUrl(
    "message-pdf/fonts/sarasa-gothic-sc-italic-11c04388a84c.ttf",
  ),
  boldItalic: platformStaticAssetUrl(
    "message-pdf/fonts/sarasa-gothic-sc-bolditalic-434c2425d173.ttf",
  ),
  emoji: platformStaticAssetUrl(
    "message-pdf/fonts/noto-emoji-emoji-400-normal-61c7949ebb9d.woff",
  ),
});

export const platformEmptyPrivateAgentsImg = platformStaticAssetUrl(
  "views/agents-page/assets/empty-private-agents-9a8d7e3750b6.png",
);
export const platformOkouWordmarkDarkImg =
  "https://static.okou.io/public/okou-logo-wordmark-dark-8ac16c9eb76d.svg";
export const platformOkouWordmarkLightImg =
  "https://static.okou.io/public/okou-logo-wordmark-light-339c25e162eb.svg";
export const platformOkouMarkDarkImg =
  "https://static.okou.io/public/okou-logo-mark-dark-fa1157132610.svg";
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
export const platformLarkAddBotFeatureImg = platformStaticAssetUrl(
  "views/zero-page/assets/lark/add-bot-feature-88e089e41a87.png",
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
