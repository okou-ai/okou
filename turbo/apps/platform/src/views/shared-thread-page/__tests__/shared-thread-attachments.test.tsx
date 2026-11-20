import {
  sharedThreadsContract,
  type SharedMessage,
} from "@okouai/api-contracts/contracts/shared-threads";
import { screen, fireEvent, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  sharedThread,
  setupSharedThreadPage,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const media = "https://cdn.okou.io/fieldwork";
function readMessage(message: SharedMessage) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread({ messages: [message] }));
  });
  return setupSharedThreadPage(context, { host: "app.okou.ai" });
}
function attachment(filename: string, contentType: string) {
  return { filename, contentType, size: 1200, url: `${media}/${filename}` };
}
function expectThumbnail(
  image: HTMLElement,
  source: string,
  width: number,
  height: number,
) {
  const original = new URL(source);
  const thumbnail = new URL(image.getAttribute("src") ?? "", location.href);
  const [options, ...file] = thumbnail.pathname
    .slice("/cdn-cgi/image/".length)
    .split("/");
  const dimensions = new URLSearchParams(options?.replaceAll(",", "&"));
  expect(thumbnail.origin + "/" + file.join("/")).toBe(original.href);
  expect(dimensions.get("width")).toBe(String(width));
  expect(dimensions.get("height")).toBe(String(height));
}

function expectNewTab(link: HTMLElement, url: string) {
  expect(link).toHaveAttribute("href", url);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link.getAttribute("rel")?.split(/\s+/u)).toStrictEqual(
    expect.arrayContaining(["noopener", "noreferrer"]),
  );
}
test("shared-thread-attachments-001 reads an image thumbnail and the accompanying PDF as original-file links", async () => {
  const image = attachment("station.png", "image/png");
  const pdf = attachment("readings.pdf", "application/pdf");
  await readMessage({
    role: "user",
    messageIndex: 0,
    content: "Station readings",
    attachments: [image, pdf],
  });
  const thumbnail = await screen.findByAltText(image.filename);
  const photo = screen.getByLabelText(image.filename, { selector: "a" });
  expect(photo).toContainElement(thumbnail);
  expectThumbnail(thumbnail, image.url, 480, 320);
  expectNewTab(photo, image.url);
  expectNewTab(screen.getByLabelText(pdf.filename, { selector: "a" }), pdf.url);
});
test("shared-thread-attachments-002 shows the loaded inline thumbnail with the full-size image as its destination", async () => {
  const url = media + "/cross-section.png";
  await readMessage({
    role: "assistant",
    messageIndex: 1,
    content: `![Cross section](${url})`,
  });
  const picture = await screen.findByAltText("Cross section");
  expectThumbnail(picture, url, 800, 720);
  fireEvent.load(picture);
  await waitFor(() => {
    return expect(
      screen.queryByTestId("markdown-image-preview-loading"),
    ).not.toBeInTheDocument();
  });
  expect(picture).toBeVisible();
  expect(picture.closest("a")).toHaveAttribute("href", url);
});
test("shared-thread-attachments-004 presents an attachment-only SVG prompt as a file link", async () => {
  const drawing = attachment("profile.svg", "image/svg+xml");
  await readMessage({
    role: "user",
    messageIndex: 0,
    content: "",
    attachments: [drawing],
  });
  const link = await screen.findByLabelText(drawing.filename, {
    selector: "a",
  });
  expect(within(link).getByText(drawing.filename)).toBeInTheDocument();
  expectNewTab(link, drawing.url);
  expect(link.querySelector("img")).toBeNull();
  expect(screen.queryByAltText(drawing.filename)).not.toBeInTheDocument();
});
