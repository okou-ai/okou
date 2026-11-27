import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { imageArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";

const context = testContext();

test("Artifact cards identify their kind and show available previews", async () => {
  const siteCover = "https://static.example.test/covers/launch-site.png";
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          id: "a0000000-0000-4000-a000-000000000c01",
          kind: "file",
          title: "launch-plan.txt",
        }),
        artifact({
          id: "a0000000-0000-4000-a000-000000000c02",
          kind: "hosted-site",
          title: "Launch site",
          thumbnail: { url: siteCover },
        }),
        artifact({
          id: "a0000000-0000-4000-a000-000000000c03",
          kind: "avatar",
          title: "Founder intro",
        }),
      ],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context);

  await expect(screen.findByText("Launch site")).resolves.toBeInTheDocument();
  const site = getButtonByName("Preview Launch site");
  expect(
    within(site).getByRole("img", { name: "Hosted site artifact" }),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(
      within(site).getByTestId("artifact-catalog-thumbnail"),
    ).toHaveAttribute("src", siteCover);
  });
  expect(
    within(getButtonByName("Preview Founder intro")).getByRole("img", {
      name: "Avatar artifact",
    }),
  ).toBeInTheDocument();
  expect(getButtonByName("Preview launch-plan.txt")).toBeEnabled();
});

test("Re-read the catalog when one of the member's artifacts changes", async () => {
  const artifactId = "a0000000-0000-4000-a000-000000000c11";
  const server = { title: "launch-plan.txt" };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ id: artifactId, title: server.title })],
      nextCursor: null,
    });
  });
  await setupArtifactCatalogPage(context);
  await expect(
    screen.findByText("launch-plan.txt"),
  ).resolves.toBeInTheDocument();

  // The member's artifact is updated elsewhere, for example by a Drive sync.
  server.title = "synced-plan.txt";
  context.mocks.ably.trigger("artifact:changed", { artifactId });

  await expect(
    screen.findByText("synced-plan.txt"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("launch-plan.txt")).not.toBeInTheDocument();
});

test("artifact-catalog-filters-002 retains the Files selection and all choices after the empty response", async () => {
  const files = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.list,
    async ({ query, respond }) => {
      if (query.kind === "file") {
        await files.promise;
      }
      return respond(200, { artifacts: [], nextCursor: null });
    },
  );
  await setupPage({ context, path: "/artifacts" });
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  const filters = screen.getByLabelText("Artifact kind filters");
  click(getButtonByName("Show file artifacts", filters));
  await expect(
    screen.findByLabelText("Loading artifacts"),
  ).resolves.toBeInTheDocument();
  files.resolve();
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName("Show file artifacts", filters)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const choices = queryAllByRoleFast("button", filters);
  for (const choice of choices) {
    expect(choice).toBeEnabled();
  }
  expect(
    choices
      .map((item) => {
        return item.textContent?.trim();
      })
      .sort(),
  ).toStrictEqual([
    "Avatars",
    "Files",
    "Images",
    "Presentations",
    "Shared chats",
    "Websites",
  ]);
});

test("artifact-catalog-filters-004 a shared conversation has a safe list link", async () => {
  const threadId = "52000000-0000-4000-8000-000000000025";
  const thread = artifact({
    kind: "shared-thread",
    title: "Field notes",
    sharedThreadId: threadId,
  });
  const deck = artifact({
    kind: "presentation",
    title: "Briefing",
    id: "53000000-0000-4000-8000-000000000025",
  });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: query.kind === "shared-thread" ? [thread] : [deck],
      nextCursor: null,
    });
  });
  await setupPage({
    context,
    path: "/artifacts",
  });
  await expect(screen.findByText(deck.title)).resolves.toBeInTheDocument();
  click(
    getButtonByName(
      "Show shared chat artifacts",
      screen.getByLabelText("Artifact kind filters"),
    ),
  );
  const catalog = within(screen.getByRole("main"));
  const result = await catalog.findByText(thread.title);
  const list = catalog.getByRole("list");
  const row = within(list).getByRole("listitem");
  const link = result.closest("a");
  expect(row).toContainElement(link);
  expect(link).toHaveAttribute("href", "/share/threads/" + threadId);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link?.relList.contains("noopener")).toBeTruthy();
  expect(link?.relList.contains("noreferrer")).toBeTruthy();
});

test("artifact-catalog-pagination-001 closes a later-page deep link back to its Images result", async () => {
  const first = artifact({ title: "Valley", kind: "image" });
  const chosen = artifact({
    title: "Ridge.png",
    kind: "image",
    id: "51000000-0000-4000-8000-000000000025",
  });
  const url = "https://media.example.test/maps/ridge.png";
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.kind !== "image") {
      return respond(200, { artifacts: [], nextCursor: null });
    }
    return query.cursor === "next-survey"
      ? respond(200, { artifacts: [chosen], nextCursor: null })
      : respond(200, { artifacts: [first], nextCursor: "next-survey" });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    return params.artifactId === chosen.id
      ? respond(
          200,
          imageArtifactDetail(chosen, {
            fileId: chosen.id,
            filename: chosen.title,
            url,
          }),
        )
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown survey" },
        });
  });
  const page = "/artifacts?tab=image&artifact=" + chosen.id;
  await setupPage({
    context,
    path: page,
  });
  const preview = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(preview).findByAltText(chosen.title),
  ).resolves.toHaveAttribute("src", url);
  const catalog = screen.getByRole("main", { hidden: true });
  await expect(
    within(catalog).findByText(chosen.title),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/artifacts");
  expect(new URLSearchParams(location.search).get("artifact")).toBe(chosen.id);
  expect(new URLSearchParams(location.search).get("tab")).toBe("image");
  click(getButtonByName("Close artifact", preview));
  await waitFor(() => {
    return expect(
      screen.queryByTestId("artifact-sidebar"),
    ).not.toBeInTheDocument();
  });
  expect(location.pathname + location.search).toBe("/artifacts?tab=image");
  expect(
    within(screen.getByRole("main")).getByText(chosen.title),
  ).toBeVisible();
});
