import {
  sharedThreadsContract,
  type SharedMessage,
} from "@okouai/api-contracts/contracts/shared-threads";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const screenshot = "https://cdn.vm0.io/public/screenshot.png";
const pdf = "https://cdn.vm0.io/public/report.pdf";
const svg = "https://cdn.vm0.io/public/diagram.svg";

async function openConversation(message: SharedMessage) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread({ messages: [message] }));
  });
  await setupSharedThreadPage(context, { host: "app.okou.ai" });
}

function expectSafeAttachment(filename: string, url: string) {
  const link = getLinkByName(filename);
  expect(link).toHaveAttribute("href", url);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
}

test("Shared prompt files keep their original links and a sized screenshot thumbnail", async () => {
  await openConversation({
    messageIndex: 0,
    role: "user",
    content: "Review these files.",
    attachments: [
      {
        filename: "screenshot.png",
        contentType: "image/png",
        size: 15,
        url: screenshot,
      },
      {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 18,
        url: pdf,
      },
    ],
  });

  const thumbnail = await screen.findByRole("img", { name: "screenshot.png" });
  expect(thumbnail).toHaveAttribute(
    "src",
    expect.stringMatching(/\/cdn-cgi\/image\/[^/]*width=480[^/]*height=320/u),
  );
  expectSafeAttachment("screenshot.png", screenshot);
  expectSafeAttachment("report.pdf", pdf);
});

test("An unlinked Markdown image opens its original URL from the thumbnail", async () => {
  await openConversation({
    messageIndex: 0,
    role: "assistant",
    content: `![Launch screenshot](${screenshot})`,
  });

  const thumbnail = await screen.findByRole("img", {
    name: "Launch screenshot",
  });
  expect(thumbnail).toHaveAttribute(
    "src",
    expect.stringMatching(/\/cdn-cgi\/image\/[^/]*width=800[^/]*height=720/u),
  );
  expect(thumbnail.closest("a")).toHaveAttribute("href", screenshot);
});

test("An SVG-only prompt shows the source file link without rendering an image", async () => {
  await openConversation({
    messageIndex: 0,
    role: "user",
    content: "",
    attachments: [
      {
        filename: "diagram.svg",
        contentType: "image/svg+xml",
        size: 10,
        url: svg,
      },
    ],
  });

  await expect(screen.findByText("diagram.svg")).resolves.toBeInTheDocument();
  const link = getLinkByName("diagram.svg");
  expect(link).toHaveAttribute("href", svg);
  expect(link).toHaveAttribute("target", "_blank");
  expect(
    screen.queryByRole("img", { name: "diagram.svg" }),
  ).not.toBeInTheDocument();
});
