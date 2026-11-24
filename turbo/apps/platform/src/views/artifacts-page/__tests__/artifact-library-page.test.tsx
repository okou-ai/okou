import {
  artifactCatalogContract,
  type ArtifactCatalogListQuery,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  getCatalogViewport,
  queryButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const FIRST_ID = "a0000000-0000-4000-a000-000000000001";
const SECOND_ID = "a0000000-0000-4000-a000-000000000002";
const THIRD_ID = "a0000000-0000-4000-a000-000000000003";
const SHARED_THREAD_ID = "b0000000-0000-4000-a000-000000000001";

function setupLibraryPage(path = "/artifacts") {
  return setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactLibrary]: true,
    },
  });
}

function queryParams() {
  return new URLSearchParams(window.location.search);
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

function getSortHeading(name: string): HTMLElement {
  const tableHead = getCatalogViewport().querySelector("thead");
  if (!tableHead) {
    throw new Error("Expected the artifact Library table headings");
  }
  return getButtonByName(name, tableHead);
}

async function selectType(name: string) {
  click(screen.getByRole("combobox", { name: "Type" }));
  const option = await screen.findByRole("option", { name });
  click(option);
}

function getDeleteMenuItem(menu: HTMLElement): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === "Delete";
  });
  if (!item) {
    throw new Error("Expected the row's Delete menu item");
  }
  return item;
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

test("The enabled Library starts with all kinds ordered by creation and does not auto-open a preview", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({
      limit: 60,
      direction: "desc",
    });
    return respond(200, {
      artifacts: [
        artifact({ title: "legacy-plan.txt" }),
        artifact({
          id: SECOND_ID,
          kind: "image",
          title: "launch-image.png",
          createdAt: "2026-02-01T00:00:00Z",
          updatedAt: "2026-11-21T12:00:00Z",
        }),
      ],
      nextCursor: null,
    });
  });

  await setupLibraryPage();

  await expect(
    findArtifactAction("legacy-plan.txt"),
  ).resolves.toBeInTheDocument();
  const viewport = getCatalogViewport();
  expect(
    screen.getByRole("heading", { name: "Artifacts", level: 1 }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "All artifacts" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
    "All types",
  );
  expect(getSortHeading("Created").closest("th")).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  expect(getButtonByName("Created Sort ascending", viewport)).toHaveTextContent(
    "Created",
  );
  expect(
    queryAllByRoleFast("columnheader", viewport).map((heading) => {
      return heading.textContent?.trim();
    }),
  ).toStrictEqual(["Name", "Created", "Type", "More artifact actions"]);
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("complementary", { name: "Artifact" }),
  ).not.toBeInTheDocument();

  const legacyCells = queryAllByRoleFast("cell", rowFor("legacy-plan.txt"));
  expect(legacyCells[1]?.querySelector("time")).toHaveAttribute(
    "dateTime",
    "2026-01-01T00:00:00Z",
  );
  const imageCells = queryAllByRoleFast("cell", rowFor("launch-image.png"));
  for (const cell of [imageCells[0], imageCells[1]]) {
    expect(cell?.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-02-01T00:00:00Z",
    );
  }

  expect(
    queryAllByRoleFast("combobox", viewport).map((control) => {
      return control.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Type"]);
  expect(
    queryAllByRoleFast("button", viewport).some((button) => {
      return /\b(star|favorite|source)\b/iu.test(
        button.getAttribute("aria-label") ?? button.textContent ?? "",
      );
    }),
  ).toBeFalsy();
  expect(
    screen.getByRole("navigation", { name: "Sidebar" }),
  ).toBeInTheDocument();

  click(screen.getByRole("combobox", { name: "Type" }));

  const choices = await screen.findByRole("listbox");
  expect(
    queryAllByRoleFast("option", choices).map((option) => {
      return option.textContent?.trim();
    }),
  ).toStrictEqual([
    "All types",
    "Presentation",
    "Hosted site",
    "Image",
    "Video",
    "Avatar",
    "Shared chat",
    "File",
  ]);
  click(within(choices).getByRole("option", { name: "All types" }));
});

test.each([undefined, false])(
  "The default or disabled Library switch (%s) keeps the Presentation gallery",
  async (enabled) => {
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      expect(query).toStrictEqual({ limit: 60, kind: "presentation" });
      return respond(200, {
        artifacts: [
          artifact({ kind: "presentation", title: "Existing launch deck" }),
        ],
        nextCursor: null,
      });
    });

    await setupPage({
      context,
      path: "/artifacts",
      featureSwitches:
        enabled === undefined
          ? undefined
          : { [FeatureSwitchKey.ArtifactLibrary]: enabled },
    });

    await expect(
      findArtifactAction("Existing launch deck"),
    ).resolves.toBeInTheDocument();
    expect(getButtonByName("Show presentation artifacts")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Artifact kind filters")).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: "Search artifacts" }),
    ).not.toBeInTheDocument();
  },
);

test("Search debounces to the latest keyword and finds matches outside the loaded page", async () => {
  const searchQueries: ArtifactCatalogListQuery[] = [];
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.keyword) {
      searchQueries.push(query);
      return respond(200, {
        artifacts: [
          artifact({ id: SECOND_ID, title: "Archived launch plan.txt" }),
        ],
        nextCursor: null,
      });
    }
    return respond(200, {
      artifacts: [artifact({ title: "Recently created notes.txt" })],
      nextCursor: "not-yet-loaded-page",
    });
  });

  await setupLibraryPage();

  await expect(
    findArtifactAction("Recently created notes.txt"),
  ).resolves.toBeInTheDocument();
  const search = screen.getByRole("searchbox", { name: "Search artifacts" });
  for (const value of ["l", "la", "lau", "laun", "launch"]) {
    fireEvent.change(search, { target: { value } });
    expect(search).toHaveValue(value);
  }

  await expect(
    findArtifactAction("Archived launch plan.txt"),
  ).resolves.toBeInTheDocument();
  expect(searchQueries).toStrictEqual([
    {
      limit: 60,
      keyword: "launch",
      direction: "desc",
    },
  ]);
  expect(queryParams().get("q")).toBe("launch");
  expect(
    screen.queryByText("Recently created notes.txt"),
  ).not.toBeInTheDocument();
  expect(queryButtonByName("Load more", getCatalogViewport())).toBeUndefined();
});

test("Clearing search cancels an unsettled keyword rather than reviving it later", async () => {
  const keywords: string[] = [];
  let unfiltered = 0;
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.keyword) {
      keywords.push(query.keyword);
      return respond(200, {
        artifacts: [artifact({ title: "Confirmed search result.txt" })],
        nextCursor: null,
      });
    }
    unfiltered += 1;
    return respond(200, {
      artifacts: [
        artifact({
          title: unfiltered === 1 ? "Initial notes.txt" : "Restored notes.txt",
        }),
      ],
      nextCursor: null,
    });
  });

  await setupLibraryPage();

  await expect(
    findArtifactAction("Initial notes.txt"),
  ).resolves.toBeInTheDocument();
  const search = screen.getByRole("searchbox", { name: "Search artifacts" });
  fireEvent.change(search, { target: { value: "discarded" } });
  click(getButtonByName("Clear search", getCatalogViewport()));

  await expect(
    findArtifactAction("Restored notes.txt"),
  ).resolves.toBeInTheDocument();
  expect(search).toHaveValue("");
  expect(queryParams().has("q")).toBeFalsy();
  await fill(search, "confirmed");

  await expect(
    findArtifactAction("Confirmed search result.txt"),
  ).resolves.toBeInTheDocument();
  expect(keywords).toStrictEqual(["confirmed"]);
});

test("Whitespace-only search and clearing it omit the keyword from the production request", async () => {
  let title = "Initial unfiltered notes.txt";
  context.mocks.api(
    artifactCatalogContract.list,
    ({ query, request, respond }) => {
      expect(query).toStrictEqual({
        limit: 60,
        kind: "file",
        direction: "asc",
      });
      expect(new URL(request.url).searchParams.has("keyword")).toBeFalsy();
      return respond(200, {
        artifacts: [artifact({ title })],
        nextCursor: null,
      });
    },
  );

  await setupLibraryPage("/artifacts?tab=file&direction=asc");

  await expect(
    findArtifactAction("Initial unfiltered notes.txt"),
  ).resolves.toBeInTheDocument();
  const search = screen.getByRole("searchbox", { name: "Search artifacts" });
  title = "Whitespace unfiltered notes.txt";
  await fill(search, "   ");

  await expect(
    findArtifactAction("Whitespace unfiltered notes.txt"),
  ).resolves.toBeInTheDocument();
  expect(search).toHaveValue("   ");
  title = "Cleared unfiltered notes.txt";
  click(getButtonByName("Clear search", getCatalogViewport()));

  await expect(
    findArtifactAction("Cleared unfiltered notes.txt"),
  ).resolves.toBeInTheDocument();
  expect(search).toHaveValue("");
  expect(queryParams().has("q")).toBeFalsy();
});

test("The Created heading changes the server direction without losing the keyword", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query.keyword).toBe("launch");
    expect(query.kind).toBeUndefined();
    return respond(200, {
      artifacts: [artifact({ title: `launch-${query.direction}.txt` })],
      nextCursor: null,
    });
  });

  await setupLibraryPage("/artifacts?q=launch");

  await expect(
    findArtifactAction("launch-desc.txt"),
  ).resolves.toBeInTheDocument();
  for (const direction of ["asc", "desc"] as const) {
    click(getSortHeading("Created"));

    await expect(
      findArtifactAction(`launch-${direction}.txt`),
    ).resolves.toBeInTheDocument();
    expect(getSortHeading("Created").closest("th")).toHaveAttribute(
      "aria-sort",
      direction === "asc" ? "ascending" : "descending",
    );
    expect(queryParams().get("direction")).toBe(direction);
    expect(queryParams().get("q")).toBe("launch");
  }
});

test("The compact Created button shares direction with the table heading and retains kind and keyword", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query.kind).toBe("image");
    expect(query.keyword).toBe("launch");
    return respond(200, {
      artifacts: [
        artifact({ kind: "image", title: `created-${query.direction}.png` }),
      ],
      nextCursor: null,
    });
  });

  await setupLibraryPage("/artifacts?tab=image&q=launch&direction=asc");

  await expect(
    findArtifactAction("created-asc.png"),
  ).resolves.toBeInTheDocument();
  const compactSort = getButtonByName(
    "Created Sort descending",
    getCatalogViewport(),
  );
  expect(compactSort).toHaveAccessibleName("Created Sort descending");
  compactSort.focus();
  const user = userEvent.setup();
  await user.keyboard("{Enter}");

  await expect(
    findArtifactAction("created-desc.png"),
  ).resolves.toBeInTheDocument();
  expect(getSortHeading("Created").closest("th")).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  const heading = getSortHeading("Created");
  heading.focus();
  await user.keyboard(" ");

  await expect(
    findArtifactAction("created-asc.png"),
  ).resolves.toBeInTheDocument();
  expect(getSortHeading("Created").closest("th")).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  expect(queryParams().get("tab")).toBe("image");
  expect(queryParams().get("q")).toBe("launch");
  expect(queryParams().get("direction")).toBe("asc");
});

test.each(["type", "direction", "search"] as const)(
  "Changing %s resets the cursor and cancels an old page while retaining the other filters",
  async (change) => {
    const pagingStarted = context.mocks.deferred<void>();
    const pagingCancelled = context.mocks.deferred<void>();
    const releaseOldPage = context.mocks.deferred<void>();
    const oldPageFinished = context.mocks.deferred<void>();
    const initialQuery = {
      limit: 60,
      kind: "file",
      keyword: "launch",
      direction: "desc",
    } satisfies ArtifactCatalogListQuery;
    const changedQuery: ArtifactCatalogListQuery = {
      ...initialQuery,
      ...(change === "type" ? { kind: "image" } : {}),
      ...(change === "direction" ? { direction: "asc" } : {}),
      ...(change === "search" ? { keyword: "roadmap" } : {}),
    };
    const matchesChangedQuery = (query: ArtifactCatalogListQuery) => {
      return (
        query.kind === changedQuery.kind &&
        query.keyword === changedQuery.keyword &&
        query.direction === changedQuery.direction
      );
    };
    context.mocks.api(
      artifactCatalogContract.list,
      async ({ query, request, respond }) => {
        let expectedQuery: ArtifactCatalogListQuery = matchesChangedQuery(query)
          ? changedQuery
          : initialQuery;
        if (query.cursor === "old-page") {
          expectedQuery = { ...initialQuery, cursor: "old-page" };
        } else if (query.cursor === "current-page") {
          expectedQuery = { ...changedQuery, cursor: "current-page" };
        }
        expect(query).toStrictEqual(expectedQuery);
        if (query.cursor === "old-page") {
          request.signal.addEventListener(
            "abort",
            () => {
              pagingCancelled.resolve();
            },
            { once: true },
          );
          pagingStarted.resolve();
          await releaseOldPage.promise;
          oldPageFinished.resolve();
          return respond(200, {
            artifacts: [
              artifact({ id: THIRD_ID, title: "Discarded old page.txt" }),
            ],
            nextCursor: null,
          });
        }
        if (query.cursor === "current-page") {
          return respond(200, {
            artifacts: [
              artifact({
                id: THIRD_ID,
                kind: changedQuery.kind,
                title: "Current next page.txt",
              }),
            ],
            nextCursor: null,
          });
        }
        if (matchesChangedQuery(query)) {
          return respond(200, {
            artifacts: [
              artifact({
                id: SECOND_ID,
                kind: changedQuery.kind,
                title: "Current filtered result.txt",
              }),
            ],
            nextCursor: "current-page",
          });
        }
        return respond(200, {
          artifacts: [artifact({ title: "Initial filtered result.txt" })],
          nextCursor: "old-page",
        });
      },
    );

    await setupLibraryPage("/artifacts?tab=file&q=launch&direction=desc");

    await expect(
      findArtifactAction("Initial filtered result.txt"),
    ).resolves.toBeInTheDocument();
    click(getButtonByName("Load more", getCatalogViewport()));
    await pagingStarted.promise;

    if (change === "type") {
      await selectType("Image");
    } else if (change === "direction") {
      click(getSortHeading("Created"));
    } else {
      await fill(
        screen.getByRole("searchbox", { name: "Search artifacts" }),
        "roadmap",
      );
    }

    await expect(
      findArtifactAction("Current filtered result.txt"),
    ).resolves.toBeInTheDocument();
    await pagingCancelled.promise;
    releaseOldPage.resolve();
    await oldPageFinished.promise;
    expect(
      screen.queryByText("Initial filtered result.txt"),
    ).not.toBeInTheDocument();

    click(getButtonByName("Load more", getCatalogViewport()));

    await expect(
      findArtifactAction("Current next page.txt"),
    ).resolves.toBeInTheDocument();
    expect(
      getButtonByName(
        "Preview Current filtered result.txt",
        getCatalogViewport(),
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Discarded old page.txt"),
    ).not.toBeInTheDocument();
    expect(queryParams().get("tab")).toBe(changedQuery.kind);
    expect(queryParams().get("q")).toBe(changedQuery.keyword);
    expect(queryParams().get("direction")).toBe(changedQuery.direction);
  },
);

test("Rows open with Enter and Space, switch previews, and return focus without changing the Library query or scroll", async () => {
  const first = textDetail(FIRST_ID, "launch-plan.txt");
  const second = textDetail(SECOND_ID, "launch-checklist.txt");
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [first, second], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    return respond(200, params.artifactId === FIRST_ID ? first : second);
  });
  context.mocks.http.get(
    "https://artifacts.example.com/launch-plan.txt",
    () => {
      return HttpResponse.text("First launch preview");
    },
  );
  context.mocks.http.get(
    "https://artifacts.example.com/launch-checklist.txt",
    () => {
      return HttpResponse.text("Second launch preview");
    },
  );

  await setupLibraryPage(
    "/artifacts?tab=file&q=launch&direction=asc&view=keep",
  );

  await expect(
    findArtifactAction("launch-plan.txt"),
  ).resolves.toBeInTheDocument();
  const viewport = getCatalogViewport();
  viewport.scrollTop = 320;
  const firstRow = getButtonByName("Preview launch-plan.txt", viewport);
  const secondRow = getButtonByName("Preview launch-checklist.txt", viewport);
  const user = userEvent.setup();
  firstRow.focus();
  await user.keyboard("{Enter}");

  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("First launch preview"),
  ).resolves.toBeInTheDocument();
  expect(firstRow).toHaveAttribute("aria-current", "true");
  expect(
    queryButtonByName("Created Sort descending", viewport),
  ).toBeUndefined();
  await waitFor(() => {
    expect(
      getButtonByName("More artifact actions", preview),
    ).toBeInTheDocument();
  });
  for (const action of [
    "Share artifact",
    "Download artifact",
    "Enter fullscreen",
    "Close artifact",
  ]) {
    expect(getButtonByName(action, preview)).toBeInTheDocument();
  }
  click(getButtonByName("Enter fullscreen", preview));
  await waitFor(() => {
    expect(getButtonByName("Exit fullscreen", preview)).toBeInTheDocument();
  });
  click(getButtonByName("Exit fullscreen", preview));

  firstRow.focus();
  await user.keyboard("{ArrowDown}");
  expect(secondRow).toHaveFocus();
  await user.keyboard(" ");

  await expect(
    screen.findByText("Second launch preview"),
  ).resolves.toBeInTheDocument();
  const switchedPreview = screen.getByTestId("artifact-sidebar");
  expect(
    queryButtonByName("Created Sort descending", viewport),
  ).toBeUndefined();
  expect(secondRow).toHaveAttribute("aria-current", "true");
  expect(firstRow).not.toHaveAttribute("aria-current");
  expect(queryParams().get("artifact")).toBeNull();
  expect(queryParams().get("view")).toBe("keep");
  click(getButtonByName("Close artifact", switchedPreview));

  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    expect(secondRow).toHaveFocus();
  });
  expect(viewport.scrollTop).toBe(320);
  expect(
    getButtonByName("Created Sort descending", viewport),
  ).toHaveTextContent("Created");
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toHaveValue("launch");
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
    "File",
  );
  expect(queryParams().get("tab")).toBe("file");
  expect(queryParams().get("q")).toBe("launch");
  expect(queryParams().get("direction")).toBe("asc");
});

test("A routed preview closes back to its original Library query", async () => {
  const detail = textDetail(FIRST_ID, "release-notes.txt");
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({
      limit: 60,
      kind: "file",
      keyword: "release",
      direction: "asc",
    });
    return respond(200, { artifacts: [detail], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.http.get(
    "https://artifacts.example.com/release-notes.txt",
    () => {
      return HttpResponse.text("Release preview");
    },
  );

  await setupLibraryPage(
    `/artifacts?tab=file&q=release&direction=asc&artifact=${FIRST_ID}`,
  );

  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("Release preview"),
  ).resolves.toBeInTheDocument();
  expect(
    queryButtonByName("Created Sort descending", getCatalogViewport()),
  ).toBeUndefined();
  expect(queryParams().get("artifact")).toBe(FIRST_ID);
  click(getButtonByName("Close artifact", preview));

  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    expect(queryParams().has("artifact")).toBeFalsy();
  });
  await expect(
    findArtifactAction("release-notes.txt"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/artifacts");
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toHaveValue("release");
  expect(
    getButtonByName("Created Sort descending", getCatalogViewport()),
  ).toHaveTextContent("Created");
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
    "File",
  );
  expect(queryParams().get("q")).toBe("release");
  expect(queryParams().get("direction")).toBe("asc");
});

test.each(["search", "type", "direction"] as const)(
  "Closing a routed preview after changing %s keeps the current query and does not reopen it",
  async (change) => {
    const detail = textDetail(FIRST_ID, "launch-routed.txt");
    const initialQuery = {
      limit: 60,
      kind: "file",
      keyword: "launch",
      direction: "asc",
    } satisfies ArtifactCatalogListQuery;
    const changedQuery: ArtifactCatalogListQuery = {
      ...initialQuery,
      ...(change === "search" ? { keyword: "roadmap" } : {}),
      ...(change === "type" ? { kind: "image" } : {}),
      ...(change === "direction" ? { direction: "desc" } : {}),
    };
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      const matchesChangedQuery =
        query.kind === changedQuery.kind &&
        query.keyword === changedQuery.keyword &&
        query.direction === changedQuery.direction;
      let expectedQuery: ArtifactCatalogListQuery = matchesChangedQuery
        ? changedQuery
        : initialQuery;
      if (query.keyword === "verification") {
        expectedQuery = { ...changedQuery, keyword: "verification" };
      }
      expect(query).toStrictEqual(expectedQuery);
      if (query.keyword === "verification") {
        return respond(200, {
          artifacts: [
            artifact({
              id: THIRD_ID,
              kind: changedQuery.kind,
              title: "verification-result.txt",
            }),
          ],
          nextCursor: null,
        });
      }
      if (matchesChangedQuery) {
        return respond(200, {
          artifacts: [
            artifact({
              id: SECOND_ID,
              kind: changedQuery.kind,
              title: "launch roadmap filtered result.txt",
            }),
          ],
          nextCursor: null,
        });
      }
      return respond(200, { artifacts: [detail], nextCursor: null });
    });
    context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
      expect(params.artifactId).toBe(FIRST_ID);
      return respond(200, detail);
    });
    context.mocks.http.get(
      "https://artifacts.example.com/launch-routed.txt",
      () => {
        return HttpResponse.text("Routed launch preview");
      },
    );

    await setupLibraryPage(
      `/artifacts?tab=file&q=launch&direction=asc&artifact=${FIRST_ID}`,
    );

    await expect(
      screen.findByText("Routed launch preview"),
    ).resolves.toBeInTheDocument();
    if (change === "search") {
      await fill(
        screen.getByRole("searchbox", { name: "Search artifacts" }),
        "roadmap",
      );
    } else if (change === "type") {
      await selectType("Image");
    } else {
      click(getSortHeading("Created"));
    }

    await expect(
      findArtifactAction("launch roadmap filtered result.txt"),
    ).resolves.toBeInTheDocument();
    const preview = screen.getByTestId("artifact-sidebar");
    click(getButtonByName("Close artifact", preview));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
      expect(queryParams().has("artifact")).toBeFalsy();
    });
    expect(queryParams().get("tab")).toBe(changedQuery.kind);
    expect(queryParams().get("q")).toBe(changedQuery.keyword);
    expect(queryParams().get("direction")).toBe(changedQuery.direction);
    expect(
      getButtonByName(
        "Preview launch roadmap filtered result.txt",
        getCatalogViewport(),
      ),
    ).toBeInTheDocument();
    await fill(
      screen.getByRole("searchbox", { name: "Search artifacts" }),
      "verification",
    );

    await expect(
      findArtifactAction("verification-result.txt"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    expect(queryParams().has("artifact")).toBeFalsy();
    expect(queryParams().get("q")).toBe("verification");
  },
);

test("Shared chats remain native external links to their shared-thread identity", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          kind: "shared-thread",
          title: "Weekly launch review",
          sharedThreadId: SHARED_THREAD_ID,
        }),
      ],
      nextCursor: null,
    });
  });

  await setupLibraryPage();

  const conversation = await findArtifactAction("Weekly launch review");
  expect(conversation).toHaveRole("link");
  expect(conversation).toHaveAccessibleName("Preview Weekly launch review");
  expect(conversation).toHaveAttribute(
    "href",
    `/share/threads/${SHARED_THREAD_ID}`,
  );
  expect(conversation).toHaveAttribute("target", "_blank");
  expect(conversation).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("A row's More menu validates ownership before Delete and restores its own trigger on Cancel or Escape", async () => {
  const detail = textDetail(FIRST_ID, "launch-plan.txt");
  const ownerStarted = context.mocks.deferred<void>();
  const releaseOwner = context.mocks.deferred<void>();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        detail,
        artifact({ id: SECOND_ID, title: "another-plan.txt" }),
      ],
      nextCursor: null,
    });
  });
  context.mocks.api(
    artifactCatalogContract.get,
    async ({ params, respond }) => {
      expect(params.artifactId).toBe(FIRST_ID);
      if (!ownerStarted.settled()) {
        ownerStarted.resolve();
      }
      await releaseOwner.promise;
      return respond(200, detail);
    },
  );

  await setupLibraryPage();

  await expect(
    findArtifactAction("launch-plan.txt"),
  ).resolves.toBeInTheDocument();
  const more = getButtonByName(
    "More artifact actions",
    rowFor("launch-plan.txt"),
  );
  click(more);
  const menu = await screen.findByRole("menu");
  await ownerStarted.promise;
  expect(getDeleteMenuItem(menu)).toHaveAttribute("aria-disabled", "true");
  expect(getDeleteMenuItem(menu)).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  releaseOwner.resolve();

  await waitFor(() => {
    expect(getDeleteMenuItem(menu)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(getDeleteMenuItem(menu));
  const cancelled = await screen.findByRole("dialog", {
    name: "Delete launch-plan.txt?",
  });
  click(getButtonByName("Cancel", cancelled));

  await waitFor(() => {
    expect(cancelled).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });
  const user = userEvent.setup();
  await user.keyboard("{Enter}");
  const reopenedMenu = await screen.findByRole("menu");
  await waitFor(() => {
    expect(getDeleteMenuItem(reopenedMenu)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(getDeleteMenuItem(reopenedMenu));
  const escaped = await screen.findByRole("dialog", {
    name: "Delete launch-plan.txt?",
  });
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(escaped).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("A denied row ownership read leaves Delete disabled instead of opening a confirmation or preview", async () => {
  const releaseOwner = context.mocks.deferred<void>();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ title: "restricted-plan.txt" })],
      nextCursor: null,
    });
  });
  context.mocks.api(
    artifactCatalogContract.get,
    async ({ params, respond }) => {
      expect(params.artifactId).toBe(FIRST_ID);
      await releaseOwner.promise;
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Artifact unavailable" },
      });
    },
  );

  await setupLibraryPage();

  await expect(
    findArtifactAction("restricted-plan.txt"),
  ).resolves.toBeInTheDocument();
  click(
    getButtonByName("More artifact actions", rowFor("restricted-plan.txt")),
  );
  const menu = await screen.findByRole("menu");
  expect(getDeleteMenuItem(menu)).toHaveAttribute("aria-busy", "true");
  releaseOwner.resolve();

  await waitFor(() => {
    expect(getDeleteMenuItem(menu)).toHaveAttribute("aria-busy", "false");
  });
  expect(getDeleteMenuItem(menu)).toHaveAttribute("aria-disabled", "true");
  click(getDeleteMenuItem(menu));
  expect(menu).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("Row deletion retries in its own confirmation and keeps another artifact's sidebar open", async () => {
  const keep = textDetail(FIRST_ID, "keep-open.txt");
  const remove = textDetail(SECOND_ID, "remove-me.txt");
  const deleting = context.mocks.deferred<void>();
  const releaseFailure = context.mocks.deferred<void>();
  let removed = false;
  let unavailable = true;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: removed ? [keep] : [keep, remove],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    return respond(200, params.artifactId === FIRST_ID ? keep : remove);
  });
  context.mocks.http.get("https://artifacts.example.com/keep-open.txt", () => {
    return HttpResponse.text("The retained artifact preview");
  });
  context.mocks.api(
    artifactCatalogContract.delete,
    async ({ params, respond }) => {
      expect(params.artifactId).toBe(SECOND_ID);
      if (unavailable) {
        deleting.resolve();
        await releaseFailure.promise;
        unavailable = false;
        return respond(503, {
          error: {
            code: "NOT_CONFIGURED",
            message: "Could not delete this row",
          },
        });
      }
      removed = true;
      return respond(200, { deleted: true });
    },
  );

  await setupLibraryPage("/artifacts?tab=file&q=txt&direction=asc");

  await expect(
    findArtifactAction("keep-open.txt"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Preview keep-open.txt", getCatalogViewport()));
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByText("The retained artifact preview"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("More artifact actions", rowFor("remove-me.txt")));
  const menu = await screen.findByRole("menu");
  await waitFor(() => {
    expect(getDeleteMenuItem(menu)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(getDeleteMenuItem(menu));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete remove-me.txt?",
  });
  click(getButtonByName("Delete", dialog));
  await deleting.promise;

  await waitFor(() => {
    expect(getButtonByName("Deleting…", dialog)).toBeDisabled();
  });
  expect(getButtonByName("Cancel", dialog)).toBeDisabled();
  const user = userEvent.setup();
  await user.keyboard("{Escape}");
  expect(dialog).toBeInTheDocument();
  releaseFailure.resolve();

  await expect(
    screen.findByText("Could not delete this row"),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Delete", dialog)).toBeEnabled();
  expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
  click(getButtonByName("Delete", dialog));

  await expect(
    screen.findByText("Artifact deleted"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Delete remove-me.txt?" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("remove-me.txt")).not.toBeInTheDocument();
    expect(getCatalogViewport()).toHaveFocus();
  });
  const retainedPreview = screen.getByTestId("artifact-sidebar");
  await expect(
    within(retainedPreview).findByText("The retained artifact preview"),
  ).resolves.toBeInTheDocument();
  expect(
    getButtonByName("Preview keep-open.txt", getCatalogViewport()),
  ).toBeInTheDocument();
  expect(queryParams().get("tab")).toBe("file");
  expect(queryParams().get("q")).toBe("txt");
  expect(queryParams().get("direction")).toBe("asc");
});

test.each([false, true])(
  "Realtime invalidation preserves a row confirmation (DELETE pending: %s)",
  async (deletePending) => {
    const keep = artifact({ title: "keep-this.txt" });
    const remove = textDetail(SECOND_ID, "remove-on-confirm.txt");
    const deleting = context.mocks.deferred<void>();
    const releaseDelete = context.mocks.deferred<void>();
    const refreshStarted = context.mocks.deferred<void>();
    const releaseRefresh = context.mocks.deferred<void>();
    let refreshing = false;
    let removed = false;
    context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
      if (refreshing) {
        if (!refreshStarted.settled()) {
          refreshStarted.resolve();
        }
        await releaseRefresh.promise;
      }
      return respond(200, {
        artifacts: removed ? [keep] : [keep, remove],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
      expect(params.artifactId).toBe(SECOND_ID);
      return respond(200, remove);
    });
    context.mocks.api(
      artifactCatalogContract.delete,
      async ({ params, respond }) => {
        expect(params.artifactId).toBe(SECOND_ID);
        deleting.resolve();
        await releaseDelete.promise;
        removed = true;
        return respond(200, { deleted: true });
      },
    );

    await setupLibraryPage();

    await expect(
      findArtifactAction("remove-on-confirm.txt"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("artifact:changed"),
      ).toBeTruthy();
    });
    click(
      getButtonByName("More artifact actions", rowFor("remove-on-confirm.txt")),
    );
    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(getDeleteMenuItem(menu)).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });
    click(getDeleteMenuItem(menu));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete remove-on-confirm.txt?",
    });
    if (deletePending) {
      click(getButtonByName("Delete", dialog));
      await deleting.promise;
    }
    await waitFor(() => {
      expect(
        getButtonByName(deletePending ? "Deleting…" : "Delete", dialog),
      ).toHaveProperty("disabled", deletePending);
    });

    refreshing = true;
    await act(() => {
      context.mocks.ably.trigger("artifact:changed", { artifactId: FIRST_ID });
    });
    await refreshStarted.promise;
    await waitFor(() => {
      expect(getCatalogViewport()).toHaveAttribute("aria-busy", "true");
    });
    const pendingDialog = screen.getByRole("dialog", {
      name: "Delete remove-on-confirm.txt?",
    });
    expect(pendingDialog).toBeInTheDocument();
    expect(
      getButtonByName(deletePending ? "Deleting…" : "Delete", pendingDialog),
    ).toBeInTheDocument();
    releaseRefresh.resolve();

    await expect(
      within(getCatalogViewport()).findByText("remove-on-confirm.txt"),
    ).resolves.toBeInTheDocument();
    const retainedDialog = screen.getByRole("dialog", {
      name: "Delete remove-on-confirm.txt?",
    });
    const retainedAction = getButtonByName(
      deletePending ? "Deleting…" : "Delete",
      retainedDialog,
    );
    expect(retainedAction).toHaveProperty("disabled", deletePending);
    if (!deletePending) {
      click(retainedAction);
      await deleting.promise;
    }
    await waitFor(() => {
      expect(getButtonByName("Deleting…", retainedDialog)).toBeDisabled();
    });
    refreshing = false;
    releaseDelete.resolve();

    await expect(
      screen.findByText("Artifact deleted"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: "Delete remove-on-confirm.txt?",
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("remove-on-confirm.txt"),
      ).not.toBeInTheDocument();
    });
    expect(
      getButtonByName("Preview keep-this.txt", getCatalogViewport()),
    ).toBeInTheDocument();
  },
);

test("Loading, list failure, and retry retain the Library controls", async () => {
  const release = context.mocks.deferred<void>();
  let unavailable = true;
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    if (unavailable) {
      await release.promise;
      unavailable = false;
      return respond(503, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Catalog unavailable",
        },
      });
    }
    return respond(200, {
      artifacts: [artifact({ title: "Recovered launch plan.txt" })],
      nextCursor: null,
    });
  });

  await setupLibraryPage();

  await expect(
    screen.findByRole("status", { name: "Loading artifacts" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
    "All types",
  );
  release.resolve();

  const error = await screen.findByRole("alert");
  expect(
    within(error).getByText("Couldn't load artifacts."),
  ).toBeInTheDocument();
  click(getButtonByName("Try again", error));

  await expect(
    findArtifactAction("Recovered launch plan.txt"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("An empty unfiltered Library explains where artifacts will appear", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupLibraryPage();

  await expect(
    screen.findByRole("heading", { name: "No artifacts found" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Artifacts will appear here when they are available."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
    "All types",
  );
});

test("Clearing an empty keyword and type intersection restores All without resetting the chosen order", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({
      limit: 60,
      ...(query.keyword === "missing"
        ? { kind: "video", keyword: "missing" }
        : {}),
      direction: "asc",
    });
    if (query.keyword === "missing") {
      return respond(200, { artifacts: [], nextCursor: null });
    }
    return respond(200, {
      artifacts: [artifact({ title: "Available launch plan.txt" })],
      nextCursor: null,
    });
  });

  await setupLibraryPage("/artifacts?tab=video&q=missing&direction=asc");

  await expect(
    screen.findByRole("heading", { name: "No artifacts found" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Try another name or type.")).toBeInTheDocument();
  click(getButtonByName("Clear filters", getCatalogViewport()));

  await expect(
    findArtifactAction("Available launch plan.txt"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
    "All types",
  );
  expect(queryParams().get("tab")).toBe("all");
  expect(queryParams().has("q")).toBeFalsy();
  expect(queryParams().get("direction")).toBe("asc");
});

test("Load more preserves earlier rows and retries a failed next page with the complete query", async () => {
  const pageStarted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let failNextPage = true;
  context.mocks.api(
    artifactCatalogContract.list,
    async ({ query, respond }) => {
      expect(query).toStrictEqual({
        limit: 60,
        kind: "file",
        keyword: "launch",
        direction: "asc",
        ...(query.cursor ? { cursor: "next-launch-page" } : {}),
      });
      if (query.cursor) {
        if (failNextPage) {
          pageStarted.resolve();
          await release.promise;
          failNextPage = false;
          return respond(503, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Next page unavailable",
            },
          });
        }
        return respond(200, {
          artifacts: [
            artifact({ id: SECOND_ID, title: "launch-second-page.txt" }),
          ],
          nextCursor: null,
        });
      }
      return respond(200, {
        artifacts: [artifact({ title: "launch-first-page.txt" })],
        nextCursor: "next-launch-page",
      });
    },
  );

  await setupLibraryPage("/artifacts?tab=file&q=launch&direction=asc");

  await expect(
    findArtifactAction("launch-first-page.txt"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Load more", getCatalogViewport()));
  await pageStarted.promise;
  await waitFor(() => {
    expect(getButtonByName("Load more", getCatalogViewport())).toBeDisabled();
  });
  expect(
    getButtonByName("Preview launch-first-page.txt", getCatalogViewport()),
  ).toBeInTheDocument();
  release.resolve();

  await waitFor(() => {
    expect(getButtonByName("Try again", getCatalogViewport())).toBeEnabled();
  });
  click(getButtonByName("Try again", getCatalogViewport()));

  await expect(
    findArtifactAction("launch-second-page.txt"),
  ).resolves.toBeInTheDocument();
  expect(
    getButtonByName("Preview launch-first-page.txt", getCatalogViewport()),
  ).toBeInTheDocument();
  expect(queryButtonByName("Load more", getCatalogViewport())).toBeUndefined();
});
