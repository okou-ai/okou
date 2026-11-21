import { findNamedMenuItem } from "./chat-attachment-test-helpers.ts";
import { test, expect } from "vitest";
import { HttpResponse } from "msw";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  attachment,
  assistantRow,
  userRow,
  fileParts,
  conversation,
  serveUploaded,
} from "./attachment-preview-boundaries.ts";
const context = testContext();
test("chat-attachment-message-previews-001 only the complete public video address opens a rich preview", async () => {
  const short = "cdn.okou.io/artifacts/expedition/run/partial.mp4",
    relative = "/artifacts/expedition/run/relative.mp4",
    url = "https://cdn.okou.io/artifacts/expedition/run/route.mp4";
  await conversation(context, {
    chatEvents: [
      assistantRow([short, relative, "![route.mp4](" + url + ")"].join("\n\n")),
    ],
  });
  const open = await findAction("button", "Preview route.mp4");
  await waitFor(() => {
    return expect(open).toBeVisible();
  });
  const message = open.closest('[data-role="assistant"]')!;
  expect(message).toHaveTextContent(short);
  expect(message).toHaveTextContent(relative);
  expect(
    Array.from(
      message.querySelectorAll('button[aria-label^="Preview "]'),
      (b) => {
        return b.getAttribute("aria-label");
      },
    ),
  ).toStrictEqual(["Preview route.mp4"]);
  expect(queryAction("button", "Preview relative.mp4", message)).toBeNull();
  expect(queryAction("button", "Preview partial.mp4", message)).toBeNull();
});
test.each([
  [
    "chat-attachment-message-previews-007",
    "demo.mp4",
    "video/mp4",
    "Preview demo.mp4",
    "video",
  ],
  [
    "chat-attachment-message-previews-008",
    "brief.pdf",
    "application/pdf",
    "Open pdf preview for brief.pdf",
    "iframe",
  ],
] as const)(
  "%s closes a persisted file after opening its split preview",
  async (_id, name, mime, action, tag) => {
    const file = attachment(name, mime);
    serveUploaded(context, [file]);
    await conversation(context, { chatEvents: [userRow(fileParts([file]))] });
    click(await findAction("button", action));
    const lightbox = await screen.findByTestId("attachment-lightbox");
    click(await findAction("button", "Open in split view", lightbox));
    const side = await screen.findByTestId("artifact-sidebar");
    await waitFor(() => {
      return expect(side.querySelector(tag)?.getAttribute("src")).toContain(
        file.url,
      );
    });
    click(await findAction("button", "Close artifact", side));
    await waitFor(() => {
      return expect(side).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("artifact-sidebar")).toBeNull();
  },
);
test("chat-attachment-message-previews-010 fullscreen keeps the quarterly deck and downloads its HTML", async () => {
  const file = attachment("quarterly-deck.html", "text/html");
  serveUploaded(context, [file]);
  const browser = context.mocks.browser.blobDownload();
  context.mocks.http.get(file.url.split("?")[0], () => {
    return HttpResponse.html("<h1>Quarterly plan</h1>");
  });
  await conversation(context, { chatEvents: [userRow(fileParts([file]))] });
  click(
    await findAction("button", "Open html preview for quarterly-deck.html"),
  );
  const dialog = await screen.findByTestId("attachment-lightbox");
  for (const control of ["Enter fullscreen", "Exit fullscreen"]) {
    click(await findAction("button", control, dialog));
    await waitFor(() => {
      return expect(dialog.querySelector("iframe")?.src).toContain(file.url);
    });
  }
  await expect(
    findAction("button", "Enter fullscreen", dialog),
  ).resolves.toBeEnabled();
  click(await findAction("button", "Download options", dialog));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    return expect(
      browser.downloads.map((d) => {
        return d.filename;
      }),
    ).toStrictEqual([file.filename]);
  });
});
test("chat-attachment-message-previews-012 a Slack message keeps its permalink while opening the Markdown attachment", async () => {
  const doc = attachment("handoff.md", "text/markdown");
  const href = "https://work.slack.com/archives/C043/p1720000011111111";
  serveUploaded(context, [doc]);
  context.mocks.http.get(doc.url.split("?")[0], () => {
    return HttpResponse.text("# North ridge checklist");
  });
  await conversation(context, {
    chatEvents: [
      userRow([
        { type: "source", kind: "slack", href },
        ...fileParts([doc]),
        { type: "text", text: "Review the trail notes." },
      ]),
    ],
  });
  const row = (await screen.findByText("Review the trail notes.")).closest(
    '[data-role="user"]',
  )!;
  const link = row.querySelector('a[href="' + href + '"]');
  expect(link).toBeVisible();
  click(
    await findAction("button", "Open markdown preview for handoff.md", row),
  );
  const dialog = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(dialog).findByRole("heading", {
      name: "North ridge checklist",
    }),
  ).resolves.toBeVisible();
  expect(link).toHaveAttribute("href", href);
  expect(row).toHaveTextContent("Review the trail notes.");
});
test("chat-attachment-message-previews-013 a Lark binary JPEG opens its signed original from a thumbnail", async () => {
  const file = attachment("field-photo", "image/jpeg");
  file.url =
    "https://media.r2.cloudflarestorage.com/bucket/asset?X-Amz-Signature=sample";
  serveUploaded(context, [file]);
  await conversation(context, {
    chatEvents: [
      userRow([
        {
          type: "source",
          kind: "lark",
          href: "https://applink.larksuite.com/client/chat/open?openId=sample",
        },
        ...fileParts([file]),
      ]),
    ],
  });
  const img = (await screen.findByAltText(file.filename)) as HTMLImageElement;
  await waitFor(() => {
    return expect(img.src).toContain("/cdn-cgi/image/");
  });
  expect(img.src).toContain(file.url);
  fireEvent.load(img);
  click(img);
  const dialog = await screen.findByTestId("attachment-lightbox");
  await waitFor(() => {
    return expect(dialog.querySelector("img")).toHaveAttribute("src", file.url);
  });
});
test("chat-attachment-message-previews-014 media precedes file chips and the message text", async () => {
  const files = [
    attachment("scene.png", "image/png"),
    attachment("tour.mp4", "video/mp4"),
    attachment("plan.pdf", "application/pdf"),
    attachment("log.txt", "text/plain"),
  ];
  serveUploaded(context, files);
  await conversation(context, {
    chatEvents: [
      userRow([
        ...fileParts([files[2], files[0], files[3], files[1]]),
        { type: "text", text: "Read after the attachments." },
      ]),
    ],
  });
  const ordered = [
    await findAction("link", "Preview scene.png"),
    await findAction("button", "Preview tour.mp4"),
    await findAction("button", "Open pdf preview for plan.pdf"),
    await findAction("button", "Open text preview for log.txt"),
    await screen.findByText("Read after the attachments."),
  ];
  for (const [index, node] of ordered.slice(1).entries()) {
    expect(
      ordered[index].compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
});
test("chat-attachment-message-previews-015 typed image syntax remains an ordered text link", async () => {
  const url = "https://cdn.okou.io/artifacts/field/run/slope.png";
  const text = "Before ![Slope](" + url + ") after";
  await conversation(context, {
    chatEvents: [userRow([{ type: "text", text }])],
  });
  const link = await findAction("link", url);
  const row = link.closest('[data-role="user"]');
  expect(row).toHaveTextContent(text);
  expect(link).toHaveAttribute("href", url);
  expect(
    row?.querySelector("img,video,[data-testid=attachment-preview-file]"),
  ).toBeNull();
  expect(queryAction("link", "Preview slope.png", row!)).toBeNull();
});
