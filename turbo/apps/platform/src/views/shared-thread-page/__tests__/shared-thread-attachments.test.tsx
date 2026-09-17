import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const imageUrl = "https://a.okou.io/shared-threads/public/image/screenshot.png";
const fileUrl = "https://a.okou.io/shared-threads/public/file/brief.pdf";

test("Signed-out visitors can open prompt images and files in new tabs", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "Build a dashboard like this",
            attachments: [
              {
                filename: "screenshot.png",
                contentType: "image/png",
                size: 42,
                url: imageUrl,
              },
              {
                filename: "brief.pdf",
                contentType: "application/pdf",
                size: 80,
                url: fileUrl,
              },
            ],
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  expect(screen.getByText("Build a dashboard like this")).toBeInTheDocument();
  const imageLink = screen.getByLabelText("screenshot.png");
  const fileLink = screen.getByLabelText("brief.pdf");
  expect(imageLink).toHaveAttribute("href", imageUrl);
  expect(fileLink).toHaveAttribute("href", fileUrl);
  for (const link of [imageLink, fileLink]) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  expect(
    within(imageLink).getByRole("img", { name: "screenshot.png" }),
  ).toHaveAttribute(
    "src",
    "https://a.okou.io/cdn-cgi/image/width=480,height=320,fit=scale-down,format=auto,quality=85,metadata=none/shared-threads/public/image/screenshot.png",
  );
  expect(screen.queryByText("[File: screenshot.png]")).not.toBeInTheDocument();
});

test("Attachment-only prompts remain visible and active content is a file link", async () => {
  const url = "https://a.okou.io/shared-threads/public/file/diagram.svg";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "",
            attachments: [
              {
                filename: "diagram.svg",
                contentType: "image/svg+xml",
                size: 20,
                url,
              },
            ],
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const link = screen.getByLabelText("diagram.svg");
  expect(link).toHaveAttribute("href", url);
  expect(link).toHaveAttribute("target", "_blank");
  expect(within(link).queryByRole("img")).not.toBeInTheDocument();
});

test("A site the answer embeds presents itself instead of a broken image", async () => {
  const siteUrl = "https://launch-plan-review.okou.app/";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "assistant",
            content: `The site is ready.\n\n![Launch plan review](<${siteUrl}>)`,
            runIndex: 0,
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const card = await screen.findByTestId("markdown-site-preview");
  expect(card).toHaveAttribute("href", siteUrl);
  expect(card).toHaveAttribute("target", "_blank");
  expect(card).toHaveAttribute("rel", "noopener noreferrer");
  expect(within(card).getByText("Launch plan review")).toBeInTheDocument();
  expect(
    within(card).getByTitle("Site preview for Launch plan review"),
  ).toHaveAttribute("src", siteUrl);
  expect(within(card).queryByRole("img")).not.toBeInTheDocument();
  expect(
    screen.queryByTestId("markdown-image-preview-loading"),
  ).not.toBeInTheDocument();
  // A card is a block, so its paragraph may not stay a <p>.
  expect(card.closest("p")).toBeNull();
});
