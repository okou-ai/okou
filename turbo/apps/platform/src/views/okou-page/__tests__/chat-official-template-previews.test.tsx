import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { hostContract } from "@okouai/api-contracts/contracts/host";
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

const WELCOME_STEP_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-17-3f913309fe14";
const WELCOME_SCENE_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-17-1e76170cef99";
const QUICK_START = "https://4nnp6iwpss.okou.app";

test.each([
  {
    name: "sproutpop-launch-deck",
    url: "https://sproutpop-launch-deck-p9jk.okou.app",
    cover: "sproutpop-a826bd3d2831.png",
  },
  {
    name: "coastal-hotel-example",
    url: "https://coastal-hotel-example.okou.app",
    cover: "coastal-hotel-d2b4e1caa3c1.png",
  },
  {
    name: "Quick start",
    url: QUICK_START,
    cover: "quick-start-eb0e18d9a32b.png",
  },
])(
  "An existing welcome message shows the $name cover before opening the HTML",
  async ({ name, url, cover }) => {
    const chat = createMarkdownChatFixture(context);
    const row = chat.outputMessage(`![${name}](${url})`, { seqId: 1 });
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
    const previewImageUrl = `https://static.vm0.io/vm0/welcome-thread/2026-10-26-previews/${cover}`;
    const sharedSnapshot = url === QUICK_START;
    const previewUrl = sharedSnapshot
      ? `https://ps-${"1".repeat(48)}.okou.app/`
      : `${url}/`;
    context.mocks.api(hostContract.sitePreview, ({ respond }) => {
      return respond(200, {
        url: previewUrl,
        expiresAt: sharedSnapshot ? "2099-01-01T00:00:00.000Z" : null,
        previewImageUrl,
      });
    });
    await setupPage({ context, path: chat.path, host: "app.okou.ai" });
    const image = await screen.findByTestId("attachment-preview-thumbnail");
    expect(image).toHaveAttribute("src", expect.stringContaining(cover));
    expect(document.querySelector("iframe")).toBeNull();
    const card = image.closest("a");
    if (!card) {
      throw new Error("Missing welcome preview link");
    }
    click(card);
    await waitFor(() => {
      expect(
        screen
          .getByTestId("artifact-dialog-site-frame")
          .querySelector("iframe"),
      ).toHaveAttribute("src", sharedSnapshot ? previewUrl : url);
    });
  },
);

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
  { media: "image", expectPreview: expectImagePreview, runless: false },
  { media: "deck", expectPreview: expectDeckPreview, runless: false },
  { media: "video", expectPreview: expectVideoPreview, runless: false },
  { media: "image", expectPreview: expectImagePreview, runless: true },
] as const;

test.each(officialPreviewCases)(
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

test("Welcome diagrams and the quick start open without uploaded artifacts", async () => {
  const diagrams = [
    ["Slack scene", `${WELCOME_SCENE_BASE}/slack-scene.png`],
    ["Model tiers", `${WELCOME_SCENE_BASE}/model-tiers.png`],
    ["Workflow templates", `${WELCOME_STEP_BASE}/workflow-template-picker.png`],
    ["New agent", `${WELCOME_STEP_BASE}/new-agent.png`],
  ] as const;
  const chat = createMarkdownChatFixture(context);
  const content = [
    ...diagrams.map(([name, url]) => {
      return `[${name}](${url})`;
    }),
    `[View the quick start](${QUICK_START})`,
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
  const previewUrl = `https://ps-${"c".repeat(48)}.okou.app/`;
  context.mocks.api(hostContract.sitePreview, ({ respond }) => {
    return respond(200, {
      url: previewUrl,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  await setupPage({ context, path: chat.path, host: "app.okou.ai" });
  await screen.findByText("View the quick start");
  for (const [name, url] of diagrams) {
    click(link(name));
    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute("src", url);
    await closePreview();
  }
  click(link("View the quick start"));
  await waitFor(() => {
    const element = screen.getByTestId("artifact-dialog-site-frame");
    const frame =
      element instanceof HTMLIFrameElement
        ? element
        : element.querySelector("iframe");
    expect(frame).toHaveAttribute("src", previewUrl);
  });
});

test("Unlisted external HTML and altered catalog URLs keep ordinary link behavior", async () => {
  const urls = [
    "https://example.com/page.html",
    "https://static.vm0.io/vm0/artifact-templates/unlisted.html",
    DECK.replace("static.vm0.io", "static.vm0.io.evil.example"),
    `${DECK}?redirect=https://example.com`,
    DECK.replace("https://", "http://"),
    DECK.replace("https://", "https://user@"),
    `${QUICK_START}/unlisted.html`,
    QUICK_START.replace("okou.app", "okou.app.evil.example"),
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
  }
});
