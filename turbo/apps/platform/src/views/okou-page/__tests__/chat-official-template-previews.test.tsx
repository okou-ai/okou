import { screen, waitFor } from "@testing-library/react";
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

async function expectImagePreview() {
  click(link("Sunlit bookshop.jpg"));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", IMAGE);
  await closePreview();
}

async function expectDeckPreview() {
  click(link("View deck"));
  expect(
    (await screen.findByTestId("artifact-dialog-site-frame")).querySelector(
      "iframe",
    ),
  ).toHaveAttribute("src", DECK);
  await closePreview();
}

async function expectVideoPreview() {
  click(link("View video"));
  const dialog = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    return expect(dialog.querySelector("video")).toHaveAttribute("src", VIDEO);
  });
  expect(dialog.querySelector("video")).toHaveAttribute("controls");
}

const officialPreviewCases = [
  { media: "image", expectPreview: expectImagePreview },
  { media: "deck", expectPreview: expectDeckPreview },
  { media: "video", expectPreview: expectVideoPreview },
] as const;

test.each(
  [true, false].flatMap((runless) => {
    return officialPreviewCases.map((preview) => {
      return { runless, ...preview };
    });
  }),
)(
  "Official $media example uses an ordinary preview with runless=$runless and no uploaded artifacts",
  async ({ runless, expectPreview }) => {
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
    await expectPreview();
  },
);

test("Unlisted external HTML and altered catalog URLs keep ordinary link behavior", async () => {
  const urls = [
    "https://example.com/page.html",
    "https://static.vm0.io/vm0/artifact-templates/unlisted.html",
    DECK.replace("static.vm0.io", "static.vm0.io.evil.example"),
    `${DECK}?redirect=https://example.com`,
    DECK.replace("https://", "http://"),
    DECK.replace("https://", "https://user@"),
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
