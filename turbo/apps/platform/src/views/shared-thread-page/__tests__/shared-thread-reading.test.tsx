import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { sharedThreadVisibilityContract } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import {
  sharedThread,
  SHARED_THREAD_ID,
} from "./shared-thread-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
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

const path = "/share/threads/" + SHARED_THREAD_ID;
const url = "https://app.okou.ai" + path;
const question = "Which receipts are still outstanding?";
const responses = [
  "November statement",
  "**December:** documents received",
  "Keep the signed copy.",
] as const;
async function visit(signedIn = false, missing = false) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return missing
      ? respond(404, {
          error: { code: "NOT_FOUND", message: "Missing shared conversation" },
        })
      : respond(
          200,
          sharedThread({
            title: "Receipts review",
            messages: [
              { role: "user", messageIndex: 0, content: question },
              ...responses.map((content, i) => {
                return {
                  role: "assistant" as const,
                  messageIndex: i + 1,
                  content,
                  runIndex: 1,
                };
              }),
            ],
          }),
        );
  });
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    auth: signedIn ? undefined : null,
  });
}
async function share() {
  click(await findFastControl("button", "Share"));
  return screen.findByRole("dialog");
}
test("shared-thread-actions-002 An unavailable conversation explains access and offers the visitor sign-in", async () => {
  await visit(false, true);
  await screen.findByText("You can’t view this chat");
  expect(
    screen.getByText(/private or no longer available/i),
  ).toBeInTheDocument();
  await expect(findFastControl("link", "Sign in")).resolves.toHaveAttribute(
    "href",
    expect.stringContaining("/sign-in"),
  );
});
test("shared-thread-actions-005 A visitor copies the question and the entire formatted answer in order", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  await visit();
  const user = await screen.findByText(question);
  click(
    await findFastControl(
      "button",
      "Copy message",
      user.closest('[data-role="user"]')!,
    ),
  );
  await waitFor(() => {
    return expect(clip.writes.at(-1)).toBe(question);
  });
  await screen.findByText("Copied!");
  const answer = await screen.findByText(responses[2]!);
  click(
    await findFastControl(
      "button",
      "Copy message",
      answer.closest('[data-role="assistant"]')!,
    ),
  );
  await waitFor(() => {
    return expect(clip.writes).toStrictEqual([
      question,
      responses.join("\n\n"),
    ]);
  });
});
test("shared-thread-actions-006 The public share dialog confirms copying the current conversation URL", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  await visit();
  const dialog = await share();
  click(await findFastControl("button", "Copy link", dialog));
  await findFastControl("button", "Copied", dialog);
  expect(clip.writes.at(-1)).toBe(url);
});
test("shared-thread-actions-009 A signed-in recipient can copy the share link without owner controls", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  context.mocks.api(sharedThreadVisibilityContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Recipient has no owner settings" },
    });
  });
  await visit(true);
  const dialog = await share();
  click(await findFastControl("button", "Copy link", dialog));
  await findFastControl("button", "Copied", dialog);
  expect(clip.writes.at(-1)).toBe(url);
  expect(within(dialog).queryByRole("radiogroup")).toBeNull();
});
test("shared-thread-actions-007 Workspace ownership stays visible while the creator changes access twice", async () => {
  const clip = context.mocks.browser.clipboardWriteText();
  const oldRevision = crypto.randomUUID(),
    org = { id: "org_123", name: "Receipts team" };
  let current = {
    id: SHARED_THREAD_ID,
    audience: "organization" as "organization" | "private" | "public",
    revision: oldRevision,
    organization: org,
  };
  const writing = context.mocks.deferred<void>(),
    save = context.mocks.deferred<void>(),
    reading = context.mocks.deferred<void>(),
    refresh = context.mocks.deferred<void>();
  context.mocks.api(sharedThreadVisibilityContract.get, async ({ respond }) => {
    if (current.audience === "private") {
      reading.resolve();
      await refresh.promise;
    }
    return respond(200, current);
  });
  context.mocks.api(
    sharedThreadVisibilityContract.update,
    async ({ body, respond }) => {
      if (body.audience === "private") {
        writing.resolve();
        await save.promise;
      }
      current = {
        ...current,
        audience: body.audience,
        revision: crypto.randomUUID(),
      };
      return respond(200, current);
    },
  );
  await visit(true);
  const dialog = await share();
  const w = within(dialog);
  const orgOption = await findFastControl("radio", /Receipts team/, dialog);
  expect(orgOption).toHaveAttribute("aria-checked", "true");
  click(await findFastControl("button", "Copy link", dialog));
  await waitFor(() => {
    return expect(clip.writes.at(-1)).toBe(url);
  });
  const priv = await findFastControl("radio", /Only me/, dialog),
    pub = await findFastControl("radio", /Anyone with the link/, dialog);
  click(priv);
  await writing.promise;
  const group = w.getByRole("radiogroup");
  expect(group).toHaveAttribute("aria-busy", "true");
  for (const option of [priv, pub, orgOption]) {
    expect(option).toBeEnabled();
    expect(option).toHaveAttribute("aria-checked", "false");
  }
  click(pub);
  save.resolve();
  await reading.promise;
  expect(orgOption).toBeInTheDocument();
  expect(group).toHaveAttribute("aria-busy", "true");
  expect(w.queryByText(/loading permissions/i)).toBeNull();
  refresh.resolve();
  await waitFor(() => {
    return expect(pub).toHaveAttribute("aria-checked", "true");
  });
  expect(group).not.toHaveAttribute("aria-busy", "true");
});

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
