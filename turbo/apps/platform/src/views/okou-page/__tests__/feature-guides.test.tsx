import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  featureGuidesContract,
  type FeatureGuideEdition,
} from "@okouai/api-contracts/contracts/feature-guides";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const path = "/agents/c0000000-0000-4000-a000-000000000001/chat";
const edition = Object.freeze<FeatureGuideEdition>({
  id: "monthly-update",
  revisionId: "11111111-1111-4111-8111-111111111111",
  content: {
    schemaVersion: 1,
    title: "More ways to put Okou to work",
    description: "Explore this month's new capabilities",
    items: [
      {
        featureId: "report",
        title: "Prepare a weekly report",
        description: "Summarize the work that matters",
        prompt: "Prepare my weekly report",
      },
      {
        featureId: "walkthrough",
        title: "See how it works",
        description: "A short guided example",
        media: {
          type: "walkthrough",
          steps: [
            {
              title: "Start with a goal",
              description: "Describe the result you want",
            },
            {
              title: "Review the result",
              description: "Check the draft before sharing",
            },
          ],
        },
      },
    ],
  },
});

function button(name: string, container: ParentNode = document.body) {
  const found = queryAllByRoleFast("button", container).find((b) => {
    return (
      b.textContent?.trim() === name || b.getAttribute("aria-label") === name
    );
  });
  if (!found) {
    throw new Error(`Button not found: ${name}`);
  }
  return found;
}

test("shows an enabled edition, records its display, and dismisses it with Escape", async () => {
  let seen = false;
  context.mocks.api(featureGuidesContract.current, ({ respond }) => {
    return respond(200, { edition });
  });
  context.mocks.api(featureGuidesContract.seen, ({ body, respond }) => {
    expect(body.revisionId).toBe(edition.revisionId);
    seen = true;
    return respond(200, { seen: true });
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.FeatureGuides]: true },
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Prepare a weekly report",
  });
  expect(
    within(dialog).getByText("Summarize the work that matters"),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(seen).toBeTruthy();
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await waitFor(() => {
    return expect(seen).toBeTruthy();
  });
});

test("cycles features in the footer, resets walkthroughs, and pre-fills a task without running it", async () => {
  const carouselEdition: FeatureGuideEdition = {
    ...edition,
    content: {
      ...edition.content,
      items: [
        ...edition.content.items,
        {
          featureId: "share",
          title: "Share the result",
          description: "Give your team a result they can open",
          media: {
            type: "image",
            url: "https://example.com/share.png",
            alt: "A result ready to share",
          },
        },
      ],
    },
  };
  context.mocks.api(featureGuidesContract.current, ({ respond }) => {
    return respond(200, { edition: carouselEdition });
  });
  context.mocks.api(featureGuidesContract.seen, ({ respond }) => {
    return respond(200, { seen: true });
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.FeatureGuides]: true },
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Prepare a weekly report",
  });
  const navigation = within(dialog).getByRole("group", {
    name: "Features in this update",
  });
  expect(button("Prepare a weekly report", navigation)).toHaveAttribute(
    "aria-current",
    "step",
  );
  click(button("Next feature", navigation));
  await expect(
    within(dialog).findByText("Start with a goal"),
  ).resolves.toBeInTheDocument();
  click(button("Next", dialog));
  await expect(
    within(dialog).findByText("Review the result"),
  ).resolves.toBeInTheDocument();
  click(button("Next feature", navigation));
  await expect(
    within(dialog).findByRole("img", { name: "A result ready to share" }),
  ).resolves.toBeInTheDocument();
  expect(button("Share the result", navigation)).toHaveAttribute(
    "aria-current",
    "step",
  );
  click(button("Next feature", navigation));
  await expect(
    within(dialog).findByRole("heading", { name: "Prepare a weekly report" }),
  ).resolves.toBeInTheDocument();
  click(button("Previous feature", navigation));
  await expect(
    within(dialog).findByRole("heading", { name: "Share the result" }),
  ).resolves.toBeInTheDocument();
  click(button("See how it works", navigation));
  await expect(
    within(dialog).findByText("Start with a goal"),
  ).resolves.toBeInTheDocument();
  click(button("Prepare a weekly report", navigation));
  click(button("Try this task", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await expect(
    screen.findByText("Prepare my weekly report"),
  ).resolves.toBeInTheDocument();
});

test("shows a Discord image, hides single-feature navigation, and opens setup with a text link", async () => {
  const discordEdition: FeatureGuideEdition = {
    id: "discord-guide",
    revisionId: "33333333-3333-4333-8333-333333333333",
    content: {
      schemaVersion: 1,
      title: "This month's updates",
      description: "Fresh ways to work with Okou",
      items: [
        {
          featureId: "discord-integration",
          title: "Your teammate, now in Discord",
          description: "Get work done in the conversation",
          media: {
            type: "image",
            url: "https://example.com/discord.png",
            alt: "Okou turns a Discord mention into a launch checklist",
          },
          action: { type: "connect-discord", label: "Explore Discord" },
        },
      ],
    },
  };
  context.mocks.api(featureGuidesContract.current, ({ respond }) => {
    return respond(200, { edition: discordEdition, preview: true });
  });
  context.mocks.browser.open();
  await setupPage({
    context,
    path: `${path}?featureGuidePreview=1`,
    featureSwitches: { [FeatureSwitchKey.FeatureGuides]: true },
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Your teammate, now in Discord",
  });
  const image = within(dialog).getByRole("img", {
    name: "Okou turns a Discord mention into a launch checklist",
  });
  expect(image).toHaveAttribute("src", "https://example.com/discord.png");
  expect(
    within(dialog).queryByRole("group", { name: "Features in this update" }),
  ).not.toBeInTheDocument();
  const connect = queryAllByRoleFast("link", dialog).find((link) => {
    return link.textContent?.trim() === "Explore Discord";
  });
  if (!connect) {
    throw new Error("Expected a Discord setup link");
  }
  expect(connect).toHaveAttribute("href", "/settings/discord");
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Meta>}");
  await user.click(connect);
  await user.keyboard("{/Meta}");
  expect(dialog).toBeInTheDocument();
  click(connect);
  await expect(
    screen.findByRole("heading", { name: "Connect to Discord" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test.each([
  {
    target: "artifacts",
    action: "open-artifacts",
    title: "Delete artifacts you no longer need",
    label: "Manage your artifacts",
    href: "/artifacts",
    destinationRole: "heading",
    destinationName: "Artifacts",
  },
  {
    target: "chats",
    action: "open-chats",
    title: "Choose who can view a shared chat",
    label: "Open your chats",
    href: "/",
    destinationRole: "textbox",
    destinationName: "Message",
  },
] as const)(
  "opens $target from the feature guide text link",
  async (example) => {
    const navigationEdition: FeatureGuideEdition = {
      ...edition,
      content: {
        ...edition.content,
        items: [
          {
            featureId: "overview",
            title: "This week's updates",
            description: "Explore the new capabilities",
          },
          {
            featureId: example.action,
            title: example.title,
            description: "Manage your work in Okou",
            action: { type: example.action, label: example.label },
          },
        ],
      },
    };
    context.mocks.api(featureGuidesContract.current, ({ respond }) => {
      return respond(200, { edition: navigationEdition, preview: true });
    });
    await setupPage({
      context,
      path: `${path}?featureGuidePreview=1`,
      featureSwitches: { [FeatureSwitchKey.FeatureGuides]: true },
    });
    const dialog = await screen.findByRole("dialog", {
      name: "This week's updates",
    });
    const navigation = within(dialog).getByRole("group", {
      name: "Features in this update",
    });
    click(button(example.title, navigation));
    await expect(
      within(dialog).findByRole("heading", { name: example.title }),
    ).resolves.toBeInTheDocument();
    const link = queryAllByRoleFast("link", dialog).find((candidate) => {
      return candidate.textContent?.trim() === example.label;
    });
    if (!link) {
      throw new Error("Expected a feature navigation link");
    }
    expect(link).toHaveAttribute("href", example.href);
    click(link);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await expect(
      screen.findByRole(example.destinationRole, {
        name: example.destinationName,
      }),
    ).resolves.toBeInTheDocument();
  },
);

test("keeps an already-seen edition closed based on the server response", async () => {
  context.mocks.api(featureGuidesContract.current, ({ respond }) => {
    return respond(200, { edition: null });
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.FeatureGuides]: true },
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("keeps the UI hidden while the feature switch is off", async () => {
  context.mocks.api(featureGuidesContract.current, ({ respond }) => {
    return respond(200, { edition });
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.FeatureGuides]: false },
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("replays a preview from the home link without acknowledging a real impression", async () => {
  let seen = false;
  context.mocks.api(featureGuidesContract.current, ({ query, respond }) => {
    expect(query?.preview).toBe("1");
    return respond(200, { edition, preview: true });
  });
  context.mocks.api(featureGuidesContract.seen, ({ respond }) => {
    seen = true;
    return respond(200, { seen: true });
  });
  await setupPage({
    context,
    path: "/?featureGuidePreview=1",
    featureSwitches: { [FeatureSwitchKey.FeatureGuides]: true },
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Prepare a weekly report",
  });
  expect(within(dialog).getByText("Preview")).toBeInTheDocument();
  click(button("Close feature guide", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(seen).toBeFalsy();
});

test("starts a newly loaded edition at its first card and walkthrough step", async () => {
  const nextEdition: FeatureGuideEdition = {
    id: "next-monthly-update",
    revisionId: "22222222-2222-4222-8222-222222222222",
    content: {
      schemaVersion: 1,
      title: "A new edition",
      description: "A fresh walkthrough",
      items: [
        {
          featureId: "new-walkthrough",
          title: "A new guide",
          description: "Start a different task",
          media: {
            type: "walkthrough",
            steps: [
              {
                title: "New edition start",
                description: "Only one step in this guide",
              },
            ],
          },
        },
      ],
    },
  };
  context.mocks.api(featureGuidesContract.current, ({ query, respond }) => {
    return query?.preview === "1"
      ? respond(200, { edition, preview: true })
      : respond(200, { edition: nextEdition });
  });
  await setupPage({
    context,
    path: `${path}?featureGuidePreview=1`,
    featureSwitches: { [FeatureSwitchKey.FeatureGuides]: true },
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Prepare a weekly report",
  });
  click(button("See how it works", dialog));
  await expect(
    within(dialog).findByText("Start with a goal"),
  ).resolves.toBeInTheDocument();
  click(button("Next", dialog));
  await expect(within(dialog).findByText("2 / 2")).resolves.toBeInTheDocument();
  click(button("Close feature guide", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const chatLink = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Chat";
  });
  if (!chatLink) {
    throw new Error("Chat navigation link not found");
  }
  click(chatLink);
  const nextDialog = await screen.findByRole("dialog", {
    name: "A new guide",
  });
  expect(within(nextDialog).getByText("New edition start")).toBeInTheDocument();
  expect(within(nextDialog).getByText("1 / 1")).toBeInTheDocument();
  expect(button("Previous", nextDialog)).toBeDisabled();
  expect(button("Next", nextDialog)).toBeDisabled();
});
