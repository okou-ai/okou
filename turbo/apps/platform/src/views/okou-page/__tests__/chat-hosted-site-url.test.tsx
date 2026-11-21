import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactSummary,
  artifactRun,
  hostedSiteArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  findNamedButton,
  findNamedLink,
  getNamedButton,
} from "./chat-attachment-test-helpers.ts";
import { openResources } from "./chat-resources-test-helpers.ts";

const context = testContext();
const title = "Quarterly launch report";
const original = "launch-recap";
const address = (slug: string) => {
  return "https://" + slug + ".okou.app";
};
const deployment = address("dpl-8a4d4487-18c0-44cd-a09d-206056d499b0");
async function publishedReport(sidebar: boolean) {
  const siteId = "be311386-caaa-4bfb-a74a-7d694c27c41e";
  let slug = original;
  const site = () => {
    return {
      siteId,
      publicSlug: slug,
      url: address(slug),
      isActive: true,
    };
  };
  const item = {
    ...artifactSummary(
      "d8064466-f246-4524-8e90-3655890190fe",
      "hosted-site",
      title,
    ),
    sourceUrl: deployment,
    aliasUrl: address(original),
  };
  const run = artifactRun({
    artifactId: item.id,
    fileId: siteId,
    filename: "index.html",
    contentType: "text/html",
    url: deployment,
  });
  mockArtifactConversation(context, {
    catalog: [item],
    artifactRuns: () => {
      return [
        {
          ...run,
          files: [
            {
              ...run.files[0]!,
              title,
              artifactKind: "hosted-site",
              aliasUrl: address(original),
            },
          ],
        },
      ];
    },
    getDetail: () => {
      return hostedSiteArtifactDetail(item, {
        siteId,
        slug,
        url: address(slug),
      });
    },
    chatEvents: [
      {
        role: "assistant",
        content: "[Read the launch report](" + deployment + ")",
        createdAt: "2026-10-10T18:00:00Z",
        runId: NAVIGATION_ARTIFACT_RUN_ID,
      },
    ],
  });
  context.mocks.api(hostContract.siteUrl, ({ respond }) => {
    return respond(200, site());
  });
  context.mocks.api(hostContract.siteVisibility, ({ respond }) => {
    return respond(200, { siteId, visibility: "public", revision: null });
  });
  context.mocks.api(hostContract.siteBanner, ({ respond }) => {
    return respond(200, { siteId, showBanner: true, revision: null });
  });
  context.mocks.api(hostContract.siteUrlAvailability, ({ query, respond }) => {
    return respond(200, { available: query.publicSlug !== slug });
  });
  context.mocks.api(hostContract.updateSiteUrl, ({ body, respond }) => {
    if (body.expectedPublicSlug !== slug) {
      return respond(409, {
        error: { code: "CONFLICT", message: "The site was already renamed" },
      });
    }
    slug = body.publicSlug;
    return respond(200, site());
  });
  await setupPage({
    context,
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
      [FeatureSwitchKey.ArtifactPreviewActionGroup]: false,
    },
  });
  click(await findNamedLink("Read the launch report"));
  const preview = sidebar
    ? await screen.findByTestId("artifact-sidebar")
    : await screen.findByTestId("attachment-lightbox");
  await findNamedLink(title, preview);
  return preview;
}

test.each([
  { id: "001", sidebar: false },
  { id: "002", sidebar: true },
])(
  "chat-hosted-site-url-$id shows the owner's current banner and public audience in Share",
  async ({ sidebar }) => {
    const preview = await publishedReport(sidebar);
    click(await findNamedButton(sidebar ? "Share artifact" : "Share", preview));
    const toggle = await screen.findByRole("switch", {
      name: "Show Okou banner",
    });
    const menu = toggle.closest<HTMLElement>('[role="dialog"]')!;
    expect(toggle).toBeEnabled();
    expect(toggle).toBeChecked();
    const audience = within(menu).getByLabelText("Anyone with the link");
    expect(audience).toBeEnabled();
    expect(audience).toBeChecked();
  },
);

test.each([
  { id: "003", sidebar: false },
  { id: "004", sidebar: true },
])(
  "chat-hosted-site-url-$id follows both saved addresses through the preview and Resources",
  async ({ sidebar }) => {
    const viewer = await publishedReport(sidebar);
    const user = userEvent.setup({ delay: null, writeToClipboard: false });
    for (const [current, next] of [
      [original, "renamed-site"],
      ["renamed-site", "final-site"],
    ] as const) {
      click(
        await findNamedButton(sidebar ? "Share artifact" : "Share", viewer),
      );
      await screen.findByText(current + ".okou.app");
      click(getNamedButton("Customize URL"));
      await fill(await screen.findByLabelText("Website URL"), next);
      await screen.findByText("Available");
      click(getNamedButton("Save"));
      const url = address(next);
      await waitFor(() => {
        expect(
          within(viewer).getByText(title, { selector: "a" }),
        ).toHaveAttribute("href", url + "/");
      });
      const shareCopy = await findNamedButton("Copy link");
      const clipboard = context.mocks.browser.clipboardWriteText();
      click(shareCopy);
      await waitFor(() => {
        expect(clipboard.writes).toStrictEqual([url]);
      });
      await user.keyboard("{Escape}");
    }
    click(await findNamedButton(sidebar ? "Close artifact" : "Close", viewer));
    const resources = await openResources();
    const row = (await within(resources).findByText(title)).closest("li")!;
    const clipboard = context.mocks.browser.clipboardWriteText();
    click(getNamedButton("Copy link", row));
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([address("final-site")]);
    });
  },
);
