import { test, expect } from "vitest";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  publicConversation,
  promptFiles,
  sharedBody,
  sharedFile,
} from "./shared-preview-boundaries.ts";
import {
  findAction,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";

const context = testContext();
const site = sharedFile("lightsite1.html", "text/html", "#slide-4");
const movie = sharedFile("lightvid01.mp4", "video/mp4", "#t=34");
function viewer() {
  return screen.findByTestId("public-artifact-lightbox");
}
async function display(panel: HTMLElement, tag: string, url: string) {
  await waitFor(() => {
    return expect(panel.querySelector(tag)).toHaveAttribute("src", url);
  });
}
async function press(panel: HTMLElement, name: string) {
  click(await findAction("button", name, panel));
}
async function cover(card: HTMLElement, url: string) {
  const image = await waitFor(() => {
    const img = card.querySelector("img");
    expect(img?.src).toContain(url);
    return img!;
  });
  fireEvent.load(image);
}
test("shared-thread-artifact-lightbox-001 a signed-out reader keeps the slide and copies the stable site link", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText(),
    browser = context.mocks.browser.blobDownload();
  const { unauthenticated } = await publicConversation(
    context,
    [site],
    [sharedBody("![Board report](" + site.original + ")")],
  );
  const card = await screen.findByTestId("markdown-artifact-preview-html");
  await cover(card, site.cover);
  expect(card).toHaveAttribute("href", site.original);
  expect(card.querySelector("iframe")).toBeNull();
  click(card);
  const panel = await viewer();
  await display(panel, "iframe", site.url + site.fragment);
  const frame = panel.querySelector("iframe")!;
  expect(frame.sandbox.contains("allow-scripts")).toBeTruthy();
  expect(frame.sandbox.contains("allow-top-navigation")).toBeFalsy();
  expect(within(panel).queryByRole("radiogroup")).toBeNull();
  expect(queryAction("button", "More artifact actions", panel)).toBeNull();
  expect(queryAction("button", "Share", panel)).toBeNull();
  await press(panel, "Copy link");
  await waitFor(() => {
    return expect(clipboard.writes).toContain(site.original);
  });
  await press(panel, "Download");
  await waitFor(() => {
    return expect(browser.downloads).toContainEqual({
      filename: site.name,
      url: site.download,
      blob: null,
    });
  });
  await display(panel, "iframe", site.url + site.fragment);
  await press(panel, "Enter fullscreen");
  await press(panel, "Exit fullscreen");
  await press(panel, "Close");
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
  expect(card).toBeVisible();
  expect(unauthenticated).toContain("view:" + site.name);
});
test("shared-thread-artifact-lightbox-003 a member downloads the public movie without losing its time fragment", async () => {
  const browser = context.mocks.browser.blobDownload();
  const { grants } = await publicConversation(
    context,
    [movie],
    [promptFiles([movie])],
    true,
  );
  click(await findAction("button", "Preview " + movie.name));
  const panel = await viewer();
  await display(panel, "video", movie.url + movie.fragment);
  const publicSave = movie.url + "?public-save=member";
  grants.set(movie.name, { ...movie, download: publicSave });
  await press(panel, "Download");
  await waitFor(() => {
    return expect(browser.downloads).toContainEqual({
      filename: movie.name,
      url: publicSave,
      blob: null,
    });
  });
  await display(panel, "video", movie.url + movie.fragment);
});
test("shared-thread-artifact-lightbox-010 separate prompt covers keep both original links through copying", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await publicConversation(
    context,
    [movie, site],
    [promptFiles([movie, site])],
  );
  const video = await findAction("button", "Preview " + movie.name),
    web = await screen.findByTestId("markdown-artifact-preview-html");
  await cover(video, movie.cover);
  await cover(web, site.cover);
  for (const [card, f, tag] of [
    [video, movie, "video"],
    [web, site, "iframe"],
  ] as const) {
    click(card);
    const panel = await viewer();
    await display(panel, tag, f.url + f.fragment);
    await press(panel, "Copy link");
    await waitFor(() => {
      return expect(clipboard.writes).toContain(f.original);
    });
    await press(panel, "Close");
    await waitFor(() => {
      return expect(panel).not.toBeInTheDocument();
    });
  }
  expect(clipboard.writes).toStrictEqual([movie.original, site.original]);
  await cover(video, movie.cover);
  await cover(web, site.cover);
});
test("shared-thread-artifact-lightbox-011 revocation leaves the shared conversation and its site open", async () => {
  const browser = context.mocks.browser.blobDownload();
  const { grants } = await publicConversation(
    context,
    [site],
    [promptFiles([site])],
  );
  const locationBefore = location.href;
  click(await screen.findByTestId("markdown-artifact-preview-html"));
  const panel = await viewer();
  await display(panel, "iframe", site.url + site.fragment);
  grants.delete(site.name);
  await press(panel, "Download");
  await expect(
    within(panel).findByText("Download failed"),
  ).resolves.toBeVisible();
  expect(browser.downloads).toStrictEqual([]);
  expect(location.href).toBe(locationBefore);
  await display(panel, "iframe", site.url + site.fragment);
});
test("shared-thread-artifact-lightbox-012 a captioned image card retains its external destination and previews in the conversation", async () => {
  const image = sharedFile("survey0001.png", "image/png");
  await publicConversation(
    context,
    [image],
    [sharedBody("![Northern ridge](" + image.original + ")")],
  );
  const thumb = await screen.findByAltText("Northern ridge");
  await waitFor(() => {
    return expect(thumb.getAttribute("src")).toContain(
      new URL(image.url).pathname,
    );
  });
  const card = thumb.closest("a")!;
  expect(card).toHaveAttribute("href", image.original);
  expect(card).toHaveAttribute("target", "_blank");
  click(card);
  const panel = await viewer();
  await display(panel, "img", image.url);
  await expect(
    within(panel).findByRole("heading", { name: "Northern ridge" }),
  ).resolves.toBeVisible();
});
test("shared-thread-artifact-lightbox-013 the document card and prose link each supply their own title", async () => {
  const doc = sharedFile("survey0002.pdf", "application/pdf");
  await publicConversation(
    context,
    [doc],
    [
      sharedBody(
        "![Field packet](" +
          doc.original +
          ")\n\n[Read the survey](" +
          doc.original +
          ")",
      ),
    ],
  );
  const card = await screen.findByTestId("markdown-artifact-preview-pdf");
  click(card);
  const panel = await viewer();
  await waitFor(() => {
    return expect(panel.querySelector("iframe")?.src).toContain(doc.url);
  });
  expect(
    within(panel).getByRole("heading", { name: "Field packet" }),
  ).toBeVisible();
  await press(panel, "Close");
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
  click(await findAction("link", "Read the survey"));
  const reopened = await viewer();
  await expect(
    within(reopened).findByRole("heading", { name: "Read the survey" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    return expect(reopened.querySelector("iframe")?.src).toContain(doc.url);
  });
});
test("shared-thread-artifact-lightbox-014 a prompt image opens its named viewer in this conversation", async () => {
  const f = sharedFile("survey0003.png", "image/png");
  await publicConversation(context, [f], [promptFiles([f])]);
  const before = location.href;
  const opened = context.mocks.browser.open();
  const link = await findAction("link", f.name);
  expect(fireEvent.click(link, { button: 0 })).toBeFalsy();
  const panel = await viewer();
  await display(panel, "img", f.url);
  expect(within(panel).getByRole("heading", { name: f.name })).toBeVisible();
  expect(location.href).toBe(before);
  expect(opened.calls).toStrictEqual([]);
});
test("shared-thread-artifact-lightbox-015 Escape unwinds the diagram then fullscreen then the note", async () => {
  const f = sharedFile("survey0004.md", "text/markdown");
  context.mocks.http.get(f.url, () => {
    return HttpResponse.text(
      "# Field procedure\n\nTake a reading.\n\n```mermaid\nflowchart LR\nA-->B\n```",
    );
  });
  await publicConversation(
    context,
    [f],
    [sharedBody("[Survey notes](" + f.original + ")")],
  );
  click(await findAction("link", "Survey notes"));
  const panel = await viewer();
  expect(
    within(panel).getByRole("heading", { name: "Survey notes" }),
  ).toBeVisible();
  await expect(
    within(panel).findByText("Take a reading."),
  ).resolves.toBeVisible();
  await press(panel, "Enter fullscreen");
  const expand = await findAction("button", "Expand diagram", panel);
  click(expand);
  const layer = await screen.findByTestId("artifact-diagram-lightbox");
  await expect(within(layer).findByRole("img")).resolves.toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(layer).not.toBeInTheDocument();
  });
  await waitFor(() => {
    return expect(expand).toHaveFocus();
  });
  await expect(
    findAction("button", "Exit fullscreen", panel),
  ).resolves.toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect(
    findAction("button", "Enter fullscreen", panel),
  ).resolves.toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
});
