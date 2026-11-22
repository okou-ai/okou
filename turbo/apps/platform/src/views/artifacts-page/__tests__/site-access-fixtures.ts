import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import type { HostedSiteVisibility } from "@okouai/api-contracts/contracts/hosted-site-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
} from "./artifact-catalog-test-helpers.ts";
import { hostedSiteArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import {
  billing,
  setBilling,
  packages,
} from "../../okou-page/__tests__/workspace-billing-fixtures.ts";

export const stable = "https://studio-notes.okou.app/";
export const temporary = "https://studio-notes-preview.example.org/";
export async function openSharing(
  context: ReturnType<typeof testContext>,
  options: {
    audience?: HostedSiteVisibility;
    sidebar?: boolean;
    free?: boolean;
    denyBanner?: boolean;
    denyVisibility?: boolean;
    visibilityRead?: Promise<void>;
    beforeWrite?: (choice: HostedSiteVisibility) => Promise<void>;
    refreshPreview?: () => Promise<void>;
  } = {},
) {
  const site = crypto.randomUUID();
  const entry = artifact({ kind: "hosted-site", title: "Studio notes" });
  const detail = hostedSiteArtifactDetail(entry, {
    siteId: site,
    slug: "studio-notes",
    url: stable,
  });
  let audience = options.audience ?? "public",
    revision = crypto.randomUUID(),
    bannerRevision = crypto.randomUUID(),
    showBanner = true;
  const clipboard = context.mocks.browser.clipboardWriteText();
  const analytics = context.mocks.posthog();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [entry], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, {
      siteId: site,
      publicSlug: "studio-notes",
      url: stable,
      isActive: true,
    });
  });
  context.mocks.api(hostContract.sitePreview, async ({ respond }) => {
    if (audience === "public") {
      await options.refreshPreview?.();
    }
    return respond(200, {
      url: audience === "public" ? stable : temporary,
      expiresAt: audience === "public" ? null : "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.api(hostContract.siteVisibility, async ({ respond }) => {
    await options.visibilityRead;
    return options.denyVisibility
      ? respond(403, { error: { code: "FORBIDDEN", message: "Access denied" } })
      : respond(200, { siteId: site, visibility: audience, revision });
  });
  context.mocks.api(
    hostContract.updateSiteVisibility,
    async ({ body, respond }) => {
      await options.beforeWrite?.(body.visibility);
      if (body.expectedRevision !== revision) {
        return respond(409, {
          error: {
            code: "CONFLICT",
            message: "Another editor changed the audience",
          },
        });
      }
      audience = body.visibility;
      revision = crypto.randomUUID();
      return respond(200, { siteId: site, visibility: audience, revision });
    },
  );
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return options.denyBanner
      ? respond(403, {
          error: { code: "FORBIDDEN", message: "Banner unavailable" },
        })
      : respond(200, { siteId: site, showBanner, revision: bannerRevision });
  });
  context.mocks.api(hostContract.updateSiteBanner, ({ body, respond }) => {
    if (body.expectedRevision !== bannerRevision) {
      return respond(409, {
        error: {
          code: "CONFLICT",
          message: "Another editor changed the banner",
        },
      });
    }
    showBanner = body.showBanner;
    bannerRevision = crypto.randomUUID();
    return respond(200, { siteId: site, showBanner, revision: bannerRevision });
  });
  if (options.free) {
    setBilling(context, () => {
      return billing("limited-free-1");
    });
    packages(context);
  }
  await setupPage({
    context,
    path: "/artifacts",
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: options.sidebar ?? false,
      [FeatureSwitchKey.HostedSiteShareRows]: true,
      [FeatureSwitchKey.ArtifactPreviewActionGroup]:
        options.refreshPreview !== undefined,
      [FeatureSwitchKey.FreePlanArtifactPaywall]: options.free ?? false,
    },
  });
  click(await findArtifactAction("Studio notes"));
  const shareLabel = options.sidebar ? "Share artifact" : "Share";
  const trigger = await findFastControl("button", shareLabel);
  click(trigger);
  const dialog = await screen.findByRole("dialog", { name: shareLabel });
  return {
    menu: within(dialog),
    button: (name: string) => {
      return findFastControl("button", name, dialog);
    },
    dialog,
    trigger,
    clipboard,
    analytics,
    banner: () => {
      return showBanner;
    },
    replaceBannerRevision: () => {
      bannerRevision = crypto.randomUUID();
    },
    moveToOrg: () => {
      audience = "organization";
      revision = crypto.randomUUID();
    },
  };
}
