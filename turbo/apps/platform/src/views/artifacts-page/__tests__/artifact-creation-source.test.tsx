import {
  artifactCatalogContract,
  type ArtifactDetail,
  type ArtifactCatalogKind,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { createChatLifecycleHelpers } from "../../okou-page/__tests__/chat-lifecycle-test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  getCatalogViewport,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const FIRST = "a0000000-0000-4000-a000-000000000001";
const SECOND = "a0000000-0000-4000-a000-000000000002";
const CHAT = "b0000000-0000-4000-a000-000000000001";
const OTHER_CHAT = "b0000000-0000-4000-a000-000000000002";
const RUN = "c0000000-0000-4000-a000-000000000001";
const SOURCE_LABEL = "View creation source";

function file(id: string, title: string): ArtifactDetail {
  return {
    ...artifact({ id, title }),
    kind: "file",
    file: {
      id,
      filename: title,
      contentType: "text/plain",
      size: 128,
      url: `https://artifacts.example.com/${title}`,
      previewImageUrl: null,
    },
  };
}

function mockFiles() {
  const first = file(FIRST, "first.txt");
  const second = file(SECOND, "second.txt");
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [first, second], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    return respond(200, params.artifactId === FIRST ? first : second);
  });
  context.mocks.http.get("https://artifacts.example.com/first.txt", () => {
    return HttpResponse.text("First preview contents");
  });
  context.mocks.http.get("https://artifacts.example.com/second.txt", () => {
    return HttpResponse.text("Second preview contents");
  });
}

function mockHostedSite() {
  const detail: ArtifactDetail = {
    ...artifact({ id: FIRST, kind: "hosted-site", title: "Launch website" }),
    kind: "hosted-site",
    site: {
      id: "d0000000-0000-4000-a000-000000000001",
      slug: "launch-website",
      publicSlug: "launch-website",
      url: "https://launch.example.com/",
      deploymentVersion: 7,
      entrypoint: "index.html",
      spaFallback: false,
    },
  };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, detail);
  });
}

function setupLibrary() {
  return setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.ArtifactLibrary]: true },
  });
}

function menuItem(menu: HTMLElement, name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected menu item ${name}`);
  }
  return item;
}

function rowMore(title: string): HTMLElement {
  const viewport = getCatalogViewport();
  const preview = [
    ...queryAllByRoleFast("button", viewport),
    ...queryAllByRoleFast("link", viewport),
  ].find((candidate) => {
    return candidate.getAttribute("aria-label") === `Preview ${title}`;
  });
  const row = preview?.closest("tr");
  if (!row) {
    throw new Error(`Expected row ${title}`);
  }
  return getButtonByName("More artifact actions", row);
}

async function sourceLink(menu: HTMLElement, href: string) {
  return await waitFor(() => {
    const item = menuItem(menu, SOURCE_LABEL);
    expect(item.tagName).toBe("A");
    expect(item).toHaveAttribute("href", href);
    return item;
  });
}

const kinds: readonly ArtifactCatalogKind[] = Object.freeze([
  "file",
  "image",
  "video",
  "avatar",
  "hosted-site",
  "presentation",
  "shared-thread",
]);

test("All seven Library kinds expose one verified source link independently of Delete authority", async () => {
  const items = kinds.map((kind, index) => {
    return artifact({
      id: `a0000000-0000-4000-a000-${(index + 1).toString().padStart(12, "0")}`,
      kind,
      title: `${kind} product`,
      ...(kind === "shared-thread" ? { sharedThreadId: OTHER_CHAT } : {}),
    });
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: items, nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "No deletion authority" },
    });
  });
  context.mocks.api(
    artifactCatalogContract.creationSource,
    ({ params, request, respond }) => {
      const item = items.find((candidate) => {
        return candidate.id === params.artifactId;
      });
      expect(item).toBeDefined();
      expect(new URL(request.url).search).toBe("");
      return respond(200, {
        source: {
          chatThreadId: CHAT,
          runId:
            item?.kind === "hosted-site" || item?.kind === "presentation"
              ? RUN
              : null,
        },
      });
    },
  );
  await setupLibrary();
  await expect(findArtifactAction("file product")).resolves.toBeInTheDocument();
  const user = userEvent.setup();
  for (const item of items) {
    click(rowMore(item.title));
    const menu = await screen.findByRole("menu");
    await sourceLink(
      menu,
      `/chats/${CHAT}${item.kind === "hosted-site" || item.kind === "presentation" ? `#run-${RUN}` : ""}`,
    );
    expect(
      queryAllByRoleFast("menuitem", menu).filter((candidate) => {
        return candidate.textContent?.trim() === SOURCE_LABEL;
      }),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(menuItem(menu, "Delete")).toHaveAttribute("aria-disabled", "true");
      expect(menuItem(menu, "Delete")).toHaveAttribute("aria-busy", "false");
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      return expect(menu).not.toBeInTheDocument();
    });
  }
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("A row source targets the clicked file, preserves modifiers, and leaves Delete as the second independent action", async () => {
  mockFiles();
  // Native modified-anchor navigation is outside Happy DOM's browsing model.
  context.mocks.browser.open();
  context.mocks.api(
    artifactCatalogContract.creationSource,
    ({ params, respond }) => {
      return respond(200, {
        source: {
          chatThreadId: params.artifactId === FIRST ? OTHER_CHAT : CHAT,
          runId: null,
        },
      });
    },
  );
  await setupLibrary();
  click(await findArtifactAction("first.txt"));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("First preview contents"),
  ).resolves.toBeInTheDocument();
  const trigger = rowMore("second.txt");
  click(trigger);
  const menu = await screen.findByRole("menu");
  const source = await sourceLink(menu, `/chats/${CHAT}`);
  const modifiers: boolean[] = [];
  source.addEventListener("click", (event) => {
    modifiers.push(event.ctrlKey);
  });
  const user = userEvent.setup();
  await user.keyboard("{Control>}");
  await user.click(source);
  await user.keyboard("{/Control}");
  expect(modifiers).toStrictEqual([true]);
  await waitFor(() => {
    return expect(menu).not.toBeInTheDocument();
  });
  expect(pathname()).toBe("/artifacts");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  click(trigger);
  const reopened = await screen.findByRole("menu");
  await sourceLink(reopened, `/chats/${CHAT}`);
  await waitFor(() => {
    return expect(menuItem(reopened, "Delete")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(queryAllByRoleFast("menuitem", reopened)[1]).toHaveTextContent(
    "Delete",
  );
  click(menuItem(reopened, "Delete"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete second.txt?",
  });
  click(getButtonByName("Cancel", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  click(trigger);
  const escaped = await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(escaped).not.toBeInTheDocument();
  });
  click(rowMore("first.txt"));
  await sourceLink(await screen.findByRole("menu"), `/chats/${OTHER_CHAT}`);
});

test.each([null, RUN])(
  "The catalog sidebar uses its canonical ID and verified Run (%s)",
  async (runId) => {
    if (runId) {
      mockHostedSite();
    } else {
      mockFiles();
    }
    context.mocks.api(
      artifactCatalogContract.creationSource,
      ({ params, respond }) => {
        expect(params.artifactId).toBe(FIRST);
        return respond(200, { source: { chatThreadId: CHAT, runId } });
      },
    );
    await setupLibrary();
    click(await findArtifactAction(runId ? "Launch website" : "first.txt"));
    const sidebar = await screen.findByTestId("artifact-sidebar");
    const preview = runId
      ? within(sidebar).findByTitle("Launch website preview")
      : within(sidebar).findByText("First preview contents");
    await expect(preview).resolves.toBeInTheDocument();
    click(getButtonByName("More artifact actions", sidebar));
    await sourceLink(
      await screen.findByRole("menu"),
      `/chats/${CHAT}${runId ? `#run-${runId}` : ""}`,
    );
  },
);

test.each(["row", "sidebar"])(
  "Closing a pending %s lookup and switching artifacts cannot install its late href",
  async (surface) => {
    mockFiles();
    const started = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      artifactCatalogContract.creationSource,
      async ({ params, respond }) => {
        if (params.artifactId === FIRST) {
          started.resolve();
          await release.promise;
          return respond(200, {
            source: { chatThreadId: OTHER_CHAT, runId: null },
          });
        }
        return respond(200, { source: { chatThreadId: CHAT, runId: null } });
      },
    );
    await setupLibrary();
    await expect(findArtifactAction("first.txt")).resolves.toBeInTheDocument();
    if (surface === "sidebar") {
      click(getButtonByName("Preview first.txt", getCatalogViewport()));
      const sidebar = await screen.findByTestId("artifact-sidebar");
      await within(sidebar).findByText("First preview contents");
      click(getButtonByName("More artifact actions", sidebar));
    } else {
      click(rowMore("first.txt"));
    }
    const pending = await screen.findByRole("menu");
    await started.promise;
    expect(menuItem(pending, SOURCE_LABEL)).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(menuItem(pending, SOURCE_LABEL)).not.toHaveAttribute("href");
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      return expect(pending).not.toBeInTheDocument();
    });
    release.resolve();
    if (surface === "sidebar") {
      click(getButtonByName("Preview second.txt", getCatalogViewport()));
      const sidebar = await screen.findByTestId("artifact-sidebar");
      await within(sidebar).findByText("Second preview contents");
      click(getButtonByName("More artifact actions", sidebar));
    } else {
      click(rowMore("second.txt"));
    }
    await sourceLink(await screen.findByRole("menu"), `/chats/${CHAT}`);
  },
);

test("A publication refresh cancels a pending source lookup when the sidebar menu unmounts", async () => {
  mockFiles();
  const sourceStarted = context.mocks.deferred<Request>();
  const sourceRelease = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.creationSource,
    async ({ request, respond }) => {
      sourceStarted.resolve(request);
      await sourceRelease.promise;
      return respond(200, { source: { chatThreadId: CHAT, runId: null } });
    },
  );
  await setupLibrary();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
  });
  click(await findArtifactAction("first.txt"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByText("First preview contents"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("More artifact actions", sidebar));
  const menu = await screen.findByRole("menu");
  const sourceRequest = await sourceStarted.promise;
  expect(menuItem(menu, SOURCE_LABEL)).toHaveAttribute("aria-busy", "true");

  const detailStarted = context.mocks.deferred<void>();
  const detailRelease = context.mocks.deferred<void>();
  context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
    detailStarted.resolve();
    await detailRelease.promise;
    return respond(200, file(FIRST, "first.txt"));
  });
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", { artifactId: FIRST });
  });
  await detailStarted.promise;
  await waitFor(() => {
    expect(menu).not.toBeInTheDocument();
    expect(sourceRequest.signal.aborted).toBeTruthy();
  });
  sourceRelease.resolve();
  detailRelease.resolve();
  await expect(
    screen.findByText("First preview contents"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test.each([200, 403] as const)(
  "An unavailable or denied source (%s) is a neutral disabled item",
  async (status) => {
    mockFiles();
    context.mocks.api(artifactCatalogContract.creationSource, ({ respond }) => {
      return status === 200
        ? respond(200, { source: null })
        : respond(403, {
            error: { code: "FORBIDDEN", message: "Source denied" },
          });
    });
    await setupLibrary();
    await expect(findArtifactAction("first.txt")).resolves.toBeInTheDocument();
    click(rowMore("first.txt"));
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      return expect(menuItem(menu, SOURCE_LABEL)).toHaveAttribute(
        "aria-busy",
        "false",
      );
    });
    expect(menuItem(menu, SOURCE_LABEL)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(menuItem(menu, SOURCE_LABEL)).not.toHaveAttribute("href");
    expect(menuItem(menu, SOURCE_LABEL)).toHaveAttribute(
      "title",
      "Creation source unavailable",
    );
  },
);

test("A genuine API failure stays retryable in the open menu", async () => {
  mockFiles();
  let fail = true;
  context.mocks.api(artifactCatalogContract.creationSource, ({ respond }) => {
    if (fail) {
      fail = false;
      return respond(503, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Creation lookup failed",
        },
      });
    }
    return respond(200, { source: { chatThreadId: CHAT, runId: null } });
  });
  await setupLibrary();
  await expect(findArtifactAction("first.txt")).resolves.toBeInTheDocument();
  click(rowMore("first.txt"));
  const menu = await screen.findByRole("menu");
  await expect(
    screen.findByText("Creation lookup failed"),
  ).resolves.toBeInTheDocument();
  const retry = await waitFor(() => {
    return menuItem(menu, `${SOURCE_LABEL} — Retry`);
  });
  click(retry);
  await sourceLink(menu, `/chats/${CHAT}`);
});

test("Flag-off catalog previews retain the original Delete menu without a creation lookup", async () => {
  mockFiles();
  let sourceRequested = false;
  context.mocks.api(artifactCatalogContract.creationSource, ({ respond }) => {
    sourceRequested = true;
    return respond(200, { source: null });
  });
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ArtifactLibrary]: false },
  });
  click(await findArtifactAction("first.txt"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByText("First preview contents"),
  ).resolves.toBeInTheDocument();
  const trigger = await waitFor(() => {
    return getButtonByName("More artifact actions", sidebar);
  });
  click(trigger);
  const menu = await screen.findByRole("menu");
  expect(queryAllByRoleFast("menuitem", menu)).toHaveLength(1);
  expect(menuItem(menu, "Delete")).toBeInTheDocument();
  expect(sourceRequested).toBeFalsy();
});

test("A pending source cannot reveal the previous actor's href after an organization switch", async () => {
  mockFiles();
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const answered = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.creationSource,
    async ({ respond }) => {
      started.resolve();
      await release.promise;
      answered.resolve();
      return respond(200, { source: { chatThreadId: CHAT, runId: null } });
    },
  );
  await setupLibrary();
  await expect(findArtifactAction("first.txt")).resolves.toBeInTheDocument();
  click(rowMore("first.txt"));
  const menu = await screen.findByRole("menu");
  await started.promise;
  await act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "org_second", name: "Second organization" },
      memberships: [{ id: "org_second" }],
    });
    context.mocks.clerk().stateChanged();
  });
  release.resolve();
  await answered.promise;
  await waitFor(() => {
    const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
      return candidate.textContent?.trim() === SOURCE_LABEL;
    });
    expect(item?.getAttribute("href") ?? null).toBeNull();
  });
});

test("Activating a source link reaches the existing Chat route and original Run anchor", async () => {
  const { mockChatLifecycleWithoutBrowserSession } =
    createChatLifecycleHelpers(context);
  mockChatLifecycleWithoutBrowserSession({
    threadId: CHAT,
    threadTitle: "Original creation conversation",
    chatEvents: [
      {
        id: RUN,
        role: "user",
        content: "The original creation request",
        runId: RUN,
        seqId: 1,
        createdAt: "2026-07-01T10:00:00Z",
      },
    ],
  });
  mockHostedSite();
  context.mocks.api(artifactCatalogContract.creationSource, ({ respond }) => {
    return respond(200, { source: { chatThreadId: CHAT, runId: RUN } });
  });
  await setupLibrary();
  await expect(
    findArtifactAction("Launch website"),
  ).resolves.toBeInTheDocument();
  click(rowMore("Launch website"));
  const link = await sourceLink(
    await screen.findByRole("menu"),
    `/chats/${CHAT}#run-${RUN}`,
  );
  click(link);
  await expect(
    screen.findByText("The original creation request"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe(`/chats/${CHAT}`);
  expect(window.location.hash).toBe(`#run-${RUN}`);
});
