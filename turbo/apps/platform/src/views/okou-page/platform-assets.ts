import { AVATAR_COMPOSER_ASSET_VERSION } from "@okouai/core/agent-avatar";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";

function pageAssetUrl(path: string): string {
  return platformStaticAssetUrl(`views/zero-page/${path.replace(/^\/+/u, "")}`);
}

export function avatarSvgAssetUrl(filename: string): string {
  return pageAssetUrl(`assets/avatar-svg/${filename}`);
}

export function avatarComposerAssetUrl(path: string): string {
  return pageAssetUrl(
    `assets/avatar-svg-v2/${AVATAR_COMPOSER_ASSET_VERSION}/${path}`,
  );
}

export const emptyArtifactImg = pageAssetUrl("assets/empty-artifact.webp");
export const emptyChatImg = pageAssetUrl("assets/empty-chat.webp");
export const emptyAutomationsImg = pageAssetUrl(
  "assets/empty-automations-fe7f603eaa3c.webp",
);
export const emptyWorkflowImg = pageAssetUrl(
  "assets/empty-workflow-96e709d12911.webp",
);
export const emptyUsageImg = pageAssetUrl(
  "assets/empty-usage-a1f6d48793ba.webp",
);
export const emptySearchImg = pageAssetUrl(
  "assets/empty-search-b4e60a8e07b8.webp",
);
export const thinkingSpinnerImg =
  "https://static.okou.io/public/okou-transparent.svg";
export const computerUseIllustrationImg = pageAssetUrl(
  "assets/computer-use-illustration-eecea534a3ac.png?v=568fa471",
);
export const noConnectorImg = pageAssetUrl("assets/no-connector.webp");
export const noPermissionIllustration = pageAssetUrl(
  "assets/no-permission-illustration.webp",
);
export const planProImg = pageAssetUrl(
  "components/org-manage/assets/plan-pro.webp",
);
export const planTeamImg = pageAssetUrl(
  "components/org-manage/assets/plan-team.webp",
);
