import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
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
    free?: boolean;
    emailSharing?: boolean;
    siteId?: string;
    denyBanner?: boolean;
    denyVisibility?: boolean;
    visibilityRead?: Promise<void>;
    beforeWrite?: (choice: HostedSiteVisibility) => Promise<void>;
    preserveTemporaryPreview?: boolean;
  } = {},
) {
  const site = options.siteId ?? crypto.randomUUID();
  const entry = artifact({ kind: "hosted-site", title: "Studio notes" });
  const detail = hostedSiteArtifactDetail(entry, {
    siteId: site,
    slug: "studio-notes",
    url: stable,
  });
  let audience = options.audience ?? "public",
    updateCount = 0,
    conflicted = false,
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
  context.mocks.api(hostContract.sitePreview, ({ respond }) => {
    if (options.preserveTemporaryPreview && updateCount > 0) {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Preview unavailable after the visibility update",
        },
      });
    }
    const privatePreview =
      options.preserveTemporaryPreview || audience !== "public";
    return respond(200, {
      url: privatePreview ? temporary : stable,
      expiresAt: privatePreview ? "2099-01-01T00:00:00.000Z" : null,
    });
  });
  context.mocks.api(
    artifactAccessContract.getVisibility,
    async ({ respond }) => {
      await options.visibilityRead;
      return options.denyVisibility
        ? respond(403, {
            error: { code: "FORBIDDEN", message: "Access denied" },
          })
        : respond(200, {
            artifactId: site,
            kind: "hosted-site",
            visibility: audience,
            ownerUrl: stable,
            shareUrl: audience === "public" ? stable : null,
            shortUrl: null,
            organization: { id: "org_default", name: "Default Org" },
          });
    },
  );
  context.mocks.api(
    artifactAccessContract.updateVisibility,
    async ({ body, respond }) => {
      await options.beforeWrite?.(body.visibility);
      if (conflicted) {
        conflicted = false;
        return respond(409, {
          error: {
            code: "CONFLICT",
            message: "Another editor changed the audience",
          },
        });
      }
      audience = body.visibility;
      updateCount += 1;
      return respond(200, {
        artifactId: site,
        kind: "hosted-site",
        visibility: audience,
        ownerUrl: stable,
        shareUrl: audience === "public" ? stable : null,
        shortUrl: null,
        organization: { id: "org_default", name: "Default Org" },
      });
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
      [FeatureSwitchKey.HostedSiteShareRows]: true,
      [FeatureSwitchKey.ArtifactUserSharing]: options.emailSharing ?? false,
      [FeatureSwitchKey.FreePlanArtifactPaywall]: options.free ?? false,
    },
  });
  click(await findArtifactAction("Studio notes"));
  const shareLabel = "Share artifact";
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
      conflicted = true;
    },
  };
}
