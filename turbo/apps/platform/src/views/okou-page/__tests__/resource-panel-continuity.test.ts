import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { chatArtifactCatalogChangedEvent } from "@okouai/api-contracts/validators/artifact-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactSummary,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID as thread,
} from "./chat-navigation-artifact-test-helpers.ts";
import { openResources } from "./chat-resources-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function openDetailsAndGallery(title: string) {
  const panel = await openResources();
  click((await within(panel).findByText(title)).closest("button")!);
  const back = await findFastControl("button", "Back to all artifacts");
  click(back);
  return screen.findByTestId("thread-sidebar-artifacts");
}
test("chat-resources-realtime-005 A catalog publication adds the video to the already open gallery", async () => {
  const site = artifactSummary(
    crypto.randomUUID(),
    "hosted-site",
    "Studio calendar",
  );
  const video = artifactSummary(
    crypto.randomUUID(),
    "video",
    "Launch replay.mp4",
  );
  const items = [site];
  mockArtifactConversation(context, {
    catalog: items,
    chatEvents: [],
    details: new Map([
      [
        site.id,
        {
          ...site,
          kind: "hosted-site",
          site: {
            id: site.id,
            slug: "studio-calendar",
            publicSlug: "studio-calendar",
            url: "https://studio-calendar.sites.vm7.io",
            deploymentVersion: 1,
            entrypoint: "index.html",
            spaFallback: true,
          },
        },
      ],
    ]),
  });
  context.mocks.browser.matchMedia((query) => {
    return /(min-width|hover: hover|pointer: fine)/.test(query);
  });
  await setupPage({ context, path: "/chats/" + thread });
  const gallery = await openDetailsAndGallery(site.title);
  await within(gallery).findByText(site.title);
  const topic = chatArtifactCatalogChangedEvent(thread);
  await waitFor(() => {
    return expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  items.push(video);
  expect(within(gallery).queryByText(video.title)).toBeNull();
  context.mocks.ably.trigger(topic, {});
  await expect(within(gallery).findByText(video.title)).resolves.toBeVisible();
  expect(within(gallery).getByText(site.title)).toBeVisible();
});
test("chat-resources-002 The pending panel shows both resources together and retains them on reopening", async () => {
  const release = context.mocks.deferred<void>();
  let available = true;
  const report = artifactSummary(
    crypto.randomUUID(),
    "file",
    "Field report.pdf",
  );
  const child = {
    threadId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    sourceRunId: crypto.randomUUID(),
    title: "Follow up with design",
    status: "idle" as const,
    createdAt: "2026-06-01T00:00:00.000Z",
  };
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    await release.promise;
    return respond(200, {
      artifacts: available ? [report] : [],
      nextCursor: null,
    });
  });
  context.mocks.api(chatRelationsContract.children, async ({ respond }) => {
    await release.promise;
    return respond(200, { items: available ? [child] : [] });
  });
  context.mocks.browser.matchMedia((query) => {
    return /(min-width|hover: hover|pointer: fine)/.test(query);
  });
  await setupPage({ context, path: "/chats/" + thread });
  const panel = await openResources();
  await expect(
    within(panel).findByRole("status", { name: "Loading artifacts" }),
  ).resolves.toBeVisible();
  release.resolve();
  await expect(within(panel).findByText(report.title)).resolves.toBeVisible();
  expect(within(panel).getByText(child.title)).toBeVisible();
  expect(
    within(panel).queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
  available = false;
  const returned = within(await openResources());
  await expect(returned.findByText(child.title)).resolves.toBeVisible();
  expect(returned.getByText(report.title)).toBeVisible();
  expect(
    returned.queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
});
