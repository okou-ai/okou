import {
  artifactCatalogContract,
  chatArtifactCatalogChangedEvent,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactSummary,
  buttonNamed,
  hostedSiteArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  installResourceGeometry,
  resourceButton,
} from "./chat-resources-test-helpers.ts";
import {
  createChatRunFixtures,
  promptEvent,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const TITLE = "artifact-video-test.mp4";
const topic = chatArtifactCatalogChangedEvent(RUN_THREAD_ID);

async function setupPublishingChat() {
  const video = {
    ...artifactSummary("e0000000-0000-4000-a000-000000000999", "file", TITLE),
    videoSourceUrl: "https://files.example.test/artifact-video-test.mp4",
  };
  installResourceGeometry(200);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  const runId = "d0000000-0000-4000-a000-000000000841";
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "video-prompt",
        runId,
        seqId: 1,
        text: "Make a short test video",
      }),
    ],
    activeRunIds: [runId],
  });
  let published = false;
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts:
        published && query.chatThreadId === RUN_THREAD_ID ? [video] : [],
      nextCursor: null,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    sharedWorkerTestTransport: "message-port",
  });
  await screen.findByText("Make a short test video");
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  return {
    publish: () => {
      published = true;
    },
  };
}

test.each(["notification", "reconnect"] as const)(
  "Show a published video in the open resource panel on %s without waiting for run completion",
  async (delivery) => {
    const chat = await setupPublishingChat();
    click(resourceButton());
    const resources = await screen.findByRole("region", {
      name: "Artifacts and chats",
    });
    await within(resources).findByText("No artifacts yet");
    chat.publish();
    await act(() => {
      if (delivery === "notification") {
        context.mocks.ably.trigger(topic);
      } else {
        // Ably could not replay the missed publication; re-read the baseline.
        context.mocks.ably.triggerConnectionState("suspended");
        context.mocks.ably.triggerReconnect();
      }
    });
    await expect(
      within(resources).findByText(TITLE),
    ).resolves.toBeInTheDocument();
    expect(
      within(resources).queryByText("No artifacts yet"),
    ).not.toBeInTheDocument();
  },
);

test("Show the latest published video when resources are first opened", async () => {
  const chat = await setupPublishingChat();
  chat.publish();
  await act(() => {
    context.mocks.ably.trigger(topic);
  });
  click(resourceButton());
  const resources = await screen.findByRole("region", {
    name: "Artifacts and chats",
  });
  await expect(
    within(resources).findByText(TITLE),
  ).resolves.toBeInTheDocument();
});

test("Refresh only the notified chat catalog", async () => {
  const chat = await setupPublishingChat();
  click(resourceButton());
  const resources = await screen.findByRole("region", {
    name: "Artifacts and chats",
  });
  await within(resources).findByText("No artifacts yet");
  chat.publish();
  await act(() => {
    context.mocks.ably.trigger(
      chatArtifactCatalogChangedEvent("b0000000-0000-4000-a000-000000000802"),
    );
  });
  expect(within(resources).getByText("No artifacts yet")).toBeInTheDocument();
  await act(() => {
    context.mocks.ably.trigger(topic);
  });
  await expect(
    within(resources).findByText(TITLE),
  ).resolves.toBeInTheDocument();
});

test("Show a newly published video in the already-open artifact gallery", async () => {
  installResourceGeometry(200);
  context.mocks.browser.matchMedia(true);
  context.mocks.data.userPreferences({ chatResourcesEnabledByDefault: false });
  const site = artifactSummary(
    "e0000000-0000-4000-a000-000000000998",
    "hosted-site",
    "Launch site",
  );
  const catalog = [site];
  mockArtifactConversation(context, {
    catalog,
    details: new Map([
      [
        site.id,
        hostedSiteArtifactDetail(site, {
          siteId: "f0000000-0000-4000-a000-000000000998",
          slug: "launch-site",
          url: "https://launch-site.example.test/",
        }),
      ],
    ]),
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    sharedWorkerTestTransport: "message-port",
  });
  const galleryTopic = chatArtifactCatalogChangedEvent(
    NAVIGATION_ARTIFACT_THREAD_ID,
  );
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(galleryTopic)).toBeTruthy();
  });
  await openResourceArtifact("Launch site");
  await screen.findByTitle("Launch site preview");
  click(
    buttonNamed(
      "Back to all artifacts",
      screen.getByTestId("artifact-sidebar"),
    ),
  );
  const gallery = await screen.findByTestId("thread-sidebar-artifacts");
  await expect(
    within(gallery).findByText("Launch site"),
  ).resolves.toBeInTheDocument();
  catalog.push(
    artifactSummary("e0000000-0000-4000-a000-000000000999", "file", TITLE),
  );
  await act(() => {
    context.mocks.ably.trigger(galleryTopic);
  });
  await expect(within(gallery).findByText(TITLE)).resolves.toBeInTheDocument();
});
