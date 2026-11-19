import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import {
  sharedThreadsContract,
  type SharedMessage,
} from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const origin = "https://app.okou.ai/artifacts";
const image = `${origin}/aaaaaa1111.png#detail`;
const slides = `${origin}/bbbbbb2222.html#slide-2`;
const video = `${origin}/cccccc3333.mp4`;
const audio = `${origin}/dddddd4444.mp3`;
const pdf = `${origin}/eeeeee5555.pdf`;
const storage = "https://files.example.test";

async function openConversation(messages: SharedMessage[]) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread({ messages }));
  });
  await setupSharedThreadPage(context, { host: "app.okou.ai" });
}

test("An anonymous reader sees temporary previews while sharing and copy retain stable references", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const content = [
    `![Launch screenshot](${image})`,
    `![Launch slides](${slides})`,
    `![Launch video](${video})`,
    `![Launch audio](${audio})`,
    `![Launch brief](${pdf})`,
    `[Download the brief](${pdf})`,
  ].join("\n\n");
  const types = new Map([
    ["aaaaaa1111.png", "image/png"],
    ["bbbbbb2222.html", "text/html"],
    ["cccccc3333.mp4", "video/mp4"],
    ["dddddd4444.mp3", "audio/mpeg"],
    ["eeeeee5555.pdf", "application/pdf"],
  ]);
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const filename = params.reference;
      const contentType = types.get(filename);
      if (!contentType) {
        throw new Error(`Unexpected snapshot reference: ${filename}`);
      }
      const url = `${storage}/preview/${filename}?access=temporary`;
      return respond(200, {
        url,
        filename,
        contentType,
        expiresAt: "2099-01-01T00:00:00Z",
        downloadUrl: `${storage}/download/${filename}`,
        sharedThreadSnapshot: true,
        target: {
          kind: contentType === "text/html" ? "html" : "file",
          id: "a0000000-0000-4000-8000-000000000001",
        },
      });
    },
  );

  await openConversation([{ messageIndex: 0, role: "assistant", content }]);

  const thumbnail = await screen.findByRole("img", {
    name: "Launch screenshot",
  });
  expect(thumbnail).toHaveAttribute(
    "src",
    `${storage}/preview/aaaaaa1111.png?access=temporary#detail`,
  );
  expect(thumbnail.closest("a")).toHaveAttribute("href", image);

  const html = getLinkByName("Launch slides");
  expect(html).toHaveAttribute("href", slides);
  await waitFor(() => {
    expect(html.querySelector("iframe")).toHaveAttribute(
      "src",
      `${storage}/preview/bbbbbb2222.html?access=temporary#slide-2`,
    );
  });
  const videoPreview = queryAllByRoleFast("button").find((item) => {
    return item.getAttribute("aria-label") === "Preview Launch video";
  });
  await waitFor(() => {
    expect(videoPreview?.querySelector("video")).toHaveAttribute(
      "src",
      `${storage}/preview/cccccc3333.mp4?access=temporary#t=0.001`,
    );
  });
  expect(
    queryAllByRoleFast("link").find((item) => {
      return item.getAttribute("href") === audio;
    }),
  ).toHaveAttribute("href", audio);
  expect(screen.getByTestId("markdown-artifact-preview-pdf")).toHaveAttribute(
    "href",
    pdf,
  );
  expect(getLinkByName("Download the brief")).toHaveAttribute("href", pdf);

  const copy = queryAllByRoleFast("button").find((item) => {
    return item.getAttribute("aria-label") === "Copy message";
  });
  if (!copy) {
    throw new Error("Missing Copy message action");
  }
  click(copy);
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([content]);
  });
});

test("Denied shared snapshots show unavailable previews and keep stable file links", async () => {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Artifact unavailable" },
    });
  });

  await openConversation([
    {
      messageIndex: 0,
      role: "assistant",
      content: `![Screenshot](${image})\n\n![Slides](${slides})`,
    },
    {
      messageIndex: 1,
      role: "user",
      content: "Check the screenshot",
      attachments: [
        {
          filename: "photo.png",
          contentType: "image/png",
          size: 42,
          url: image,
        },
      ],
    },
  ]);

  await waitFor(() => {
    const unavailable = screen.getAllByRole("status").filter((status) => {
      return (
        status.getAttribute("aria-label") === "You can’t view this artifact" ||
        status.textContent?.includes("You can’t view this artifact")
      );
    });
    expect(unavailable).toHaveLength(3);
  });
  expect(
    screen.queryByRole("img", { name: "Screenshot" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("img", { name: "photo.png" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByTitle("Site preview for Slides"),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("link").find((item) => {
      return item.getAttribute("href") === slides;
    }),
  ).toHaveAttribute("href", slides);
  expect(getLinkByName("photo.png")).toHaveAttribute("href", image);
});
