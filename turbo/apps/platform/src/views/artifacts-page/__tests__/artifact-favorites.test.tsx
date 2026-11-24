import {
  artifactCatalogContract,
  type ArtifactCatalogListQuery,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, onTestFinished, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  getCatalogViewport,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const firstPage = createTestRuntime(context);
const refreshedPage = createTestRuntime(context);
const FIRST_ID = "a0000000-0000-4000-a000-000000000001";
const SECOND_ID = "a0000000-0000-4000-a000-000000000002";
const THIRD_ID = "a0000000-0000-4000-a000-000000000003";

function setupLibraryPage(path = "/artifacts", page: TestContext = context) {
  return setupPage({
    context: page,
    path,
    featureSwitches: { [FeatureSwitchKey.ArtifactLibrary]: true },
  });
}

function rowFor(title: string): HTMLElement {
  const row = getButtonByName(`Preview ${title}`, getCatalogViewport()).closest(
    "tr",
  );
  if (!row) {
    throw new Error(`Expected an artifact row for "${title}"`);
  }
  return row;
}

function getRowFave(name: "Star" | "Unstar", title: string): HTMLElement {
  return getButtonByName(name, rowFor(title));
}

function menuItem(name: string, menu: HTMLElement): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected menu item "${name}"`);
  }
  return item;
}

function sortHeading(name: string): HTMLElement {
  const head = getCatalogViewport().querySelector("thead");
  if (!head) {
    throw new Error("Expected Library headings");
  }
  return getButtonByName(name, head);
}

function queryParams() {
  return new URLSearchParams(window.location.search);
}

function previewNames(): string[] {
  return queryAllByRoleFast("button", getCatalogViewport()).flatMap(
    (button) => {
      const label = button.getAttribute("aria-label");
      return label?.startsWith("Preview ") ? [label.slice(8)] : [];
    },
  );
}

function textDetail(id: string, title: string): ArtifactDetail {
  return {
    ...artifact({ id, title }),
    kind: "file",
    file: {
      id,
      filename: title,
      contentType: "text/plain",
      size: 1024,
      url: `https://artifacts.example.com/${title}`,
      previewImageUrl: null,
    },
  };
}

function mockPreview(detail: ArtifactDetail, content: string) {
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(detail.id);
    return respond(200, detail);
  });
  if (detail.kind !== "file") {
    throw new Error("Expected a file preview fixture");
  }
  context.mocks.http.get(detail.file.url, () => {
    return HttpResponse.text(content);
  });
}

// Provider state exists only behind the production HTTP boundary. Re-entering
// the page reads it again; no application store or favorite command is seeded.
function mockFavorites(
  initialIds: readonly string[] = [],
  beforeWrite?: (id: string, starred: boolean) => Promise<string | void>,
) {
  const ids = new Set(initialIds);
  context.mocks.api(artifactCatalogContract.listFavorites, ({ respond }) => {
    return respond(200, { artifactIds: [...ids] });
  });
  context.mocks.api(
    artifactCatalogContract.setFavorite,
    async ({ params, body, respond }) => {
      const error = await beforeWrite?.(params.artifactId, body.starred);
      if (error) {
        return respond(503, {
          error: { code: "INTERNAL_SERVER_ERROR", message: error },
        });
      }
      if (body.starred) {
        ids.add(params.artifactId);
      } else {
        ids.delete(params.artifactId);
      }
      return respond(200, {
        artifactId: params.artifactId,
        starred: body.starred,
      });
    },
  );
  return (): readonly string[] => {
    return [...ids];
  };
}

async function readyFavorite(name: "Star" | "Unstar", title: string) {
  return await waitFor(() => {
    const button = getRowFave(name, title);
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-pressed", String(name === "Unstar"));
    return button;
  });
}

async function repeatPendingActivation(button: HTMLElement, starred: boolean) {
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveAttribute("aria-pressed", String(starred));
  const user = userEvent.setup();
  await user.click(button);
  button.focus();
  await user.keyboard("{Enter} ");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toHaveAttribute("aria-pressed", String(starred));
}

async function selectType(name: string) {
  click(screen.getByRole("combobox", { name: "Type" }));
  click(await screen.findByRole("option", { name }));
}

test("All keeps favorite status unknown while its read loads or fails, then retries the authoritative IDs", async () => {
  const reading = context.mocks.deferred<void>();
  const releaseRead = context.mocks.deferred<void>();
  let unavailable = true;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ title: "status-plan.txt" })],
      nextCursor: null,
    });
  });
  context.mocks.api(
    artifactCatalogContract.listFavorites,
    async ({ respond }) => {
      if (unavailable) {
        reading.resolve();
        await releaseRead.promise;
        unavailable = false;
        return respond(503, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Starred status unavailable",
          },
        });
      }
      return respond(200, { artifactIds: [FIRST_ID] });
    },
  );

  await setupLibraryPage();

  await expect(
    findArtifactAction("status-plan.txt"),
  ).resolves.toBeInTheDocument();
  await reading.promise;
  const unknown = getButtonByName(
    "Loading starred status",
    rowFor("status-plan.txt"),
  );
  expect(unknown).toBeDisabled();
  expect(unknown).not.toHaveAttribute("aria-pressed");
  expect(
    getButtonByName("All artifacts", getCatalogViewport()),
  ).toHaveAttribute("aria-pressed", "true");
  releaseRead.resolve();

  await expect(
    screen.findByText("Couldn't load starred status."),
  ).resolves.toBeInTheDocument();
  const retry = getButtonByName(
    "Retry starred status",
    rowFor("status-plan.txt"),
  );
  expect(retry).not.toHaveAttribute("aria-pressed");
  click(retry);

  await readyFavorite("Unstar", "status-plan.txt");
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("Starring is optimistic, disables repeat activation, and survives a fresh Router reading the saved IDs", async () => {
  const writing = context.mocks.deferred<void>();
  const releaseWrite = context.mocks.deferred<void>();
  mockFavorites([], async (id, starred) => {
    expect(id).toBe(FIRST_ID);
    expect(starred).toBeTruthy();
    writing.resolve();
    await releaseWrite.promise;
  });
  context.mocks.api(
    artifactCatalogContract.list,
    ({ query, request, respond }) => {
      expect(query.starred).toBeUndefined();
      expect(new URL(request.url).searchParams.has("starred")).toBeFalsy();
      return respond(200, {
        artifacts: [artifact({ title: "saved-plan.txt" })],
        nextCursor: null,
      });
    },
  );

  await setupLibraryPage(
    "/artifacts?tab=file&sort=title&direction=asc",
    firstPage,
  );

  const star = await readyFavorite("Star", "saved-plan.txt");
  const user = userEvent.setup();
  await user.click(star);
  await writing.promise;
  const pending = getButtonByName("Unstar", rowFor("saved-plan.txt"));
  await repeatPendingActivation(pending, true);
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  releaseWrite.resolve();

  await readyFavorite("Unstar", "saved-plan.txt");
  firstPage.dispose();
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  vi.mocked(window.history.forward).mockRestore();
  await setupLibraryPage(
    "/artifacts?tab=file&sort=title&direction=asc",
    refreshedPage,
  );

  await readyFavorite("Unstar", "saved-plan.txt");
  expect(queryParams().get("sort")).toBe("title");
  expect(queryParams().get("direction")).toBe("asc");
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("Row More, row star and sidebar More share the same known favorite state without opening an extra preview", async () => {
  const detail = textDetail(FIRST_ID, "shared-controls.txt");
  mockFavorites();
  mockPreview(detail, "The retained controls preview");
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });

  await setupLibraryPage();

  await readyFavorite("Star", detail.title);
  click(getButtonByName("More artifact actions", rowFor(detail.title)));
  const rowMenu = await screen.findByRole("menu");
  click(menuItem("Star", rowMenu));

  await readyFavorite("Unstar", detail.title);
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  click(getButtonByName(`Preview ${detail.title}`, getCatalogViewport()));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("The retained controls preview"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getButtonByName("Unstar", preview)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  click(getButtonByName("More artifact actions", preview));
  const sidebarMenu = await screen.findByRole("menu");
  click(menuItem("Unstar", sidebarMenu));

  await expect(
    screen.findByText("Artifact unstarred"),
  ).resolves.toBeInTheDocument();
  await readyFavorite("Star", detail.title);
  expect(getButtonByName("Star", preview)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    within(preview).getByText("The retained controls preview"),
  ).toBeInTheDocument();
  expect(window.location.pathname).toBe("/artifacts");
  expect(queryParams().has("artifact")).toBeFalsy();
});

test("Starred intersects keyword, kind and both server orders, and clearing filters retains Starred", async () => {
  mockFavorites([FIRST_ID]);
  let latestQuery: ArtifactCatalogListQuery | undefined;
  context.mocks.api(
    artifactCatalogContract.list,
    ({ query, request, respond }) => {
      latestQuery = query;
      expect(new URL(request.url).searchParams.get("starred")).toBe(
        query.starred ?? null,
      );
      if (query.kind === "image") {
        return respond(200, { artifacts: [], nextCursor: null });
      }
      const prefix = query.starred === "true" ? "Starred" : "All";
      return respond(200, {
        artifacts: [
          artifact({
            title: `${prefix} ${query.keyword ?? "all"}-${query.sort}-${query.direction}.txt`,
          }),
        ],
        nextCursor: null,
      });
    },
  );

  await setupLibraryPage(
    "/artifacts?tab=file&q=launch&sort=createdAt&direction=desc",
  );

  await expect(
    findArtifactAction("All launch-createdAt-desc.txt"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Starred", getCatalogViewport()));

  await expect(
    findArtifactAction("Starred launch-createdAt-desc.txt"),
  ).resolves.toBeInTheDocument();
  for (const [heading, sort, direction] of [
    ["Name", "title", "asc"],
    ["Name", "title", "desc"],
    ["Created", "createdAt", "desc"],
    ["Created", "createdAt", "asc"],
  ] as const) {
    click(sortHeading(heading));

    await expect(
      findArtifactAction(`Starred launch-${sort}-${direction}.txt`),
    ).resolves.toBeInTheDocument();
    expect(latestQuery).toStrictEqual({
      limit: 60,
      kind: "file",
      keyword: "launch",
      sort,
      direction,
      starred: "true",
    });
    expect(queryParams().get("starred")).toBe("true");
    expect(queryParams().get("q")).toBe("launch");
    expect(queryParams().get("tab")).toBe("file");
    expect(sortHeading(heading).closest("th")).toHaveAttribute(
      "aria-sort",
      direction === "asc" ? "ascending" : "descending",
    );
  }
  await selectType("Image");

  await expect(
    screen.findByRole("heading", { name: "No artifacts found" }),
  ).resolves.toBeInTheDocument();
  expect(latestQuery).toStrictEqual({
    limit: 60,
    kind: "image",
    keyword: "launch",
    sort: "createdAt",
    direction: "asc",
    starred: "true",
  });
  click(getButtonByName("Clear filters", getCatalogViewport()));

  await expect(
    findArtifactAction("Starred all-createdAt-asc.txt"),
  ).resolves.toBeInTheDocument();
  expect(latestQuery).toStrictEqual({
    limit: 60,
    sort: "createdAt",
    direction: "asc",
    starred: "true",
  });
  expect(getButtonByName("Starred", getCatalogViewport())).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
    "All types",
  );
  expect(queryParams().get("starred")).toBe("true");
  expect(queryParams().get("sort")).toBe("createdAt");
  expect(queryParams().get("direction")).toBe("asc");
  expect(queryParams().has("q")).toBeFalsy();
  click(getButtonByName("All artifacts", getCatalogViewport()));

  await expect(
    findArtifactAction("All all-createdAt-asc.txt"),
  ).resolves.toBeInTheDocument();
  expect(latestQuery).toStrictEqual({
    limit: 60,
    sort: "createdAt",
    direction: "asc",
  });
  expect(queryParams().has("starred")).toBeFalsy();
});

test("Unstar in Starred removes only the row, preserves preview, order, focus and scroll, and Undo restores it", async () => {
  const first = textDetail(FIRST_ID, "alpha-plan.txt");
  const second = artifact({ id: SECOND_ID, title: "beta-plan.txt" });
  const writing = context.mocks.deferred<void>();
  const releaseWrite = context.mocks.deferred<void>();
  mockFavorites([FIRST_ID, SECOND_ID], async (id, starred) => {
    expect(id).toBe(FIRST_ID);
    if (!starred) {
      writing.resolve();
      await releaseWrite.promise;
    }
  });
  mockPreview(first, "Preview stays open after unstar");
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({
      limit: 60,
      kind: "file",
      keyword: "plan",
      sort: "title",
      direction: "asc",
      starred: "true",
    });
    return respond(200, { artifacts: [first, second], nextCursor: null });
  });

  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    function (this: HTMLElement) {
      const viewport = this.closest("main");
      if (viewport) {
        viewport.scrollTop = 0;
      }
    },
  );
  await setupLibraryPage(
    `/artifacts?starred=true&tab=file&q=plan&sort=title&direction=asc&artifact=${FIRST_ID}`,
  );

  await readyFavorite("Unstar", first.title);
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("Preview stays open after unstar"),
  ).resolves.toBeInTheDocument();
  getCatalogViewport().scrollTop = 320;
  const originalQuery = window.location.search;
  await waitFor(() => {
    expect(getButtonByName("Unstar", preview)).toBeEnabled();
  });
  const user = userEvent.setup();
  await user.click(getButtonByName("Unstar", preview));
  await writing.promise;

  await waitFor(() => {
    expect(previewNames()).toStrictEqual([second.title]);
  });
  expect(
    within(preview).getByText("Preview stays open after unstar"),
  ).toBeInTheDocument();
  expect(getButtonByName("Star", preview)).toHaveFocus();
  await repeatPendingActivation(getButtonByName("Star", preview), false);
  expect(getCatalogViewport().scrollTop).toBe(320);
  expect(window.location.search).toBe(originalQuery);
  releaseWrite.resolve();

  await expect(
    screen.findByText("Artifact unstarred"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Undo"));

  await readyFavorite("Unstar", first.title);
  expect(previewNames()).toStrictEqual([first.title, second.title]);
  expect(getButtonByName("Unstar", preview)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    within(preview).getByText("Preview stays open after unstar"),
  ).toBeInTheDocument();
  expect(getCatalogViewport().scrollTop).toBe(320);
  expect(window.location.search).toBe(originalQuery);
});

test("Undo survives an unrelated artifact refresh that confirms the unstar and replaces the Starred catalog", async () => {
  const first = textDetail(FIRST_ID, "alpha-plan.txt");
  const second = artifact({ id: SECOND_ID, title: "beta-plan.txt" });
  const getProviderIds = mockFavorites([FIRST_ID, SECOND_ID]);
  let externallyChanged = false;
  mockPreview(first, "Undo preview survives an unrelated refresh");
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({
      limit: 60,
      kind: "file",
      keyword: "plan",
      sort: "title",
      direction: "asc",
      starred: "true",
    });
    const rows = [
      first,
      externallyChanged
        ? { ...second, title: "beta-refreshed-plan.txt" }
        : second,
    ];
    return respond(200, {
      artifacts: rows.filter((row) => {
        return getProviderIds().includes(row.id);
      }),
      nextCursor: null,
    });
  });

  await setupLibraryPage(
    `/artifacts?starred=true&tab=file&q=plan&sort=title&direction=asc&artifact=${FIRST_ID}`,
  );

  await readyFavorite("Unstar", first.title);
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("Undo preview survives an unrelated refresh"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
    expect(getButtonByName("Unstar", preview)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  const originalQuery = window.location.search;
  click(getButtonByName("Unstar", preview));

  await expect(
    screen.findByText("Artifact unstarred"),
  ).resolves.toBeInTheDocument();
  expect(previewNames()).toStrictEqual([second.title]);
  const undo = getButtonByName("Undo");
  externallyChanged = true;
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", { artifactId: SECOND_ID });
  });

  await expect(
    findArtifactAction("beta-refreshed-plan.txt"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    const unstarred = getButtonByName("Star", preview);
    expect(unstarred).toHaveAttribute("aria-pressed", "false");
    expect(unstarred).toHaveAttribute("aria-busy", "false");
    expect(getCatalogViewport()).toHaveAttribute("aria-busy", "false");
  });
  expect(previewNames()).toStrictEqual(["beta-refreshed-plan.txt"]);
  expect(undo).toBeVisible();
  click(undo);

  await readyFavorite("Unstar", first.title);
  expect(previewNames()).toStrictEqual([
    first.title,
    "beta-refreshed-plan.txt",
  ]);
  await waitFor(() => {
    const currentPreview = screen.getByTestId("artifact-sidebar");
    expect(getButtonByName("Unstar", currentPreview)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(getButtonByName("Unstar", currentPreview)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      within(currentPreview).getByText(
        "Undo preview survives an unrelated refresh",
      ),
    ).toBeInTheDocument();
  });
  expect(window.location.search).toBe(originalQuery);
});

test("Undo reconciles the current Starred server order after a sort response has omitted the unstarred row", async () => {
  const first = textDetail(FIRST_ID, "alpha-plan.txt");
  const second = artifact({
    id: SECOND_ID,
    title: "beta-plan.txt",
    createdAt: "2026-02-01T00:00:00Z",
  });
  const getProviderIds = mockFavorites([FIRST_ID, SECOND_ID]);
  let latestQuery: ArtifactCatalogListQuery | undefined;
  mockPreview(first, "Undo preview survives sorting");
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    latestQuery = query;
    expect(query).toStrictEqual({
      limit: 60,
      kind: "file",
      keyword: "plan",
      sort: query.sort,
      direction: query.direction,
      starred: "true",
    });
    const ordered =
      query.sort === "createdAt" ? [second, first] : [first, second];
    return respond(200, {
      artifacts: ordered.filter((row) => {
        return getProviderIds().includes(row.id);
      }),
      nextCursor: null,
    });
  });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    function (this: HTMLElement) {
      const viewport = this.closest("main");
      if (viewport) {
        viewport.scrollTop = 0;
      }
    },
  );

  await setupLibraryPage(
    `/artifacts?starred=true&tab=file&q=plan&sort=title&direction=asc&artifact=${FIRST_ID}`,
  );

  await readyFavorite("Unstar", first.title);
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("Undo preview survives sorting"),
  ).resolves.toBeInTheDocument();
  expect(previewNames()).toStrictEqual([first.title, second.title]);
  await waitFor(() => {
    expect(getButtonByName("Unstar", preview)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(getButtonByName("Unstar", preview));

  await expect(
    screen.findByText("Artifact unstarred"),
  ).resolves.toBeInTheDocument();
  const undo = getButtonByName("Undo");
  click(sortHeading("Created"));

  const currentQuery: ArtifactCatalogListQuery = {
    limit: 60,
    kind: "file",
    keyword: "plan",
    sort: "createdAt",
    direction: "desc",
    starred: "true",
  };
  await waitFor(() => {
    expect(latestQuery).toStrictEqual(currentQuery);
    expect(getCatalogViewport()).toHaveAttribute("aria-busy", "false");
    expect(previewNames()).toStrictEqual([second.title]);
    expect(sortHeading("Created").closest("th")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });
  getCatalogViewport().scrollTop = 320;
  const sortedQuery = window.location.search;
  // Editing a routed preview deliberately releases its history URL ownership.
  expect(queryParams().get("artifact")).toBeNull();
  expect(queryParams().get("starred")).toBe("true");
  expect(queryParams().get("tab")).toBe("file");
  expect(queryParams().get("q")).toBe("plan");
  expect(queryParams().get("sort")).toBe("createdAt");
  expect(queryParams().get("direction")).toBe("desc");
  click(undo);

  await readyFavorite("Unstar", first.title);
  expect(previewNames()).toStrictEqual([second.title, first.title]);
  expect(latestQuery).toStrictEqual(currentQuery);
  expect(getCatalogViewport()).toHaveAttribute("aria-busy", "false");
  expect(getCatalogViewport().scrollTop).toBe(320);
  await waitFor(() => {
    const currentPreview = screen.getByTestId("artifact-sidebar");
    expect(getButtonByName("Unstar", currentPreview)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(currentPreview).getByText("Undo preview survives sorting"),
    ).toBeInTheDocument();
  });
  expect(window.location.search).toBe(sortedQuery);
});

test("Undo reconciles a replacement Starred query when the catalog it was awaiting is cancelled", async () => {
  const first = textDetail(FIRST_ID, "alpha-plan.txt");
  const second = artifact({
    id: SECOND_ID,
    title: "beta-plan.txt",
    createdAt: "2026-02-01T00:00:00Z",
  });
  const currentTitle = "beta-current-plan.txt";
  const getProviderIds = mockFavorites([FIRST_ID, SECOND_ID]);
  const readingCreated = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  const releaseOld = context.mocks.deferred<void>();
  const completed = context.mocks.deferred<void>();
  const readingCurrent = context.mocks.deferred<void>();
  const releaseCurrent = context.mocks.deferred<void>();
  let returningToName = false;
  let awaitingCurrent = true;
  let currentReleased = false;
  let oldReleased = false;
  let latestQuery: ArtifactCatalogListQuery | undefined;
  mockPreview(first, "Undo preview survives query cancellation");
  context.mocks.api(
    artifactCatalogContract.list,
    async ({ query, request, respond }) => {
      latestQuery = query;
      expect(query).toStrictEqual({
        limit: 60,
        kind: "file",
        keyword: "plan",
        sort: query.sort,
        direction: query.sort === "createdAt" ? "desc" : "asc",
        starred: "true",
      });
      const currentSecond = returningToName
        ? { ...second, title: currentTitle }
        : second;
      const ordered =
        query.sort === "createdAt"
          ? [currentSecond, first]
          : [first, currentSecond];
      // Capture server membership before blocking: the old Created response
      // must still omit A even after Undo successfully saves its Star.
      const artifacts = ordered.filter((row) => {
        return getProviderIds().includes(row.id);
      });
      expect(
        artifacts.map((row) => {
          return row.id;
        }),
      ).toStrictEqual(
        query.sort === "createdAt" ? [SECOND_ID] : [...getProviderIds()].sort(),
      );
      if (query.sort === "createdAt") {
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
          },
          { once: true },
        );
        readingCreated.resolve();
        await releaseOld.promise;
        completed.resolve();
      } else if (returningToName && awaitingCurrent) {
        awaitingCurrent = false;
        readingCurrent.resolve();
        await releaseCurrent.promise;
      }
      return respond(200, { artifacts, nextCursor: null });
    },
  );

  await setupLibraryPage(
    `/artifacts?starred=true&tab=file&q=plan&sort=title&direction=asc&artifact=${FIRST_ID}`,
  );

  await readyFavorite("Unstar", first.title);
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("Undo preview survives query cancellation"),
  ).resolves.toBeInTheDocument();
  expect(previewNames()).toStrictEqual([first.title, second.title]);
  await waitFor(() => {
    expect(getButtonByName("Unstar", preview)).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });
  click(getButtonByName("Unstar", preview));

  await expect(
    screen.findByText("Artifact unstarred"),
  ).resolves.toBeInTheDocument();
  expect(previewNames()).toStrictEqual([second.title]);
  const undo = getButtonByName("Undo");
  click(sortHeading("Created"));
  await readingCreated.promise;

  onTestFinished(() => {
    if (!currentReleased) {
      currentReleased = true;
      releaseCurrent.resolve();
    }
    if (!oldReleased) {
      oldReleased = true;
      releaseOld.resolve();
    }
    return completed.promise;
  });
  expect(queryParams().get("sort")).toBe("createdAt");
  expect(queryParams().get("direction")).toBe("desc");
  expect(getCatalogViewport()).toHaveAttribute("aria-busy", "true");
  click(undo);

  // The shared preview proves the Star write has finished, while the
  // outer Undo still awaits the externally blocked Created catalog.
  await waitFor(() => {
    const unstar = getButtonByName("Unstar", preview);
    expect(unstar).toHaveAttribute("aria-pressed", "true");
    expect(unstar).toHaveAttribute("aria-busy", "false");
    expect(unstar).not.toHaveAttribute("aria-disabled", "true");
    expect(getProviderIds()).toStrictEqual([SECOND_ID, FIRST_ID]);
    expect(getCatalogViewport()).toHaveAttribute("aria-busy", "true");
  });
  returningToName = true;
  click(sortHeading("Name"));
  await cancelled.promise;
  await readingCurrent.promise;
  await act(() => {
    currentReleased = true;
    releaseCurrent.resolve();
  });

  // Only a new server response can render this title; a local reinsert
  // or the cancelled Created snapshot cannot satisfy this completion gate.
  await expect(findArtifactAction(currentTitle)).resolves.toBeInTheDocument();
  await readyFavorite("Unstar", first.title);
  await act(async () => {
    oldReleased = true;
    releaseOld.resolve();
    await completed.promise;
  });

  await waitFor(() => {
    expect(previewNames()).toStrictEqual([first.title, currentTitle]);
    expect(getCatalogViewport()).toHaveAttribute("aria-busy", "false");
    expect(latestQuery).toStrictEqual({
      limit: 60,
      kind: "file",
      keyword: "plan",
      sort: "title",
      direction: "asc",
      starred: "true",
    });
    expect(sortHeading("Name").closest("th")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    const currentPreview = screen.getByTestId("artifact-sidebar");
    expect(getButtonByName("Unstar", currentPreview)).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(getButtonByName("Unstar", currentPreview)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(currentPreview).getByText(
        "Undo preview survives query cancellation",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't update starred status. Try again."),
    ).not.toBeInTheDocument();
  });
  // Query edits release the artifact URL but retain the live preview.
  expect(queryParams().get("artifact")).toBeNull();
  expect(queryParams().get("starred")).toBe("true");
  expect(queryParams().get("tab")).toBe("file");
  expect(queryParams().get("q")).toBe("plan");
  expect(queryParams().get("sort")).toBe("title");
  expect(queryParams().get("direction")).toBe("asc");
});

test.each([
  ["button", "next"],
  ["menu", "next"],
  ["button", "previous"],
  ["menu", "previous"],
  ["button", "viewport"],
  ["menu", "viewport"],
] as const)(
  "Keyboard Unstar via the row %s hands focus to the surviving %s without scrolling or closing preview",
  async (entry, destination) => {
    const first = textDetail(
      FIRST_ID,
      destination === "previous" ? "zulu-plan.txt" : "alpha-plan.txt",
    );
    const second = artifact({ id: SECOND_ID, title: "beta-plan.txt" });
    const rows =
      destination === "viewport"
        ? [first]
        : destination === "previous"
          ? [second, first]
          : [first, second];
    const getProviderIds = mockFavorites(
      rows.map((row) => {
        return row.id;
      }),
    );
    mockPreview(first, "Keyboard removal keeps this preview");
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      expect(query).toStrictEqual({
        limit: 60,
        kind: "file",
        keyword: "plan",
        sort: "title",
        direction: "asc",
        starred: "true",
      });
      return respond(200, {
        artifacts: rows.filter((row) => {
          return getProviderIds().includes(row.id);
        }),
        nextCursor: null,
      });
    });
    // JSDOM does not scroll on focus. Model that browser effect so only a
    // preventScroll handoff preserves the observable catalog scroll position.
    const originalFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      originalFocus.call(this, options);
      const viewport = this.closest("main");
      if (viewport && !options?.preventScroll) {
        viewport.scrollTop = 0;
      }
    });

    await setupLibraryPage(
      `/artifacts?starred=true&tab=file&q=plan&sort=title&direction=asc&artifact=${FIRST_ID}`,
    );

    await readyFavorite("Unstar", first.title);
    const preview = await screen.findByTestId("artifact-sidebar");
    await expect(
      within(preview).findByText("Keyboard removal keeps this preview"),
    ).resolves.toBeInTheDocument();
    const viewport = getCatalogViewport();
    const focusTarget =
      destination === "viewport"
        ? viewport
        : getButtonByName(`Preview ${second.title}`, viewport);
    const originalQuery = window.location.search;
    const user = userEvent.setup();
    let sourceControl = getRowFave("Unstar", first.title);
    if (entry === "menu") {
      const more = getButtonByName(
        "More artifact actions",
        rowFor(first.title),
      );
      more.focus();
      await user.keyboard("{Enter}");
      const menu = await screen.findByRole("menu");
      await user.keyboard("{Home}");
      sourceControl = menuItem("Unstar", menu);
    } else {
      sourceControl.focus();
    }
    await waitFor(() => {
      expect(sourceControl).toHaveFocus();
    });
    viewport.scrollTop = 320;
    await user.keyboard(entry === "menu" ? "{Enter}" : " ");

    await expect(
      screen.findByText("Artifact unstarred"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(focusTarget).toHaveFocus();
      expect(previewNames()).toStrictEqual(
        destination === "viewport" ? [] : [second.title],
      );
    });
    expect(viewport.scrollTop).toBe(320);
    expect(window.location.search).toBe(originalQuery);
    expect(getButtonByName("Star", preview)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      within(preview).getByText("Keyboard removal keeps this preview"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  },
);

test("A failed unstar restores the Starred row and all controls, reports the failure and permits a new attempt", async () => {
  const detail = textDetail(FIRST_ID, "rollback-plan.txt");
  const writing = context.mocks.deferred<void>();
  const releaseWrite = context.mocks.deferred<void>();
  let unavailable = true;
  mockFavorites([FIRST_ID], async (_id, starred) => {
    expect(starred).toBeFalsy();
    if (unavailable) {
      unavailable = false;
      writing.resolve();
      await releaseWrite.promise;
      return "Favorite write unavailable";
    }
    return undefined;
  });
  mockPreview(detail, "Rollback preview stays open");
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });

  await setupLibraryPage("/artifacts?starred=true&sort=title&direction=desc");

  await readyFavorite("Unstar", detail.title);
  click(getButtonByName(`Preview ${detail.title}`, getCatalogViewport()));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("Rollback preview stays open"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getButtonByName("Unstar", preview)).toBeEnabled();
  });
  const user = userEvent.setup();
  await user.click(getButtonByName("Unstar", preview));
  await writing.promise;

  await waitFor(() => {
    expect(previewNames()).toStrictEqual([]);
  });
  const pending = getButtonByName("Star", preview);
  await repeatPendingActivation(pending, false);
  releaseWrite.resolve();

  await expect(
    screen.findByText("Favorite write unavailable"),
  ).resolves.toBeInTheDocument();
  await readyFavorite("Unstar", detail.title);
  expect(getButtonByName("Unstar", preview)).toBeEnabled();
  expect(getButtonByName("Unstar", preview)).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(getButtonByName("Unstar", preview)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(queryParams().get("starred")).toBe("true");
  expect(queryParams().get("direction")).toBe("desc");
  click(getButtonByName("Unstar", preview));

  await expect(
    screen.findByText("Artifact unstarred"),
  ).resolves.toBeInTheDocument();
  expect(previewNames()).toStrictEqual([]);
  expect(
    within(preview).getByText("Rollback preview stays open"),
  ).toBeInTheDocument();
});

test("An old Undo cannot replace a newer pending intent or the state confirmed by that write", async () => {
  const detail = textDetail(FIRST_ID, "revision-plan.txt");
  const newerWrite = context.mocks.deferred<void>();
  const releaseNewer = context.mocks.deferred<void>();
  let deferNextUnstar = false;
  mockFavorites([FIRST_ID], async (_id, starred) => {
    if (!starred && deferNextUnstar) {
      newerWrite.resolve();
      await releaseNewer.promise;
    }
    if (!starred) {
      deferNextUnstar = true;
    }
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });

  await setupLibraryPage();

  click(await readyFavorite("Unstar", detail.title));
  await expect(
    screen.findByText("Artifact unstarred"),
  ).resolves.toBeInTheDocument();
  const oldUndo = getButtonByName("Undo");
  click(await readyFavorite("Star", detail.title));
  await readyFavorite("Unstar", detail.title);
  click(getButtonByName("Unstar", rowFor(detail.title)));
  await newerWrite.promise;
  const pending = getButtonByName("Star", rowFor(detail.title));
  await repeatPendingActivation(pending, false);
  click(oldUndo);

  expect(getButtonByName("Star", rowFor(detail.title))).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(getButtonByName("Star", rowFor(detail.title))).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  releaseNewer.resolve();

  await readyFavorite("Star", detail.title);
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("Switching to Starred cancels an old All next page and only appends the current scope's response", async () => {
  mockFavorites([FIRST_ID, SECOND_ID]);
  const paging = context.mocks.deferred<void>();
  const cancelled = context.mocks.deferred<void>();
  const releaseOldPage = context.mocks.deferred<void>();
  const oldPageFinished = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.list,
    async ({ query, request, respond }) => {
      const starred =
        query.cursor === "old-all-page"
          ? undefined
          : query.cursor === "starred-page"
            ? "true"
            : query.starred;
      const expectedQuery: ArtifactCatalogListQuery = {
        limit: 60,
        kind: "file",
        keyword: "plan",
        sort: "title",
        direction: "asc",
        ...(starred ? { starred } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      };
      expect(query).toStrictEqual(expectedQuery);
      if (query.cursor === "old-all-page") {
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
          },
          { once: true },
        );
        paging.resolve();
        await releaseOldPage.promise;
        oldPageFinished.resolve();
        return respond(200, {
          artifacts: [artifact({ id: THIRD_ID, title: "Stale All plan.txt" })],
          nextCursor: null,
        });
      }
      if (query.cursor === "starred-page") {
        return respond(200, {
          artifacts: [
            artifact({
              id: SECOND_ID,
              title: "Current starred page plan.txt",
            }),
          ],
          nextCursor: null,
        });
      }
      return respond(200, {
        artifacts: [
          artifact({
            title: query.starred
              ? "Current starred plan.txt"
              : "Initial All plan.txt",
          }),
        ],
        nextCursor: query.starred ? "starred-page" : "old-all-page",
      });
    },
  );

  await setupLibraryPage("/artifacts?tab=file&q=plan&sort=title&direction=asc");

  await expect(
    findArtifactAction("Initial All plan.txt"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Load more", getCatalogViewport()));
  await paging.promise;
  click(getButtonByName("Starred", getCatalogViewport()));

  await expect(
    findArtifactAction("Current starred plan.txt"),
  ).resolves.toBeInTheDocument();
  await cancelled.promise;
  releaseOldPage.resolve();
  await oldPageFinished.promise;
  click(getButtonByName("Load more", getCatalogViewport()));

  await expect(
    findArtifactAction("Current starred page plan.txt"),
  ).resolves.toBeInTheDocument();
  expect(previewNames()).toStrictEqual([
    "Current starred plan.txt",
    "Current starred page plan.txt",
  ]);
  expect(screen.queryByText("Stale All plan.txt")).not.toBeInTheDocument();
  expect(queryParams().get("starred")).toBe("true");
  expect(queryParams().get("q")).toBe("plan");
  expect(queryParams().get("tab")).toBe("file");
});

test("A readable nonowner can star from row and preview menus without gaining Delete", async () => {
  mockFavorites();
  const detail = textDetail(FIRST_ID, "readable-plan.txt");
  const ownerRead = context.mocks.deferred<void>();
  const releaseOwner = context.mocks.deferred<void>();
  if (detail.kind !== "file") {
    throw new Error("Expected a file preview fixture");
  }
  context.mocks.http.get(detail.file.url, () => {
    return HttpResponse.text("Readable nonowner preview body");
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });
  context.mocks.api(
    artifactCatalogContract.get,
    async ({ params, query, respond }) => {
      expect(params.artifactId).toBe(detail.id);
      if (query.access === "owner") {
        ownerRead.resolve();
        await releaseOwner.promise;
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Artifact not found" },
        });
      }
      return respond(200, detail);
    },
  );

  await setupLibraryPage();

  await readyFavorite("Star", "readable-plan.txt");
  click(getButtonByName("More artifact actions", rowFor("readable-plan.txt")));
  const menu = await screen.findByRole("menu");
  await ownerRead.promise;
  expect(menuItem("Delete", menu)).toHaveAttribute("aria-disabled", "true");
  expect(menuItem("Star", menu)).not.toHaveAttribute("aria-disabled", "true");
  releaseOwner.resolve();

  await waitFor(() => {
    expect(menuItem("Delete", menu)).toHaveAttribute("aria-busy", "false");
  });
  expect(menuItem("Delete", menu)).toHaveAttribute("aria-disabled", "true");
  click(menuItem("Star", menu));

  await readyFavorite("Unstar", detail.title);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  click(getButtonByName(`Preview ${detail.title}`, getCatalogViewport()));

  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("Readable nonowner preview body"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getButtonByName("Unstar", preview)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(getButtonByName("More artifact actions", preview));
  const previewMenu = await screen.findByRole("menu");
  expect(
    queryAllByRoleFast("menuitem", previewMenu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual(["Unstar"]);
  expect(menuItem("Unstar", previewMenu)).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  click(menuItem("Unstar", previewMenu));

  await readyFavorite("Star", detail.title);
  expect(getButtonByName("Star", preview)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(
    within(preview).getByText("Readable nonowner preview body"),
  ).toBeInTheDocument();
  click(getButtonByName("More artifact actions", preview));
  const unstarredMenu = await screen.findByRole("menu");
  expect(
    queryAllByRoleFast("menuitem", unstarredMenu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual(["Star"]);
  expect(menuItem("Star", unstarredMenu)).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  click(menuItem("Star", unstarredMenu));

  await readyFavorite("Unstar", detail.title);
  expect(getButtonByName("Unstar", preview)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Native keyboard activation works in compact Library controls and More returns focus on Escape", async () => {
  mockFavorites();
  const detail = textDetail(FIRST_ID, "keyboard-plan.txt");
  mockPreview(detail, "Keyboard preview");
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [detail], nextCursor: null });
  });

  await setupLibraryPage();

  const user = userEvent.setup();
  const star = await readyFavorite("Star", detail.title);
  star.focus();
  await user.keyboard(" ");

  const unstar = await readyFavorite("Unstar", detail.title);
  expect(unstar).toHaveFocus();
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  const more = getButtonByName("More artifact actions", rowFor(detail.title));
  more.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  expect(menuItem("Unstar", menu)).toBeInTheDocument();
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });
  const scope = getButtonByName("Starred", getCatalogViewport());
  scope.focus();
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(getButtonByName("Starred", getCatalogViewport())).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(queryParams().get("starred")).toBe("true");
  click(screen.getByRole("combobox", { name: "Sort artifacts" }));
  click(await screen.findByRole("option", { name: "Name" }));

  await waitFor(() => {
    expect(queryParams().get("sort")).toBe("title");
  });
  expect(getButtonByName("Unstar", rowFor(detail.title))).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("A stale refresh response cannot clear a newer pending Star", async () => {
  const writing = context.mocks.deferred<void>();
  const releaseWrite = context.mocks.deferred<void>();
  const reading = context.mocks.deferred<void>();
  const releaseRead = context.mocks.deferred<void>();
  let saved = false;
  let refreshing = false;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          title: refreshing ? "Refreshed plan.txt" : "Initial plan.txt",
        }),
      ],
      nextCursor: null,
    });
  });
  context.mocks.api(
    artifactCatalogContract.listFavorites,
    async ({ respond }) => {
      const artifactIds = saved ? [FIRST_ID] : [];
      if (refreshing) {
        reading.resolve();
        await releaseRead.promise;
      }
      return respond(200, { artifactIds });
    },
  );
  context.mocks.api(
    artifactCatalogContract.setFavorite,
    async ({ params, body, respond }) => {
      expect(params.artifactId).toBe(FIRST_ID);
      expect(body.starred).toBeTruthy();
      writing.resolve();
      await releaseWrite.promise;
      saved = body.starred;
      return respond(200, {
        artifactId: params.artifactId,
        starred: body.starred,
      });
    },
  );

  await setupLibraryPage();

  const star = await readyFavorite("Star", "Initial plan.txt");
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
  });
  click(star);
  await writing.promise;
  await repeatPendingActivation(
    getButtonByName("Unstar", rowFor("Initial plan.txt")),
    true,
  );
  refreshing = true;
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", { artifactId: FIRST_ID });
  });
  await reading.promise;
  await expect(
    findArtifactAction("Refreshed plan.txt"),
  ).resolves.toBeInTheDocument();
  releaseRead.resolve();

  await waitFor(() => {
    const pending = getButtonByName("Unstar", rowFor("Refreshed plan.txt"));
    expect(pending).toHaveAttribute("aria-pressed", "true");
    expect(pending).toHaveAttribute("aria-disabled", "true");
  });
  releaseWrite.resolve();

  await readyFavorite("Unstar", "Refreshed plan.txt");
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("An empty Starred scope offers Browse all without changing the selected order", async () => {
  mockFavorites();
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query.sort).toBe("title");
    expect(query.direction).toBe("desc");
    return respond(200, {
      artifacts: query.starred
        ? []
        : [artifact({ title: "Available plan.txt" })],
      nextCursor: null,
    });
  });

  await setupLibraryPage("/artifacts?starred=true&sort=title&direction=desc");

  await expect(
    screen.findByRole("heading", { name: "No starred artifacts" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Star artifacts to find them here."),
  ).toBeInTheDocument();
  click(getButtonByName("Browse all artifacts", getCatalogViewport()));

  await expect(
    findArtifactAction("Available plan.txt"),
  ).resolves.toBeInTheDocument();
  expect(
    getButtonByName("All artifacts", getCatalogViewport()),
  ).toHaveAttribute("aria-pressed", "true");
  expect(queryParams().has("starred")).toBeFalsy();
  expect(queryParams().get("sort")).toBe("title");
  expect(queryParams().get("direction")).toBe("desc");
});
