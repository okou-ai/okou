import { fireEvent, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  setupResources,
  resourceButton,
  openResources,
  setupOverflowResources,
} from "./chat-resources-test-helpers.ts";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  artifactSummary,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID as thread,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
  continuitySidebarLink,
} from "./chat-continuity-test-helpers.ts";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { chatArtifactCatalogChangedEvent } from "@okouai/api-contracts/validators/artifact-catalog";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { getButtonByName } from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";

const context = testContext();

async function loadedReport() {
  const panel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  return await within(panel).findByText("report.pdf");
}

async function expectClosed() {
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Artifacts and chats" }),
    ).toBeNull();
  });
  expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
}

test("chat-resources-layout-003 dismisses mobile resources by returning to the composer", async () => {
  await setupResources(context, { desktop: false, open: false });
  expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
  click(resourceButton());
  await loadedReport();
  click(screen.getByRole("textbox", { name: "Message" }));
  await expectClosed();
});

const first = continuityThread(340, 1, "September review");

const second = continuityThread(340, 2, "October review");

function workspace() {
  return installContinuityWorkspace(context, {
    caseId: 340,
    threads: [second, first],
  }).pageOptions;
}

test("chat-resources-navigation-001 replaces the previous report only when the new chat's messages finish loading", async () => {
  const options = workspace();
  const inbox = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ params, query, respond }) => {
      if (params.threadId === second.id) {
        await inbox.promise;
      }
      return respond(200, chatEventRowsResponse([], query));
    },
  );
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    const row =
      query.chatThreadId === first.id
        ? artifactSummary(
            "a8898cb5-b1c9-47eb-aa43-d0583bdc9050",
            "file",
            "first.pdf",
          )
        : artifactSummary(
            "411cc207-b1b2-4346-b0a4-3c9895b941a2",
            "file",
            "second.pdf",
          );
    return respond(200, { artifacts: [row], nextCursor: null });
  });
  await setupPage({ context, ...options, path: "/chats/" + first.id });
  const original = await openResources();
  await within(original).findByText("first.pdf");
  click(continuitySidebarLink(second.id));
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      second.title!,
    );
  });
  expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
  const next = await openResources();
  await within(next).findByRole("status", { name: "Loading artifacts" });
  expect(within(next).queryByText("first.pdf")).toBeNull();
  inbox.resolve();
  await within(next).findByText("second.pdf");
  expect(within(next).queryByText("first.pdf")).toBeNull();
});

test("chat-resources-navigation-003 keeps the edited title focused when the adjacent-chat shortcut is pressed", async () => {
  const options = workspace();
  await setupPage({ context, ...options, path: "/chats/" + first.id });
  const user = userEvent.setup({ delay: null });
  const header = await screen.findByTestId("chat-thread-header-title");
  await waitFor(() => {
    expect(header).toHaveTextContent(first.title!);
  });
  await user.dblClick(header);
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  const title = within(dialog).getByRole("textbox");
  await user.click(title);
  await user.keyboard("{End} notes");
  expect(title).toHaveValue(first.title + " notes");
  expect(title).toHaveFocus();
  await user.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");
  expect(location.pathname).toBe("/chats/" + first.id);
  expect(title).toHaveFocus();
});

test("chat-resources-004 Desktop pointer presents the closed trigger label before opening the artifacts dialog", async () => {
  await setupResources(context, {
    open: false,
    mock() {
      context.mocks.browser.matchMedia((query) => {
        return /(?:min-width|pointer: fine|hover: hover)/.test(query);
      });
    },
  });
  const trigger = resourceButton();
  const user = userEvent.setup({ delay: null });
  await waitFor(() => {
    expect(trigger).toBeEnabled();
  });
  await user.hover(trigger);
  fireEvent.pointerMove(trigger, {
    pointerType: "mouse",
    clientX: 28,
    clientY: 18,
  });
  const label = await waitFor(() => {
    const tip = document.querySelector('[data-slot="tooltip-content"]');
    expect(tip).toBeVisible();
    expect(tip).toHaveTextContent("Artifacts and chats");
    return tip;
  });
  click(trigger);
  await expect(
    screen.findByRole("dialog", { name: "Artifacts and chats" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    return expect(label).not.toBeVisible();
  });
});

async function openDetailsAndGallery(title: string) {
  const panel = await openResources();
  click((await within(panel).findByText(title)).closest("button")!);
  const back = await findFastControl("button", "Back to all artifacts");
  click(back);
  return screen.findByTestId("thread-sidebar-artifacts");
}
test("chat-resources-realtime-005 A catalog publication adds the video to the already open gallery", async () => {
  const site = artifactSummary(
    crypto.randomUUID(),
    "hosted-site",
    "Studio calendar",
  );
  const video = artifactSummary(
    crypto.randomUUID(),
    "file",
    "Launch replay.mp4",
  );
  const items = [site];
  mockArtifactConversation(context, {
    catalog: items,
    chatEvents: [],
    details: new Map([
      [
        site.id,
        {
          ...site,
          kind: "hosted-site",
          site: {
            id: site.id,
            slug: "studio-calendar",
            publicSlug: "studio-calendar",
            url: "https://studio-calendar.sites.vm7.io",
            deploymentVersion: 1,
            entrypoint: "index.html",
            spaFallback: true,
          },
        },
      ],
    ]),
  });
  context.mocks.browser.matchMedia((query) => {
    return /(min-width|hover: hover|pointer: fine)/.test(query);
  });
  await setupPage({ context, path: "/chats/" + thread });
  const gallery = await openDetailsAndGallery(site.title);
  await within(gallery).findByText(site.title);
  const topic = chatArtifactCatalogChangedEvent(thread);
  await waitFor(() => {
    return expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  items.push(video);
  expect(within(gallery).queryByText(video.title)).toBeNull();
  context.mocks.ably.trigger(topic, {});
  await expect(within(gallery).findByText(video.title)).resolves.toBeVisible();
  expect(within(gallery).getByText(site.title)).toBeVisible();
});
test("chat-resources-002 The pending panel shows both resources together and retains them on reopening", async () => {
  const release = context.mocks.deferred<void>();
  let available = true;
  const report = artifactSummary(
    crypto.randomUUID(),
    "file",
    "Field report.pdf",
  );
  const child = {
    threadId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    sourceRunId: crypto.randomUUID(),
    title: "Follow up with design",
    status: "idle" as const,
    createdAt: "2026-06-01T00:00:00.000Z",
  };
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    await release.promise;
    return respond(200, {
      artifacts: available ? [report] : [],
      nextCursor: null,
    });
  });
  context.mocks.api(chatRelationsContract.children, async ({ respond }) => {
    await release.promise;
    return respond(200, { items: available ? [child] : [] });
  });
  context.mocks.browser.matchMedia((query) => {
    return /(min-width|hover: hover|pointer: fine)/.test(query);
  });
  await setupPage({ context, path: "/chats/" + thread });
  const panel = await openResources();
  await expect(
    within(panel).findByRole("status", { name: "Loading artifacts" }),
  ).resolves.toBeVisible();
  release.resolve();
  await expect(within(panel).findByText(report.title)).resolves.toBeVisible();
  expect(within(panel).getByText(child.title)).toBeVisible();
  expect(
    within(panel).queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(panel).not.toBeInTheDocument();
  });
  available = false;
  const returned = within(await openResources());
  await expect(returned.findByText(child.title)).resolves.toBeVisible();
  expect(returned.getByText(report.title)).toBeVisible();
  expect(
    returned.queryByRole("status", { name: "Loading artifacts" }),
  ).toBeNull();
});

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

test("chat-resources-catalog-013 Keyboard activation copies the fourth expanded report and returns focus to its Copy link control", async () => {
  const keyboard = userEvent.setup();
  await setupOverflowResources(context, 4);
  const panel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  click(getButtonByName("Show more", panel));
  await within(panel).findByText("report-4.pdf");
  const copies = queryAllByRoleFast("button", panel).filter((button) => {
    return button.getAttribute("aria-label") === "Copy link";
  });

  copies[3]!.focus();
  await keyboard.keyboard("{Enter}");
  expect(copies[3]).toHaveFocus();
  await waitFor(async () => {
    return await expect(navigator.clipboard.readText()).resolves.toBe(
      "https://files.example.test/report-4.pdf",
    );
  });
});

test("chat-resources-catalog-001 A report without a public source opens its downloaded file from the resource list", async () => {
  await setupResources(context, { sourceUrl: false });
  const panel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  const filename = await within(panel).findByText("report.pdf", {
    exact: true,
  });
  const report = filename.closest("button");
  if (!report) {
    throw new Error("The report filename has no open action");
  }
  await userEvent.hover(report);
  expect(report).toHaveTextContent("report.pdf");
  expect(within(panel).queryByRole("tablist")).toBeNull();
  click(report);
  const sidebar = await screen.findByTestId("artifact-sidebar");
  expect(
    within(sidebar).getByText("report.pdf", { exact: true }),
  ).toBeVisible();
  expect(getButtonByName("Download artifact", sidebar)).toBeEnabled();
  click(getButtonByName("Back to all artifacts", sidebar));
  await waitFor(() => {
    return expect(sidebar).not.toBeInTheDocument();
  });
  await expect(
    screen.findByText("report.pdf", { exact: true }),
  ).resolves.toBeVisible();
});
