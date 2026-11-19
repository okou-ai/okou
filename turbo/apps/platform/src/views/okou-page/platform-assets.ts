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

export const emptyArtifactImg = pageAssetUrl(
  "assets/empty-artifact-scene-55d26a9e0f32.webp",
);
export const emptyChatImg = pageAssetUrl(
  "assets/empty-chat-scene-6b28dd5d6a92.webp",
);
export const emptyMailImg = pageAssetUrl(
  "assets/empty-mail-scene-50b72de72f9a.webp",
);
export const emptyAutomationsImg = pageAssetUrl(
  "assets/empty-automations-scene-97f91ef9b25a.webp",
);
export const emptyWorkflowImg = pageAssetUrl(
  "assets/empty-workflow-scene-c6297274f5f1.webp",
);
export const emptyUsageImg = pageAssetUrl(
  "assets/empty-usage-scene-f1dfa3406da6.webp",
);
export const emptySearchImg = pageAssetUrl(
  "assets/empty-search-scene-8550feac8ee3.webp",
);
export const thinkingBrandMotionImg = pageAssetUrl(
  "assets/okou-thinking-mark-textured-dd139799c2a2.svg",
);
export const computerUseIllustrationImg = pageAssetUrl(
  "assets/computer-use-illustration-eecea534a3ac.png?v=568fa471",
);
export const computerUseInstallIllustrationImg = pageAssetUrl(
  "assets/computer-use-install-sign-in-95dbf88a9019.webp",
);
export const computerUsePermissionsIllustrationImg = pageAssetUrl(
  "assets/computer-use-permissions-online-adca1d72ee25.webp",
);
export const noConnectorImg = pageAssetUrl(
  "assets/empty-connector-scene-84a9bc8692bb.webp",
);
export const noPermissionIllustration = pageAssetUrl(
  "assets/empty-permission-scene-3fb4a34a3e81.webp",
);
export const planProImg = pageAssetUrl(
  "components/org-manage/assets/plan-pro.webp",
);
export const planTeamImg = pageAssetUrl(
  "components/org-manage/assets/plan-team.webp",
);
