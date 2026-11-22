import {
  featureGuidesContract,
  type FeatureGuideContent,
} from "@okouai/api-contracts/contracts/feature-guides";
import { fireEvent, screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
  click,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
type Card = FeatureGuideContent["items"][number];
function cards() {
  const report: Card = {
    featureId: "report",
    title: "Weekly report",
    description: "Gather the highlights for this week.",
    prompt: "Prepare my weekly report.",
  };
  const walk: Card = {
    featureId: "walking",
    title: "Two steps",
    description: "Follow the example.",
    media: {
      type: "walkthrough",
      steps: [
        {
          title: "Start with a goal",
          description: "Write what a good result looks like.",
        },
        {
          title: "Review the result",
          description: "Read the completed report.",
        },
      ],
    },
  };
  const share: Card = {
    featureId: "share",
    title: "Share the report",
    description: "Deliver this report to the team.",
  };
  return { report, walk, share };
}
async function openGuide(
  cards: Card[],
  preview = true,
  path = preview ? "/?featureGuidePreview=1" : "/",
) {
  const seen = new Set<string>();
  context.mocks.api(featureGuidesContract.seen, ({ params, respond }) => {
    seen.add(params.editionId);
    return respond(200, { seen: true });
  });
  context.mocks.api(featureGuidesContract.current, ({ query, respond }) => {
    expect(query?.preview === "1").toBe(preview);
    return respond(200, {
      preview,
      edition: {
        id: "harbor-edition",
        revisionId: "1adbe1fa-7a46-4110-be8a-b1fb52e90a1a",
        content: {
          schemaVersion: 1,
          title: "Harbor guide",
          description: "New features",
          items: cards,
        },
      },
    });
  });
  await setupPage({ context, path, host: "app.okou.ai" });
  const dialog = await screen.findByRole("dialog", { name: cards[0]!.title });
  return { seen, dialog, guide: within(dialog) };
}
type Point = { identifier: number; clientX: number; clientY: number };

function gesture(
  surface: Element,
  dx: number,
  dy = 0,
  options?: { cancel?: boolean; multiple?: boolean },
) {
  const origin: Point = { identifier: 7, clientX: 200, clientY: 50 };
  fireEvent.touchStart(surface, {
    touches: options?.multiple
      ? [origin, { ...origin, identifier: 8 }]
      : [origin],
  });
  if (options?.cancel) {
    fireEvent.touchCancel(surface);
  }
  fireEvent.touchEnd(surface, {
    touches: [],
    changedTouches: [
      { ...origin, clientX: origin.clientX + dx, clientY: origin.clientY + dy },
    ],
  });
}
test("feature-guides-002 walk the report guide, revisit each card and prepare its task", async () => {
  const { report, walk, share } = cards();
  const { guide, dialog } = await openGuide([report, walk, share], false);
  await expect(
    findFastControl("button", report.title, dialog),
  ).resolves.toHaveAttribute("aria-current", "step");
  click(await findFastControl("button", "Next feature", dialog));
  await guide.findByText("Start with a goal");
  click(await findFastControl("button", "Next", dialog));
  await guide.findByText("Review the result");
  gesture(guide.getByText(walk.description), -120);
  await guide.findByRole("heading", { name: share.title });
  expect(queryAllByRoleFast("link", dialog)[0] ?? null).toBeNull();
  expect(queryFastControl("button", "Try this task", dialog)).toBeNull();
  gesture(guide.getByText(share.description), 120);
  await guide.findByText("Start with a goal");
  gesture(guide.getByText(walk.description), 120);
  await guide.findByRole("heading", { name: report.title });
  click(await findFastControl("button", "Previous feature", dialog));
  await guide.findByRole("heading", { name: share.title });
  click(await findFastControl("button", "Previous feature", dialog));
  await guide.findByText("Start with a goal");
  click(await findFastControl("button", report.title, dialog));
  click(await findFastControl("button", "Try this task", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  await expect(findComposerEditor()).resolves.toHaveTextContent(report.prompt!);
});
test("feature-guides-003 only a completed horizontal gesture on the card turns the page", async () => {
  const { report, walk } = cards();
  const { guide, dialog } = await openGuide([report, walk]);
  const description = guide.getByText(report.description);
  for (const [dx, dy, options] of [
    [-5, 0, {}],
    [-10, 140, {}],
    [-115, 0, { multiple: true }],
    [-110, 0, { cancel: true }],
  ] as const) {
    gesture(description, dx, dy, options);
    await expect(
      findFastControl("button", report.title, dialog),
    ).resolves.toHaveAttribute("aria-current", "step");
  }
  gesture(description, -130);
  await guide.findByText("Start with a goal");
  const next = await findFastControl("button", "Next", dialog);
  gesture(next, -150);
  expect(guide.getByText("Start with a goal")).toBeVisible();
  click(next);
  await guide.findByText("Review the result");
});
test("feature-guides-004 touching the player preserves video controls and swiping its description changes cards", async () => {
  const { report } = cards();
  const video: Card = {
    featureId: "clip",
    title: "Demo film",
    description: "Swipe here after watching.",
    media: {
      type: "video",
      url: "https://fixtures.example/demo.mp4",
      posterUrl: "https://fixtures.example/poster.png",
      captionsUrl: "https://fixtures.example/demo.vtt",
    },
  };
  const { guide, dialog } = await openGuide([video, report]);
  const player = dialog.querySelector("video");
  if (!player) {
    throw new Error("The demo player is missing");
  }
  expect(player.controls).toBeTruthy();
  gesture(player, -135);
  expect(guide.getByRole("heading", { name: video.title })).toBeVisible();
  expect(player.controls).toBeTruthy();
  gesture(guide.getByText(video.description), -135);
  await guide.findByRole("heading", { name: report.title });
});
test("feature-guides-007 the preview chats link opens the home composer and leaves the edition unseen", async () => {
  const { report } = cards();
  const chats: Card = {
    featureId: "chats",
    title: "Conversations",
    description: "Start a conversation.",
    action: { type: "open-chats", label: "Go to Chats" },
  };
  const { dialog, seen } = await openGuide(
    [report, chats],
    true,
    "/?featureGuidePreview=1&from=guide",
  );
  click(await findFastControl("button", chats.title, dialog));
  click(await findFastControl("link", "Go to Chats", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(location.pathname + location.search).toBe("/?featureGuidePreview=1");
  });
  await expect(findComposerEditor()).resolves.toBeVisible();
  expect(seen).not.toContain("harbor-edition");
});
test("feature-guides-008 no edition leaves the signed-in home composer available without an announcement", async () => {
  const delivered = context.mocks.deferred<void>();
  context.mocks.api(featureGuidesContract.current, ({ respond }) => {
    delivered.resolve();
    return respond(200, { edition: null });
  });
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  await delivered.promise;
  await expect(findComposerEditor()).resolves.toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
});
