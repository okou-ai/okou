import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { artifact, getButtonByName } from "./artifact-catalog-test-helpers.ts";

const context = testContext();

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
    "Videos",
    "Websites",
  ]);
});

test.each([
  { id: "003", sidebar: false },
  { id: "004", sidebar: true },
])(
  "artifact-catalog-filters-$id finds the shared conversation as a safe list link with sidebar=$sidebar",
  async ({ sidebar }) => {
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
      featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar },
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
  },
);
