import {
  artifactCatalogContract,
  type ArtifactCatalogCategory,
  type ArtifactCatalogKind,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  getCatalogViewport,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const FIRST_ID = "a0000000-0000-4000-a000-000000000101";
const SECOND_ID = "a0000000-0000-4000-a000-000000000102";
const THIRD_ID = "a0000000-0000-4000-a000-000000000103";
const FOURTH_ID = "a0000000-0000-4000-a000-000000000104";
const SOURCE_THREAD_ID = "b0000000-0000-4000-a000-000000000101";

function setupLibraryPage(path = "/artifacts") {
  return setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.ArtifactLibrary]: true },
  });
}

function categoryTab(name: string): HTMLElement {
  const list = screen.getByRole("tablist", { name: "Type" });
  const tab = queryAllByRoleFast("tab", list).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`Expected category tab "${name}"`);
  }
  return tab;
}

function linkByName(name: string, container: ParentNode): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!link) {
    throw new Error(`Expected link "${name}"`);
  }
  return link;
}

function menuItemByName(name: string, menu: HTMLElement): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!item) {
    throw new Error(`Expected menu item "${name}"`);
  }
  return item;
}

function itemFor(title: string): HTMLElement {
  const item = getButtonByName(
    `Preview ${title}`,
    getCatalogViewport(),
  ).closest<HTMLElement>("article, tr");
  if (!item) {
    throw new Error(`Expected Library item "${title}"`);
  }
  return item;
}

const CATEGORIES = [
  {
    category: "document",
    label: "Documents & PDF",
    title: "launch-report.pdf",
    kind: "file",
  },
  {
    category: "presentation",
    label: "Presentations",
    title: "launch-deck",
    kind: "presentation",
  },
  {
    category: "website",
    label: "Websites",
    title: "launch-website",
    kind: "hosted-site",
  },
  {
    category: "spreadsheet",
    label: "Spreadsheets",
    title: "launch-budget.xlsx",
    kind: "file",
  },
  {
    category: "image",
    label: "Images",
    title: "launch-cover.png",
    kind: "image",
  },
  {
    category: "video",
    label: "Videos",
    title: "launch-demo.mp4",
    kind: "file",
  },
  {
    category: "audio",
    label: "Audio",
    title: "launch-recording.mp3",
    kind: "file",
  },
  {
    category: "other",
    label: "Other",
    title: "launch-assets.zip",
    kind: "file",
  },
] as const satisfies readonly {
  readonly category: ArtifactCatalogCategory;
  readonly label: string;
  readonly title: string;
  readonly kind: ArtifactCatalogKind;
}[];

test("Semantic categories request server-filtered pages while legacy kind URLs and the search query remain usable", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({
      limit: 60,
      ...(query.category ? { category: query.category } : {}),
      ...(query.kind ? { kind: "file" } : {}),
      keyword: "launch",
      direction: "asc",
      ...(query.cursor ? { cursor: "older-images" } : {}),
    });
    if (query.category) {
      const choice = CATEGORIES.find((candidate) => {
        return candidate.category === query.category;
      });
      if (!choice) {
        throw new Error("Expected a supported browsing category");
      }
      return respond(200, {
        artifacts: [
          artifact({
            id: query.cursor ? THIRD_ID : SECOND_ID,
            kind: choice.kind,
            category: choice.category,
            title: query.cursor ? "launch-archived-cover.png" : choice.title,
          }),
        ],
        nextCursor:
          query.category === "image" && !query.cursor ? "older-images" : null,
      });
    }
    return respond(200, {
      artifacts: [
        artifact({
          id: FIRST_ID,
          title: query.kind
            ? "launch-legacy-file.txt"
            : "launch-all-results.txt",
        }),
      ],
      nextCursor: query.kind ? "unloaded-legacy-page" : null,
    });
  });

  await setupLibraryPage("/artifacts?tab=file&q=launch&direction=asc");

  await expect(
    findArtifactAction("launch-legacy-file.txt"),
  ).resolves.toBeInTheDocument();
  for (const choice of CATEGORIES) {
    click(categoryTab(choice.label));

    await expect(findArtifactAction(choice.title)).resolves.toBeInTheDocument();
    expect(categoryTab(choice.label)).toHaveAttribute("aria-selected", "true");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("category")).toBe(choice.category);
    expect(params.has("tab")).toBeFalsy();
    expect(params.get("q")).toBe("launch");
    expect(params.get("direction")).toBe("asc");
  }
  click(categoryTab("Images"));
  await expect(
    findArtifactAction("launch-cover.png"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Load more", getCatalogViewport()));
  await expect(
    findArtifactAction("launch-archived-cover.png"),
  ).resolves.toBeInTheDocument();
  expect(
    getButtonByName("Preview launch-cover.png", getCatalogViewport()),
  ).toBeInTheDocument();
  click(categoryTab("All"));

  await expect(
    findArtifactAction("launch-all-results.txt"),
  ).resolves.toBeInTheDocument();
  expect(categoryTab("All")).toHaveAttribute("aria-selected", "true");
  expect(
    new URLSearchParams(window.location.search).has("category"),
  ).toBeFalsy();
});

test("Category deep links and browser history restore the selected semantic tab and its results", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    expect(query).toStrictEqual({
      limit: 60,
      category: query.category,
      keyword: "launch",
      direction: "asc",
    });
    return respond(200, {
      artifacts: [
        artifact({
          id: FIRST_ID,
          title: `launch-${query.category}.txt`,
          category: query.category,
        }),
      ],
      nextCursor: null,
    });
  });

  await setupLibraryPage("/artifacts?category=document&q=launch&direction=asc");

  await expect(
    findArtifactAction("launch-document.txt"),
  ).resolves.toBeInTheDocument();
  expect(categoryTab("Documents & PDF")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  click(categoryTab("Audio"));

  await expect(
    findArtifactAction("launch-audio.txt"),
  ).resolves.toBeInTheDocument();
  expect(categoryTab("Audio")).toHaveAttribute("aria-selected", "true");
  window.history.back();

  await expect(
    findArtifactAction("launch-document.txt"),
  ).resolves.toBeInTheDocument();
  expect(categoryTab("Documents & PDF")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  window.history.forward();

  await expect(
    findArtifactAction("launch-audio.txt"),
  ).resolves.toBeInTheDocument();
  expect(categoryTab("Audio")).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toHaveValue("launch");
});

test("A chosen list or grid view survives actual sidebar navigation away from and back to the Library", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ id: FIRST_ID, title: "Remembered view.txt" })],
      nextCursor: null,
    });
  });

  await setupLibraryPage();

  await expect(
    findArtifactAction("Remembered view.txt"),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Grid view", getCatalogViewport())).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const view of ["List view", "Grid view"]) {
    click(getButtonByName(view, getCatalogViewport()));
    await waitFor(() => {
      expect(getButtonByName(view, getCatalogViewport())).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(
      screen.getByRole(view === "List view" ? "table" : "article", {
        name: view === "List view" ? undefined : "Remembered view.txt",
      }),
    ).toBeInTheDocument();
    click(
      linkByName(
        "Workflows",
        screen.getByRole("navigation", { name: "Sidebar" }),
      ),
    );

    await expect(
      screen.findByRole("heading", { name: "Workflows", level: 1 }),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/workflows");
    click(
      linkByName(
        "Artifacts",
        screen.getByRole("navigation", { name: "Sidebar" }),
      ),
    );

    await expect(
      findArtifactAction("Remembered view.txt"),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/artifacts");
    await waitFor(() => {
      expect(getButtonByName(view, getCatalogViewport())).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(
      screen.getByRole(view === "List view" ? "table" : "article", {
        name: view === "List view" ? undefined : "Remembered view.txt",
      }),
    ).toBeInTheDocument();
  }
});

test("View preferences belong to the active workspace and are restored after switching back", async () => {
  const alpha = { id: "org_library_alpha", name: "Library Alpha" };
  const beta = { id: "org_library_beta", name: "Library Beta" };
  const memberships = [alpha, beta].map((organization) => {
    return { id: `membership-${organization.id}`, organization };
  });
  const clerk = context.mocks.clerk();
  mockedClerk.setActive.mockImplementation(({ organization }) => {
    const next = [alpha, beta].find((candidate) => {
      return candidate.id === organization;
    });
    if (!next) {
      throw new Error("Expected a Library workspace selection");
    }
    mockedClerk.sessionGetToken.mockResolvedValue(next.id);
    clerk.organization({ activeOrg: next, memberships });
    clerk.stateChanged();
    return Promise.resolve();
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ id: FIRST_ID, title: "Workspace view.txt" })],
      nextCursor: null,
    });
  });

  await setupPage({
    context,
    path: "/artifacts",
    auth: {
      user: { id: "library-reader", fullName: "Library Reader" },
      session: { token: alpha.id },
      organization: { activeOrg: alpha, memberships },
    },
    featureSwitches: { [FeatureSwitchKey.ArtifactLibrary]: true },
  });

  await expect(
    findArtifactAction("Workspace view.txt"),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("List view", getCatalogViewport()));
  await expect(screen.findByRole("table")).resolves.toBeInTheDocument();
  for (const workspace of [beta, alpha]) {
    click(getButtonByName("Switch workspace"));
    const menu = await screen.findByRole("menu");
    click(within(menu).getByText(workspace.name));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
      expect(menu).not.toBeInTheDocument();
      expect(
        within(getButtonByName("Switch workspace")).getByRole("img", {
          name: workspace.name,
        }),
      ).toBeInTheDocument();
    });
    click(
      linkByName(
        "Artifacts",
        screen.getByRole("navigation", { name: "Sidebar" }),
      ),
    );

    const view = workspace.id === beta.id ? "Grid view" : "List view";
    await waitFor(() => {
      expect(window.location.pathname).toBe("/artifacts");
      expect(
        getButtonByName("Preview Workspace view.txt", getCatalogViewport()),
      ).toBeInTheDocument();
      expect(getButtonByName(view, getCatalogViewport())).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByRole(view === "List view" ? "table" : "article", {
          name: view === "List view" ? undefined : "Workspace view.txt",
        }),
      ).toBeInTheDocument();
    });
  }
});

test.each(["Grid view", "List view"] as const)(
  "%s keeps source navigation in the actions menu with separate preview and usable deletion for unavailable sources",
  async (view) => {
    const summary = artifact({
      id: FIRST_ID,
      title: "sourced-report.txt",
      category: "document",
      sourceChatThread: { id: SOURCE_THREAD_ID, title: "Launch planning" },
    });
    const detail: ArtifactDetail = {
      ...artifact({ id: FIRST_ID, title: "sourced-report.txt" }),
      kind: "file",
      file: {
        id: FIRST_ID,
        filename: "sourced-report.txt",
        contentType: "text/plain",
        size: 1024,
        url: "https://artifacts.example.test/sourced-report.txt",
        previewImageUrl: null,
      },
    };
    const unavailable = artifact({
      id: SECOND_ID,
      title: "source-unavailable.txt",
    });
    let deleted = false;
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: deleted ? [summary] : [summary, unavailable],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.delete, ({ params, respond }) => {
      expect(params.artifactId).toBe(SECOND_ID);
      deleted = true;
      return respond(200, { deleted: true });
    });
    context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
      expect(params.artifactId).toBe(FIRST_ID);
      return respond(200, detail);
    });
    context.mocks.http.get(
      "https://artifacts.example.test/sourced-report.txt",
      () => {
        return HttpResponse.text("The source report preview");
      },
    );

    await setupLibraryPage();

    await expect(
      findArtifactAction("sourced-report.txt"),
    ).resolves.toBeInTheDocument();
    click(getButtonByName(view, getCatalogViewport()));
    await expect(
      screen.findByRole(view === "List view" ? "table" : "article", {
        name: view === "List view" ? undefined : "sourced-report.txt",
      }),
    ).resolves.toBeInTheDocument();
    expect(itemFor("sourced-report.txt")).not.toHaveTextContent(
      "Launch planning",
    );
    click(
      getButtonByName(
        "More artifact actions",
        itemFor("source-unavailable.txt"),
      ),
    );
    const unavailableMenu = await screen.findByRole("menu");
    click(menuItemByName("Delete", unavailableMenu));
    const confirmation = await screen.findByRole("dialog", {
      name: "Delete source-unavailable.txt?",
    });
    click(getButtonByName("Delete", confirmation));

    await expect(
      screen.findByText("Artifact deleted"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(confirmation).not.toBeInTheDocument();
      expect(
        within(getCatalogViewport()).queryByText("source-unavailable.txt"),
      ).not.toBeInTheDocument();
    });
    click(
      getButtonByName(
        "Preview sourced-report.txt",
        itemFor("sourced-report.txt"),
      ),
    );
    const sidebar = await screen.findByTestId("artifact-sidebar");
    await expect(
      within(sidebar).findByText("The source report preview"),
    ).resolves.toBeInTheDocument();
    click(getButtonByName("Close artifact", sidebar));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });

    click(
      getButtonByName("More artifact actions", itemFor("sourced-report.txt")),
    );
    const menu = await screen.findByRole("menu");
    const sourceLabel = "Open source chat: Launch planning";
    const source = menuItemByName(sourceLabel, menu);
    expect(source.tagName).toBe("A");
    expect(source).toHaveRole("menuitem");
    expect(source).toHaveAttribute("href", `/chats/${SOURCE_THREAD_ID}`);
    expect(source).toHaveAccessibleName(sourceLabel);
    expect(source).toHaveTextContent(sourceLabel);
    expect(menuItemByName("Delete", menu)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/artifacts");
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    click(source);

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/chats/${SOURCE_THREAD_ID}`);
      expect(menu).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  },
);

test("Local date groups combine accumulated pages in both views without page-local or UTC-date groups", async () => {
  mockNow(new Date("2026-11-26T01:00:00Z"), context.signal);
  context.mocks.data.userPreferences({
    timezone: "America/Los_Angeles",
    locale: "en-US",
  });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: query.cursor
        ? [
            artifact({
              id: SECOND_ID,
              title: "Earlier today.txt",
              createdAt: "2026-11-25T20:00:00Z",
            }),
            artifact({
              id: THIRD_ID,
              title: "Yesterday locally.txt",
              createdAt: "2026-11-25T07:30:00Z",
            }),
            artifact({
              id: FOURTH_ID,
              title: "Older locally.txt",
              createdAt: "2026-11-24T07:30:00Z",
            }),
          ]
        : [
            artifact({
              id: FIRST_ID,
              title: "Latest today.txt",
              createdAt: "2026-11-26T00:30:00Z",
            }),
          ],
      nextCursor: query.cursor ? null : "earlier-dates",
    });
  });

  await setupLibraryPage();

  await expect(
    findArtifactAction("Latest today.txt"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Today" })).toContainElement(
    itemFor("Latest today.txt"),
  );
  click(getButtonByName("Load more", getCatalogViewport()));

  await expect(
    findArtifactAction("Older locally.txt"),
  ).resolves.toBeInTheDocument();
  for (const view of ["Grid view", "List view"]) {
    click(getButtonByName(view, getCatalogViewport()));
    await waitFor(() => {
      expect(getButtonByName(view, getCatalogViewport())).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    const today = screen.getByRole("region", { name: "Today" });
    expect(
      screen.getAllByRole("heading", { name: "Today", level: 2 }),
    ).toHaveLength(1);
    expect(today).toContainElement(itemFor("Latest today.txt"));
    expect(today).toContainElement(itemFor("Earlier today.txt"));
    const yesterday = screen.getByRole("region", { name: "Yesterday" });
    expect(
      within(yesterday).getByRole("heading", { name: "Yesterday", level: 2 }),
    ).toBeInTheDocument();
    expect(yesterday).toContainElement(itemFor("Yesterday locally.txt"));
    const older = screen.getByRole("region", { name: "November 23, 2026" });
    expect(
      within(older).getByRole("heading", {
        name: "November 23, 2026",
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(older).toContainElement(itemFor("Older locally.txt"));
  }
});

test("Missing and broken thumbnails retain meaningful file or media fallbacks and usable preview actions", async () => {
  const brokenUrl = "https://images.example.test/unavailable-cover.png";
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          id: FIRST_ID,
          title: "No cover report.pdf",
          category: "document",
        }),
        artifact({
          id: SECOND_ID,
          title: "Broken image.png",
          kind: "image",
          category: "image",
          thumbnail: { url: brokenUrl },
        }),
      ],
      nextCursor: null,
    });
  });

  await setupLibraryPage();

  await expect(
    findArtifactAction("No cover report.pdf"),
  ).resolves.toBeInTheDocument();
  const document = screen.getByRole("article", { name: "No cover report.pdf" });
  expect(
    within(document).getByTestId("artifact-catalog-file-preview-icon"),
  ).toHaveTextContent("PDF");
  expect(
    getButtonByName("Preview No cover report.pdf", document),
  ).toBeEnabled();
  const image = screen.getByRole("article", { name: "Broken image.png" });
  const thumbnail = await within(image).findByTestId(
    "artifact-catalog-thumbnail",
  );
  expect(thumbnail).toHaveAttribute("src", brokenUrl);
  fireEvent.error(thumbnail);

  await expect(
    within(image).findByRole("img", { name: "Image artifact" }),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Preview Broken image.png", image)).toBeEnabled();
  expect(within(image).getByText("Broken image.png")).toBeInTheDocument();
});
