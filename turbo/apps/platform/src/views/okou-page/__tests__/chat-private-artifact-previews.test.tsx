import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { test, expect } from "vitest";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  attachment,
  assistantRow,
  userRow,
  fileParts,
  conversation,
  serveUploaded,
} from "./attachment-preview-boundaries.ts";
const context = testContext();
async function imageCard(name: string) {
  const img = (await screen.findByAltText(name)) as HTMLImageElement;
  await waitFor(() => {
    return expect(img.src).toContain("/cdn-cgi/image/");
  });
  fireEvent.load(img);
  return img;
}
async function previewImage(url: string) {
  const panel = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(panel.querySelector("img")).toHaveAttribute("src", url);
  });
  return panel;
}
test("chat-private-artifact-previews-004 reopening an image preserves its original and the loaded thread thumbnail", async () => {
  const file = attachment("summit.png", "image/png");
  serveUploaded(context, [file]);
  await conversation(context, { chatEvents: [userRow(fileParts([file]))] });
  const card = await imageCard(file.filename);
  const thumb = card.src;
  click(card);
  const panel = await previewImage(file.url);
  click(await findAction("button", "Close artifact", panel));
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
  click(card);
  await previewImage(file.url);
  expect(
    within(
      document.querySelector<HTMLElement>('[data-role="user"]')!,
    ).getByAltText(file.filename),
  ).toHaveAttribute("src", thumb);
  expect(screen.queryByTestId("chat-image-preview-loading")).toBeNull();
});
test("chat-private-artifact-previews-006 a private upload keeps its original link separate from its message thumbnail", async () => {
  const file = attachment("private-marker.png", "image/png");
  serveUploaded(context, [file]);
  await conversation(context, { chatEvents: [userRow(fileParts([file]))] });
  const card = await imageCard(file.filename);
  expect(card.closest("a")).toHaveAttribute("href", file.url);
  const thumb = card.src;
  click(card);
  await previewImage(file.url);
  expect(
    within(
      document.querySelector<HTMLElement>('[data-role="user"]')!,
    ).getByAltText(file.filename),
  ).toHaveAttribute("src", thumb);
});
test("chat-private-artifact-previews-009 the assistant's two private pictures keep distinct originals while navigating", async () => {
  const first = attachment("map.png", "image/png"),
    second = attachment("survey.png", "image/png");
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const item = [first, second].find((f) => {
        return f.path === "/artifacts/" + params.reference;
      });
      if (!item) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "No drawing" },
        });
      }
      return respond(200, {
        url: item.url,
        downloadUrl: item.url,
        expiresAt: "2099-01-01T00:00:00.000Z",
        filename: item.filename,
        contentType: item.contentType,
        target: { kind: "file", id: item.id },
      });
    },
  );
  await conversation(context, {
    chatEvents: [
      assistantRow(
        "![West map](" +
          first.path +
          ")\n\n![Site survey](" +
          second.path +
          ")",
      ),
    ],
  });
  const west = await imageCard("West map");
  const east = await imageCard("Site survey");
  const thumbs = [west.src, east.src];
  click(west);
  const dialog = await previewImage(first.url);
  click(await findAction("button", "Next image artifact", dialog));
  await previewImage(second.url);
  click(await findAction("button", "Previous image artifact", dialog));
  await previewImage(first.url);
  expect(screen.getByAltText("West map")).toHaveAttribute("src", thumbs[0]);
  expect(screen.getByAltText("Site survey")).toHaveAttribute("src", thumbs[1]);
});

test("A relative map reference resolves to its signed image and opens the original in the sidebar", async () => {
  const relative = "/artifacts/f000000000004000a000000000000941.png";
  const map = attachment(
    "districts.png",
    "image/png",
    "f0000000-0000-4000-a000-000000000941",
  );
  const reference = context.mocks.deferred<string>();
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      if (!reference.settled()) {
        reference.resolve(params.reference);
      }
      return respond(200, {
        url: map.url,
        downloadUrl: map.url,
        filename: map.filename,
        contentType: map.contentType,
        target: { kind: "file", id: map.id },
        expiresAt: "2099-02-02T00:00:00.000Z",
      });
    },
  );
  await conversation(context, {
    chatEvents: [assistantRow("![District boundary](" + relative + ")")],
  });
  expect("/artifacts/" + (await reference.promise)).toBe(relative);
  const image = await imageCard("District boundary");
  expect(decodeURIComponent(image.src)).toContain("districts.png");
  click(image);
  await previewImage(map.url);
});
