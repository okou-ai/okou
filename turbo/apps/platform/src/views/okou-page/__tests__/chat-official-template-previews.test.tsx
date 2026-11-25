import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { randomUUID } from "node:crypto";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  WELCOME_THREAD_ASSETS as legacy,
  MY_OKOU_WELCOME_THREAD_ASSETS as current,
} from "@okouai/core/welcome-thread-assets";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";
const context = testContext();
const bookshop =
  "https://static.vm0.io/vm0/artifact-templates/illustration/assets/bb2f13d1-f849-4a5c-a493-524bc0eda5c2/ref-bookshop-interior.jpg";
function welcomeConversation(markdown: string, completed = false) {
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, { runs: [] });
  });
  const chat = createMarkdownChatFixture(context);
  const answer = chat.outputMessage(markdown, { seqId: 1 });
  chat.install({
    rows: () => {
      return completed
        ? [answer, chat.runCompleted({ seqId: 2 })]
        : [
            {
              ...answer,
              runId: null,
              runEventId: null,
              runEventSequenceNumber: null,
            },
          ];
    },
  });
  return chat.path;
}

function findFrame(url: string) {
  return waitFor(() => {
    const frame = Array.from(document.querySelectorAll("iframe")).find(
      (item) => {
        return item.src === new URL(url).href;
      },
    );
    if (!frame) {
      throw new Error(
        "No visible preview loaded for " +
          url +
          "; current frames " +
          Array.from(document.querySelectorAll("iframe"))
            .map((element) => {
              return element.src;
            })
            .join(", "),
      );
    }
    return frame;
  });
}

test("chat-official-template-previews-001 the saved launch deck shows its original cover before opening the published HTML", async () => {
  const url = legacy.presentationArtifactUrl;
  const cover =
    "https://static.vm0.io/vm0/welcome-thread/2026-10-26-previews/sproutpop-a826bd3d2831.png";
  context.mocks.api(hostContract.sitePreview, ({ query, respond }) => {
    expect(query.hostname).toBe(new URL(url).hostname);
    return respond(200, {
      url: url + "/",
      expiresAt: null,
      previewImageUrl: cover,
    });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: welcomeConversation("![Launch deck](" + url + ")"),
  });
  const coverLink = await waitFor(() => {
    const image = document.querySelector(
      'img[src*="sproutpop-a826bd3d2831.png"]',
    );
    expect(image).toBeVisible();
    const link = image?.closest("a");
    if (!link) {
      throw new Error("The launch deck cover has no preview link");
    }
    return link;
  });
  expect(document.querySelector("iframe")).toBeNull();
  click(coverLink);
  const frame = await screen.findByTestId("artifact-sidebar-body-html");
  await waitFor(() => {
    return expect(new URL(frame.getAttribute("src")!, location.href).href).toBe(
      new URL(url).href,
    );
  });
});

test.each([
  ["chat-official-template-previews-005", current.myOkouQuickStartUrl],
  [
    "chat-official-template-previews-012",
    "https://welcome-my-okou-20261125.okou.app",
  ],
] as const)(
  "%s an isolated deployment opens the English My Okou guide inside a frame",
  async (_id, url) => {
    await setupPage({
      context,
      host: "isolated-app.example.org",
      path: welcomeConversation("[My Okou quick start (English)](" + url + ")"),
    });
    click(await screen.findByText("My Okou quick start (English)"));
    await expect(findFrame(url)).resolves.toBeVisible();
  },
);

test.each([
  ["chat-official-template-previews-006", true],
  ["chat-official-template-previews-009", false],
] as const)(
  "%s the bookshop opens from a ready welcome message",
  async (_id, completed) => {
    await setupPage({
      context,
      path: welcomeConversation(
        "The bookshop study is ready.\n\n[Bookshop interior](" + bookshop + ")",
        completed,
      ),
    });
    await screen.findByText("The bookshop study is ready.");
    if (completed) {
      await screen.findByText(/^Delivered at /);
    }
    const link = await screen.findByText("Bookshop interior");
    expect(screen.getByLabelText("Message")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    expect(screen.queryByText(/^Working for /)).toBeNull();
    expect(queryAction("button", "Stop")).toBeNull();
    click(link);
    await waitFor(() => {
      return expect(
        document.querySelector(
          '[data-testid="artifact-sidebar"] img[src="' + bookshop + '"]',
        ),
      ).toBeVisible();
    });
  },
);
test("chat-official-template-previews-010 nine welcome illustrations and the guide open from a runless conversation", async () => {
  const pictures = [
    legacy.campaignVisualUrl,
    legacy.telegramSceneUrl,
    current.personalInstructionsUrl,
    legacy.slackSceneUrl,
    current.workflowSharingUrl,
    legacy.modelTiersUrl,
    legacy.workflowTemplatePickerUrl,
    legacy.newAgentDialogUrl,
    current.workflowInstructionsUrl,
  ];
  const imageFiles = pictures
    .filter((picture) => {
      return new URL(picture).pathname.startsWith("/artifacts/");
    })
    .map((picture) => {
      const reference = new URL(picture).pathname.split("/").at(-1)!;
      return {
        picture,
        reference,
        id: randomUUID(),
        previewUrl: "https://welcome-images.example.test/" + reference,
        contentType: reference.endsWith(".jpg") ? "image/jpeg" : "image/png",
      };
    });
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const image = imageFiles.find((file) => {
        return file.reference === params.reference;
      });
      if (!image) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown welcome image" },
        });
      }
      return respond(200, {
        url: image.previewUrl,
        downloadUrl: image.previewUrl,
        downloadAllowed: true,
        expiresAt: "2099-02-01T00:00:00Z",
        filename: image.reference,
        contentType: image.contentType,
        target: { kind: "file", id: image.id },
      });
    },
  );
  const url = legacy.quickStartUrl;
  const snapshot = "https://ps-" + "a".repeat(48) + ".okou.app/";
  context.mocks.api(hostContract.sitePreview, ({ query, respond }) => {
    if (query.hostname === new URL(current.myOkouQuickStartUrl).hostname) {
      return respond(200, {
        url: current.myOkouQuickStartUrl + "/",
        expiresAt: null,
      });
    }
    expect(query.hostname).toBe(new URL(url).hostname);
    return respond(200, { url: snapshot, expiresAt: "2099-02-01T00:00:00Z" });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: welcomeConversation(
      [
        ...pictures.map((u, i) => {
          return "[Diagram " + (i + 1) + "](" + u + ")";
        }),
        "[Quick start](" + url + ")",
      ].join("\n\n"),
    ),
  });
  for (const [index, picture] of pictures.entries()) {
    const previewUrl =
      imageFiles.find((image) => {
        return image.picture === picture;
      })?.previewUrl ?? picture;
    click(await screen.findByText("Diagram " + (index + 1)));
    await waitFor(() => {
      return expect(
        document.querySelector(
          '[data-testid="artifact-sidebar"] img[src="' + previewUrl + '"]',
        ),
      ).toBeVisible();
    });
    click(await findAction("button", "Close artifact"));
    await waitFor(() => {
      return expect(screen.queryByTestId("artifact-sidebar")).toBeNull();
    });
  }
  click(await screen.findByText("Quick start"));
  await expect(findFrame(snapshot)).resolves.toBeVisible();
});

test("chat-official-template-previews-011 unrelated and altered catalogue URLs remain ordinary hyperlinks", async () => {
  const base = current.myOkouQuickStartUrl;
  const deck = PRESENTATION_TEMPLATE_PICKER_ITEMS[0].embedUrl;
  const urls = [
    "https://reports.example.org/sheet.html",
    "https://static.vm0.io/vm0/artifact-templates/unlisted.html",
    base + ".example.org",
    base + "?utm_source=x",
    base.replace("https:", "http:"),
    base.replace("https://", "https://guest@"),
    base + "/archive/help.html",
    deck + "?edition=other",
    deck.replace("https:", "http:"),
    deck.replace("https://", "https://guest@"),
    deck.replace("static.vm0.io", "static.vm0.io.example.org"),
  ];
  await setupPage({
    context,
    path: welcomeConversation(
      urls
        .map((url, i) => {
          return "[Reference " + i + "](" + url + ")";
        })
        .join("\n\n"),
    ),
  });
  for (const [i, url] of urls.entries()) {
    const link = await findAction("link", "Reference " + i);
    expect(link).toHaveAttribute("href", url);
    expect(link).toBeVisible();
    const handled = context.mocks.deferred<boolean>();
    window.addEventListener(
      "click",
      (event) => {
        handled.resolve(event.defaultPrevented);
        event.preventDefault();
      },
      { once: true },
    );
    await userEvent.click(link);
    expect(link).toHaveAttribute("target", "_blank");
    await expect(handled.promise).resolves.toBeFalsy();
    expect(screen.queryByTestId("artifact-sidebar")).toBeNull();
  }
});
