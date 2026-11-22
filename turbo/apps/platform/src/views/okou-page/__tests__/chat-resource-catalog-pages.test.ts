import { queryFastControl } from "./chat-message-experience-test-helpers.ts";
import { getButtonByName } from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  openResources,
  resourceButton,
  setupOverflowResources,
  setupResources,
} from "./chat-resources-test-helpers.ts";

const context = testContext();

function catalogNames(panel: HTMLElement) {
  return within(panel)
    .getAllByText(/^report-\d+\.pdf$/)
    .map((label) => {
      return label.textContent;
    });
}
function reports(count: number) {
  return Array.from({ length: count }, (_, index) => {
    return `report-${index + 1}.pdf`;
  }).sort();
}

test("chat-resources-001 The empty state replaces the loading state only after the catalog answers", async () => {
  const release = context.mocks.deferred<void>();
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    await release.promise;
    return respond(200, { artifacts: [], nextCursor: null });
  });
  await setupPage({ context, path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}` });
  expect(
    screen.queryByRole("dialog", { name: "Artifacts and chats" }),
  ).toBeNull();
  const panel = await openResources();
  expect(
    within(panel).getByRole("status", { name: "Loading artifacts" }),
  ).toBeVisible();
  expect(within(panel).queryByText("No artifacts yet")).toBeNull();
  release.resolve();
  await within(panel).findByText("No artifacts yet");
  expect(within(panel).queryByRole("status")).toBeNull();
});

test("chat-resources-007 Closing the artifact dialog restores its trigger while transcript links stay in the chat", async () => {
  await setupResources(context);
  const trigger = resourceButton();
  const panel = screen.getByRole("dialog", { name: "Artifacts and chats" });
  expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(
    within(panel).getByRole("heading", { name: "Artifacts" }),
  ).toBeVisible();
  await expect(within(panel).findByText("report.pdf")).resolves.toBeVisible();
  expect(queryFastControl("link", "Current guide")).toBeVisible();
  expect(within(panel).queryByText("Current guide")).toBeNull();
  click(getButtonByName("Close artifacts and chats", panel));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Artifacts and chats" }),
    ).toBeNull();
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("chat-resources-006 Expanding four reports and collapsing them again stays inside the floating list", async () => {
  const { panel } = await setupOverflowResources(context, 4, {
    withLinks: false,
  });
  expect(catalogNames(panel).sort()).toStrictEqual(reports(3));
  click(getButtonByName("Show more", panel));
  expect(catalogNames(panel).sort()).toStrictEqual(reports(4));
  expect(
    screen.queryByRole("heading", { name: "Artifacts", level: 2 }),
  ).toBeNull();
  click(getButtonByName("Collapse", panel));
  expect(catalogNames(panel).sort()).toStrictEqual(reports(3));
  expect(panel).toBeVisible();
});

test("chat-resources-catalog-009 All 125 distinct reports survive pagination, collapse and re-expansion", async () => {
  const { panel } = await setupOverflowResources(context, 125, {
    paginated: true,
    withLinks: false,
  });
  const q = within(panel);
  expect(catalogNames(panel).sort()).toStrictEqual(reports(3));
  for (const size of [60, 120, 125]) {
    click(getButtonByName("Show more", panel));
    await q.findByText(`report-${size}.pdf`);
    expect(catalogNames(panel).sort()).toStrictEqual(reports(size));
    expect(Boolean(queryFastControl("button", "Collapse", panel))).toBe(
      size === 125,
    );
  }
  click(getButtonByName("Collapse", panel));
  expect(catalogNames(panel).sort()).toStrictEqual(reports(3));
  click(getButtonByName("Show more", panel));
  expect(catalogNames(panel).sort()).toStrictEqual(reports(125));
});

test("chat-resources-catalog-010 A pending page keeps the existing 60 titles and focused paging button until the next 60 arrive", async () => {
  const release = context.mocks.deferred<void>();
  const { panel } = await setupOverflowResources(context, 125, {
    withLinks: false,
    mock(catalog) {
      context.mocks.api(
        artifactCatalogContract.list,
        async ({ query, respond }) => {
          const offset = Number(query.cursor ?? 0);
          if (offset > 0) {
            await release.promise;
          }
          return respond(200, {
            artifacts: catalog.slice(offset, offset + 60),
            nextCursor:
              offset + 60 < catalog.length ? String(offset + 60) : null,
          });
        },
      );
    },
  });
  const user = userEvent.setup({ delay: null });
  const button = getButtonByName("Show more", panel);
  await user.click(button);
  await within(panel).findByText("report-60.pdf");
  await user.click(button);
  await waitFor(() => {
    return expect(button).toHaveAttribute("aria-busy", "true");
  });
  expect(button).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Enter}{Enter}");
  expect(catalogNames(panel).sort()).toStrictEqual(reports(60));
  expect(button).toHaveFocus();
  release.resolve();
  await within(panel).findByText("report-120.pdf");
  expect(catalogNames(panel).sort()).toStrictEqual(reports(120));
  expect(button).not.toHaveAttribute("aria-disabled", "true");
  expect(within(panel).queryByText("report-121.pdf")).toBeNull();
});

test("chat-resources-catalog-011 Retry keeps all first-page reports and clears the error when the remaining five arrive", async () => {
  let failing = true;
  const { panel } = await setupOverflowResources(context, 65, {
    withLinks: false,
    mock(catalog) {
      context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
        if (query.cursor && failing) {
          return respond(500, {
            error: { message: "Page unavailable", code: "INTERNAL_ERROR" },
          });
        }
        return respond(
          200,
          query.cursor
            ? { artifacts: catalog.slice(60), nextCursor: null }
            : { artifacts: catalog.slice(0, 60), nextCursor: "60" },
        );
      });
    },
  });
  const q = within(panel);
  click(getButtonByName("Show more", panel));
  await q.findByText("report-60.pdf");
  click(getButtonByName("Show more", panel));
  await q.findByText("Could not load artifacts");
  expect(catalogNames(panel).sort()).toStrictEqual(reports(60));
  const retry = getButtonByName("Show more", panel);
  expect(retry).toBeEnabled();
  failing = false;
  click(retry);
  await q.findByText("report-65.pdf");
  expect(catalogNames(panel).sort()).toStrictEqual(reports(65));
  expect(getButtonByName("Collapse", panel)).toBeVisible();
  expect(q.queryByText("Could not load artifacts")).toBeNull();
});
