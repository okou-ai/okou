import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  mockAttachmentChat,
  getNamedButton,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

test.each([
  ["lightbox", "ready"],
  ["lightbox", "failed"],
  ["sidebar", "ready"],
  ["sidebar", "failed"],
] as const)(
  "the %s share button stays visible while its link resolves to %s",
  async (surface, outcome) => {
    const site = "https://toolbar-report.okou.app/";
    const started = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    mockAttachmentChat(context, {
      chatEvents: [
        {
          id: "toolbar-website-message",
          role: "assistant",
          content: `![Website report](${site})`,
          runId: ATTACHMENT_RUN_ID,
          sequenceNumber: 1,
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });
    context.mocks.api(hostContract.sitePreview, async ({ respond }) => {
      started.resolve();
      await release.promise;
      return outcome === "ready"
        ? respond(200, { url: site, expiresAt: null })
        : respond(403, {
            error: { code: "FORBIDDEN", message: "Preview unavailable" },
          });
    });
    await setupPage({
      context,
      host: "app.okou.ai",
      path: `/chats/${ATTACHMENT_THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarPreview]: surface === "sidebar",
      },
    });
    click(await screen.findByTestId("attachment-preview-html"));
    const preview = await screen.findByTestId(
      surface === "lightbox" ? "attachment-lightbox" : "artifact-sidebar",
    );
    await started.promise;
    const name = surface === "lightbox" ? "Share" : "Share artifact";
    const share = getNamedButton(name, preview);
    expect(share).toBeDisabled();
    expect(share).toHaveAttribute("aria-busy", "true");
    expect(share).toHaveAccessibleDescription("Loading permissions");
    release.resolve();
    await waitFor(() => {
      const settled = getNamedButton(name, preview);
      expect(settled).toHaveProperty("disabled", outcome === "failed");
      expect(settled).toHaveAccessibleDescription(
        outcome === "ready" ? "" : "Couldn't load the share link",
      );
      expect(settled).not.toHaveAttribute("aria-busy");
    });
    expect(getNamedButton(name, preview)).toBeVisible();
  },
);
