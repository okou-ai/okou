import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";
import { findNamedButton } from "./chat-attachment-test-helpers.ts";

const context = testContext();
const IMAGE =
  "https://static.vm0.io/vm0/artifact-templates/illustration/assets/bb2f13d1-f849-4a5c-a493-524bc0eda5c2/ref-bookshop-interior.jpg";
const DECK =
  "https://static.vm0.io/vm0/artifact-templates/presentation/daf7c2d1-5195-4c09-ad4b-8d85778fc104/playful-launch-presentation.html";
const VIDEO =
  "https://static.vm0.io/vm0/artifact-templates/video/df99de74-8eea-420c-86d1-c104ba5ba6b6/video-df99de74.mp4";

const WELCOME_ASSET_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-14-4128f97d2754";
const WELCOME_GUIDE_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-14-e894e2da8d9e/guide";
const WORKFLOW_GUIDE = `${WELCOME_GUIDE_BASE}/okou-team-workflow-guide.html`;

function link(name: string) {
  const element = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent === name;
  });
  if (!element) {
    throw new Error(`Missing link: ${name}`);
  }
  return element;
}

async function closePreview() {
  click(await findNamedButton("Close"));
  await waitFor(() => {
    return expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
}

test.each([true, false])(
  "Official examples use ordinary previews with runless=%s and no uploaded artifacts",
  async (runless) => {
    const chat = createMarkdownChatFixture(context);
    const content = `## Hello from Okou\n\n[Sunlit bookshop.jpg](${IMAGE})\n\n![Launch deck.html](${DECK})\n\n![Epic grandeur.mp4](${VIDEO})\n\n[View deck](${DECK})\n\n[View video](${VIDEO})\n\nWelcome text is ready before media loads.`;
    const row = chat.outputMessage(content, { seqId: 1 });
    chat.install({
      rows: () => {
        return runless
          ? [
              {
                ...row,
                runId: null,
                runEventId: null,
                runEventSequenceNumber: null,
              },
            ]
          : [row, chat.runCompleted({ seqId: 2 })];
      },
    });
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: [] });
    });
    await setupPage({ context, path: chat.path });
    await screen.findByText("Welcome text is ready before media loads.");
    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeEnabled();
    expect(screen.queryByText(/^Working for /u)).toBeNull();
    expect(
      document.querySelector('[data-role="assistant-thinking"]') === null,
    ).toBe(runless);
    click(link("Sunlit bookshop.jpg"));
    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute("src", IMAGE);
    await closePreview();
    click(link("View deck"));
    expect(
      (await screen.findByTestId("artifact-dialog-site-frame")).querySelector(
        "iframe",
      ),
    ).toHaveAttribute("src", DECK);
    await closePreview();
    click(link("View video"));
    const dialog = await screen.findByTestId("attachment-lightbox");
    await waitFor(() => {
      return expect(dialog.querySelector("video")).toHaveAttribute(
        "src",
        VIDEO,
      );
    });
    expect(dialog.querySelector("video")).toHaveAttribute("controls");
  },
);

test("Welcome diagrams and the workflow guide open without uploaded artifacts", async () => {
  context.mocks.http.get(WORKFLOW_GUIDE, () => {
    return HttpResponse.html(
      '<!doctype html><html><body><main class="deck"><section class="slide">Share a workflow with your team</section></main></body></html>',
    );
  });
  const diagrams = [
    ["Team learning", "team-learning-loop.png"],
    ["Shared workflow", "shared-workflow.png"],
    ["Slack conversations", "slack-conversations.png"],
  ] as const;
  const chat = createMarkdownChatFixture(context);
  const content = [
    ...diagrams.map(([name, filename]) => {
      return `[${name}](${WELCOME_ASSET_BASE}/${filename})`;
    }),
    `[![Workflow guide cover](${WELCOME_GUIDE_BASE}/cover.png)](${WORKFLOW_GUIDE})`,
    `[View workflow guide](${WORKFLOW_GUIDE})`,
  ].join("\n\n");
  const row = chat.outputMessage(content, { seqId: 1 });
  chat.install({
    rows: () => {
      return [
        {
          ...row,
          runId: null,
          runEventId: null,
          runEventSequenceNumber: null,
        },
      ];
    },
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, { runs: [] });
  });
  await setupPage({ context, path: chat.path });
  await screen.findByText("View workflow guide");
  click(await screen.findByRole("img", { name: "Workflow guide cover" }));
  expect(
    (await screen.findByTestId("artifact-dialog-site-frame")).querySelector(
      "iframe",
    ),
  ).toHaveAttribute("src", WORKFLOW_GUIDE);
  await closePreview();
  for (const [name, filename] of diagrams) {
    click(link(name));
    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute("src", `${WELCOME_ASSET_BASE}/${filename}`);
    await closePreview();
  }
  click(link("View workflow guide"));
  expect(
    (await screen.findByTestId("artifact-dialog-site-frame")).querySelector(
      "iframe",
    ),
  ).toHaveAttribute("src", WORKFLOW_GUIDE);
});

test("Unlisted external HTML and altered catalog URLs keep ordinary link behavior", async () => {
  const urls = [
    "https://example.com/page.html",
    "https://static.vm0.io/vm0/artifact-templates/unlisted.html",
    DECK.replace("static.vm0.io", "static.vm0.io.evil.example"),
    `${DECK}?redirect=https://example.com`,
    DECK.replace("https://", "http://"),
    DECK.replace("https://", "https://user@"),
    `${WELCOME_GUIDE_BASE}/unlisted.html`,
    `${WORKFLOW_GUIDE}?redirect=https://example.com`,
    WORKFLOW_GUIDE.replace("static.vm0.io", "static.vm0.io.evil.example"),
  ];
  const chat = createMarkdownChatFixture(context);
  chat.install({
    rows: () => {
      return [
        chat.outputMessage(
          urls
            .map((url, index) => {
              return `[External ${index}](${url})`;
            })
            .join("\n\n"),
          { seqId: 1 },
        ),
        chat.runCompleted({ seqId: 2 }),
      ];
    },
  });
  await setupPage({ context, path: chat.path });
  await screen.findByText("External 0");
  for (const [index, url] of urls.entries()) {
    const external = link(`External ${index}`);
    expect(external).toHaveAttribute("href", url);
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  }
});
