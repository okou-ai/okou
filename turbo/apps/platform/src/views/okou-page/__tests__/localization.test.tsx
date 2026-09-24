import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import frFRAgents from "../../../i18n/locales/fr-FR/agents.json";
import frFRAgentsUrl from "../../../i18n/locales/fr-FR/agents.json?url";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function accountMenuTrigger(): HTMLElement | undefined {
  const rail = screen.queryByTestId("labeled-nav-rail");
  if (rail) {
    return within(rail).queryByLabelText("Test User") ?? undefined;
  }
  return queryAllByRoleFast("button").find((button) => {
    return button.textContent?.includes("Test User") ?? false;
  });
}

function fastRoleElement(
  role: "button" | "combobox" | "link" | "option",
  name: string | RegExp,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast(role, container).find((candidate) => {
    const accessibleName =
      candidate.getAttribute("aria-label") ??
      candidate.textContent?.replace(/\s+/gu, " ").trim() ??
      "";
    return typeof name === "string"
      ? accessibleName === name
      : name.test(accessibleName);
  });
  if (!element) {
    throw new Error(`Expected ${role} named ${String(name)}`);
  }
  return element;
}

function waitForFastRole(
  role: "button" | "combobox" | "link" | "option",
  name: string | RegExp,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    return fastRoleElement(role, name, container);
  });
}

async function selectLanguage(
  currentLabel: string,
  optionLabel: string,
): Promise<void> {
  click(await waitForFastRole("combobox", currentLabel));
  click(await waitForFastRole("option", optionLabel));
}

async function openSettingsDialog(label: string): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    const button = accountMenuTrigger();
    if (!button) {
      throw new Error("Expected the account menu trigger");
    }
    return button;
  });
  click(trigger);
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText(label));
  return screen.findByRole("dialog", { name: label });
}

async function closeDialog(dialog: HTMLElement, label: string): Promise<void> {
  click(fastRoleElement("button", label, dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
}

test("French uses local formatting and plurals", async () => {
  const frenchSidebar = Object.fromEntries(
    Object.entries(frFRAgents.sidebar).filter(([key]) => {
      return key !== "pinned";
    }),
  );
  context.mocks.http.get(frFRAgentsUrl, () => {
    return HttpResponse.json({
      ...frFRAgents,
      sidebar: frenchSidebar,
    });
  });
  const runId = "94000000-0000-4000-a000-000000000001";
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: runId,
      sessionId: null,
      agentId: null,
      displayName: null,
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Read two files",
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-01-01T12:00:00.000Z",
      startedAt: "2026-01-01T12:00:00.000Z",
      completedAt: "2026-01-01T12:00:01.200Z",
      artifact: { name: null, version: null },
    });
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "read-one",
                  name: "Read",
                  input: { file_path: "/tmp/one.txt" },
                },
                {
                  type: "tool_use",
                  id: "read-two",
                  name: "Read",
                  input: { file_path: "/tmp/two.txt" },
                },
              ],
            },
          },
          createdAt: "2026-01-01T12:00:00.500Z",
        },
      ],
      hasMore: false,
      nextCursor: null,
      status: "completed",
      lastEventSequence: 1,
    });
  });
  await setupPage({ context, path: `/activities/${runId}` });
  const activityLabels = await screen.findAllByText("Read two files");
  expect(activityLabels).not.toHaveLength(0);

  const settings = await openSettingsDialog("Settings");
  await selectLanguage("Language", "Français");
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", "fr-FR");
    expect(within(settings).getByText("Langue")).toBeVisible();
  });
  await closeDialog(settings, "Fermer");

  expect(screen.getByText("2 fichiers")).toBeVisible();
  expect(screen.getByText("1,2s")).toBeVisible();
});
