import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactFavoritesContract,
  type ArtifactFavorite,
  type ArtifactFavoriteDetail,
} from "@okouai/api-contracts/contracts/artifact-favorites";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
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
const OWN_ID = "a0000000-0000-4000-a000-000000000001";
const SHARED_ID = "a0000000-0000-4000-a000-000000000002";
const UNAVAILABLE_ID = "a0000000-0000-4000-a000-000000000003";
const features = Object.freeze({
  [FeatureSwitchKey.ArtifactLibrary]: true,
  [FeatureSwitchKey.Star]: true,
});

function menuItem(name: string, menu: HTMLElement): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected menu item "${name}"`);
  }
  return item;
}

function collection(name: string): HTMLElement {
  return getButtonByName(
    name,
    screen.getByRole("group", { name: "Artifact collections" }),
  );
}

function favorite(
  artifactId: string,
  title: string | null,
  createdAt: string,
): ArtifactFavorite {
  return {
    artifactId,
    createdAt,
    artifact: title ? artifact({ id: artifactId, title }) : null,
  };
}

test.each(["Grid view", "List view"])(
  "Library direct stars toggle favorites in %s without opening a preview or changing collections",
  async (view) => {
    let favorited = false;
    const document = artifact({ id: OWN_ID, title: "Launch plan.txt" });
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, { artifacts: [document], nextCursor: null });
    });
    context.mocks.api(
      artifactFavoritesContract.status,
      ({ query, respond }) => {
        expect(query.artifactIds).toBe(OWN_ID);
        return respond(200, { favorites: { [OWN_ID]: favorited } });
      },
    );
    context.mocks.api(artifactFavoritesContract.create, ({ body, respond }) => {
      expect(body).toStrictEqual({ artifactId: OWN_ID });
      favorited = true;
      return respond(200, { artifactId: OWN_ID, favorited: true });
    });
    context.mocks.api(
      artifactFavoritesContract.remove,
      ({ params, respond }) => {
        expect(params.artifactId).toBe(OWN_ID);
        favorited = false;
        return respond(200, { artifactId: OWN_ID, favorited: false });
      },
    );
    await setupPage({ context, path: "/artifacts", featureSwitches: features });
    await expect(
      findArtifactAction(document.title),
    ).resolves.toBeInTheDocument();
    const viewport = getCatalogViewport();
    if (view === "List view") {
      click(getButtonByName(view, viewport));
    }
    await waitFor(() => {
      expect(getButtonByName(view, viewport)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    for (const [action, result, pressed, message] of [
      [
        "Add to favorites",
        "Remove from favorites",
        "true",
        "Added to favorites",
      ],
      [
        "Remove from favorites",
        "Add to favorites",
        "false",
        "Removed from favorites",
      ],
    ] as const) {
      const star = getButtonByName(action, viewport);
      expect(star).toHaveAttribute(
        "aria-pressed",
        pressed === "true" ? "false" : "true",
      );
      expect(star).toBeEnabled();
      click(star);
      await waitFor(() => {
        const updatedStar = getButtonByName(result, viewport);
        expect(updatedStar).toHaveAttribute("aria-pressed", pressed);
        expect(updatedStar).toBeEnabled();
      });
      await expect(screen.findByText(message)).resolves.toBeInTheDocument();
      expect(getButtonByName("More artifact actions", viewport)).toBeEnabled();
      expect(collection("Your artifacts")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(collection("Favorites")).toHaveAttribute("aria-pressed", "false");
      expect(location.pathname).toBe("/artifacts");
      expect(location.search).toBe("");
      expect(
        screen.queryByRole("complementary", { name: "Artifact" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    }
  },
);

test("Library menus toggle a favorite and only the toast action opens Favorites", async () => {
  let favorited = false;
  const document = artifact({ id: OWN_ID, title: "Launch plan.txt" });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [document], nextCursor: null });
  });
  context.mocks.api(artifactFavoritesContract.status, ({ query, respond }) => {
    expect(query.artifactIds).toBe(OWN_ID);
    return respond(200, { favorites: { [OWN_ID]: favorited } });
  });
  context.mocks.api(artifactFavoritesContract.create, ({ body, respond }) => {
    expect(body).toStrictEqual({ artifactId: OWN_ID });
    favorited = true;
    return respond(200, { artifactId: OWN_ID, favorited: true });
  });
  context.mocks.api(artifactFavoritesContract.remove, ({ params, respond }) => {
    expect(params.artifactId).toBe(OWN_ID);
    favorited = false;
    return respond(200, { artifactId: OWN_ID, favorited: false });
  });
  context.mocks.api(artifactFavoritesContract.list, ({ respond }) => {
    return respond(200, {
      favorites: favorited
        ? [favorite(OWN_ID, document.title, "2026-11-27T10:00:00Z")]
        : [],
      nextCursor: null,
    });
  });
  await setupPage({ context, path: "/artifacts", featureSwitches: features });
  await expect(findArtifactAction(document.title)).resolves.toBeInTheDocument();
  expect(
    getButtonByName("Created Sort ascending", getCatalogViewport()),
  ).toBeEnabled();
  const card = screen.getByRole("article", { name: document.title });
  click(getButtonByName("More artifact actions", card));
  let menu = await screen.findByRole("menu");
  click(menuItem("Add to favorites", menu));
  await expect(
    screen.findByText("Added to favorites"),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/artifacts");
  expect(new URLSearchParams(location.search).get("collection")).toBeNull();
  click(getButtonByName("View favorites"));
  await waitFor(() => {
    expect(collection("Favorites")).toHaveAttribute("aria-pressed", "true");
  });
  await expect(findArtifactAction(document.title)).resolves.toBeInTheDocument();
  expect(getButtonByName("Grid view", getCatalogViewport())).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    within(getCatalogViewport()).queryByText("Favorited"),
  ).not.toBeInTheDocument();
  click(
    getButtonByName(
      "More artifact actions",
      screen.getByRole("article", { name: document.title }),
    ),
  );
  menu = await screen.findByRole("menu");
  click(menuItem("Remove from favorites", menu));
  await expect(
    screen.findByText("Removed from favorites"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("No favorites yet"),
  ).resolves.toBeInTheDocument();
});

test("Favorites keeps own, shared, and unavailable entries in favorite order and removes unavailable entries without target access", async () => {
  let entries = [
    favorite(SHARED_ID, "Shared research.txt", "2026-11-27T12:00:00Z"),
    favorite(UNAVAILABLE_ID, null, "2026-11-27T11:00:00Z"),
    favorite(OWN_ID, "My brief.txt", "2026-11-27T10:00:00Z"),
  ];
  context.mocks.api(artifactFavoritesContract.list, ({ query, respond }) => {
    expect(query.limit).toBe(50);
    return respond(200, { favorites: entries, nextCursor: null });
  });
  context.mocks.api(artifactFavoritesContract.remove, ({ params, respond }) => {
    expect(params.artifactId).toBe(UNAVAILABLE_ID);
    entries = entries.filter((entry) => {
      return entry.artifactId !== params.artifactId;
    });
    return respond(200, { artifactId: params.artifactId, favorited: false });
  });
  await setupPage({
    context,
    path: "/artifacts?collection=favorites",
    featureSwitches: features,
  });
  await expect(
    findArtifactAction("Shared research.txt"),
  ).resolves.toBeInTheDocument();
  expect(
    within(getCatalogViewport())
      .getAllByRole("article")
      .map((card) => {
        return card.getAttribute("aria-label");
      }),
  ).toStrictEqual([
    "Shared research.txt",
    "Unavailable artifact",
    "My brief.txt",
  ]);
  const unavailable = screen.getByRole("article", {
    name: "Unavailable artifact",
  });
  click(getButtonByName("More artifact actions", unavailable));
  const menu = await screen.findByRole("menu");
  expect(
    queryAllByRoleFast("menuitem", menu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual(["Remove from favorites"]);
  click(menuItem("Remove from favorites", menu));
  await expect(
    screen.findByText("Removed from favorites"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      screen.queryByRole("article", { name: "Unavailable artifact" }),
    ).not.toBeInTheDocument();
  });
  click(getButtonByName("List view", getCatalogViewport()));
  await expect(screen.findByRole("table")).resolves.toBeInTheDocument();
  expect(
    within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => {
        return row.textContent;
      }),
  ).toStrictEqual([
    expect.stringContaining("Shared research.txt"),
    expect.stringContaining("My brief.txt"),
  ]);
});

test("A shared favorite uses viewer-authorized detail without Delete, Share, or Drive management", async () => {
  const shared = artifact({
    id: SHARED_ID,
    kind: "image",
    title: "Shared sketch.png",
  });
  context.mocks.api(artifactFavoritesContract.list, ({ respond }) => {
    return respond(200, {
      favorites: [
        {
          artifactId: SHARED_ID,
          createdAt: "2026-11-27T12:00:00Z",
          artifact: shared,
        },
      ],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactFavoritesContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(SHARED_ID);
    const detail: ArtifactFavoriteDetail = {
      id: SHARED_ID,
      title: shared.title,
      thumbnail: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      kind: "image",
      model: null,
      provider: null,
      isOwner: false,
      file: {
        id: SHARED_ID,
        filename: shared.title,
        contentType: "image/png",
        size: 100,
        url: "https://files.example.test/shared-sketch.png",
        previewImageUrl: null,
      },
    };
    return respond(200, detail);
  });
  await setupPage({
    context,
    path: "/artifacts?collection=favorites",
    featureSwitches: features,
  });
  click(await findArtifactAction(shared.title));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByRole("img", { name: shared.title }),
  ).resolves.toBeInTheDocument();
  expect(queryButtonByName("Share artifact", sidebar)).toBeUndefined();
  await waitFor(() => {
    expect(getButtonByName("More artifact actions", sidebar)).toBeEnabled();
  });
  click(getButtonByName("More artifact actions", sidebar));
  let menu = await screen.findByRole("menu");
  expect(
    queryAllByRoleFast("menuitem", menu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual(["Remove from favorites"]);
  click(getButtonByName("More artifact actions", sidebar));
  click(getButtonByName("Download artifact", sidebar));
  menu = await screen.findByRole("menu");
  expect(
    queryAllByRoleFast("menuitem", menu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual(["Download"]);
});

async function openExistingArtifactPage(
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>>,
) {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ title: "Existing deck", kind: "presentation" })],
      nextCursor: null,
    });
  });
  await setupPage({
    context,
    path: "/artifacts?collection=favorites",
    featureSwitches,
  });
  await expect(
    findArtifactAction("Existing deck"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Favorites")).not.toBeInTheDocument();
}

test.each(["Grid view", "List view"])(
  "The existing library keeps search and deletion without direct stars in %s when Star is disabled",
  async (view) => {
    await openExistingArtifactPage({
      [FeatureSwitchKey.ArtifactLibrary]: true,
      [FeatureSwitchKey.Star]: false,
    });
    expect(
      screen.getByRole("searchbox", { name: "Search artifacts" }),
    ).toBeInTheDocument();
    const viewport = getCatalogViewport();
    if (view === "List view") {
      click(getButtonByName(view, viewport));
    }
    await waitFor(() => {
      expect(getButtonByName(view, viewport)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(queryButtonByName("Add to favorites", viewport)).toBeUndefined();
    expect(
      queryButtonByName("Remove from favorites", viewport),
    ).toBeUndefined();
    click(getButtonByName("More artifact actions", viewport));
    const menu = await screen.findByRole("menu");
    expect(
      queryAllByRoleFast("menuitem", menu).map((item) => {
        return item.textContent?.trim();
      }),
    ).toStrictEqual(["Delete"]);
  },
);

test("The existing gallery stays usable when Artifact Library is disabled", async () => {
  await openExistingArtifactPage({
    [FeatureSwitchKey.ArtifactLibrary]: false,
    [FeatureSwitchKey.Star]: true,
  });
  expect(queryButtonByName("More artifact actions")).toBeUndefined();
  expect(queryButtonByName("Add to favorites")).toBeUndefined();
  expect(queryButtonByName("Remove from favorites")).toBeUndefined();
  expect(getButtonByName("Show presentation artifacts")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("Favorites preserves category and search filters and lets an empty filtered page continue with its cursor", async () => {
  context.mocks.api(artifactFavoritesContract.list, ({ query, respond }) => {
    expect(query.category).toBe("image");
    expect(query.keyword).toBe("sketch");
    if (!query.cursor) {
      return respond(200, { favorites: [], nextCursor: "next-readable-page" });
    }
    expect(query.cursor).toBe("next-readable-page");
    return respond(200, {
      favorites: [
        favorite(SHARED_ID, "Matching sketch.png", "2026-11-27T12:00:00Z"),
      ],
      nextCursor: null,
    });
  });
  await setupPage({
    context,
    path: "/artifacts?collection=favorites&category=image&q=sketch",
    featureSwitches: features,
  });
  await expect(
    screen.findByText("Load more to keep browsing your favorites."),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("searchbox", { name: "Search artifacts" }),
  ).toHaveValue("sketch");
  click(getButtonByName("Load more", getCatalogViewport()));
  await expect(
    findArtifactAction("Matching sketch.png"),
  ).resolves.toBeInTheDocument();
});
