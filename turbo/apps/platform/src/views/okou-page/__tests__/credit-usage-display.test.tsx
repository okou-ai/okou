import type { ChatEventUsagePayload } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

function usageButton(total: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === `Credit usage ${total}`;
  });
  if (!button) {
    throw new Error(`Credit usage ${total} button not found`);
  }
  return button;
}

function setupUsageChat(
  threadId: string,
  runId: string,
  usage: ChatEventUsagePayload,
): Promise<void> {
  mockChatLifecycle(context, {
    threadId,
    chatEvents: [
      {
        id: `${runId}-user`,
        role: "user",
        content: "Show this run's credit usage",
        runId,
        createdAt: "2026-08-14T12:00:00.000Z",
      },
      {
        id: `${runId}-assistant`,
        role: "assistant",
        content: "The usage summary is ready.",
        runId,
        createdAt: "2026-08-14T12:00:01.000Z",
      },
      {
        id: `${runId}-usage`,
        role: "assistant",
        content: null,
        runId,
        usage,
        createdAt: "2026-08-14T12:00:02.000Z",
      },
    ],
  });
  return setupPage({
    context,
    path: `/chats/${threadId}`,
    locale: "en-US",
  });
}

async function openUsage(total: string): Promise<void> {
  await waitFor(() => {
    expect(usageButton(total)).toBeInTheDocument();
  });
  click(usageButton(total));
  await screen.findByText("Credit usage");
}

test("Credit usage preserves unknown historical model identifiers", async () => {
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000803",
    "run-credit-historical-model",
    {
      version: 1,
      totalCredits: 40,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "model/acme/vision-pro/tokens.output",
          credits: 40,
          providers: [{ provider: "acme", credits: 40 }],
        },
      ],
    },
  );

  await openUsage("40");

  expect(screen.getByText("acme/vision-pro")).toBeInTheDocument();
  expect(screen.queryByText("Acme Vision Pro")).not.toBeInTheDocument();
});

test("Credit usage formats unknown image-provider names for people to read", async () => {
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000804",
    "run-credit-image-provider",
    {
      version: 1,
      totalCredits: 50,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "image/acme/vision-pro/output_images",
          credits: 50,
          providers: [{ provider: "acme", credits: 50 }],
        },
      ],
    },
  );

  await openUsage("50");

  expect(screen.getByText("Acme Vision Pro")).toBeInTheDocument();
  expect(screen.queryByText("acme/vision/pro")).not.toBeInTheDocument();
});

test("Credit usage merges every Social Search vendor into one row and preserves model totals", async () => {
  await setupUsageChat(
    "b0000000-0000-4000-a000-000000000805",
    "run-credit-social-platforms",
    {
      version: 1,
      totalCredits: 102,
      settledAt: "2026-08-14T12:00:02.000Z",
      breakdown: [
        {
          kind: "connector",
          credits: 12,
          providers: [{ provider: "x", credits: 12 }],
        },
        {
          kind: "social",
          credits: 51,
          providers: [
            { provider: "monid/x", credits: 3 },
            { provider: "monid/instagram", credits: 7 },
            { provider: "monid/tiktok", credits: 11 },
            { provider: "monid/youtube", credits: 13 },
            { provider: "monid/facebook", credits: 17 },
          ],
        },
        {
          kind: "social/monid/x/provider_cost_usd_micros",
          credits: 5,
          providers: [{ provider: "monid/x", credits: 5 }],
        },
        {
          kind: "model/gpt-5.6-sol/tokens.input",
          credits: 2,
          providers: [{ provider: "openai", credits: 2 }],
        },
        {
          kind: "model/gpt-5.6-sol/tokens.output",
          credits: 4,
          providers: [{ provider: "openai", credits: 4 }],
        },
        {
          kind: "model/gpt-5.6-luna/tokens.output",
          credits: 9,
          providers: [{ provider: "openai", credits: 9 }],
        },
        {
          kind: "social",
          credits: 19,
          providers: [{ provider: "socialkit", credits: 19 }],
        },
      ],
    },
  );

  await openUsage("102");

  const details = screen.getByRole("dialog");
  for (const [label, credits] of [
    // The X connector stays its own row; only kind "social" collapses.
    ["X", "12"],
    ["Social Search", "75"],
    ["GPT 5.6 Sol", "6"],
    ["GPT 5.6 Luna", "9"],
  ]) {
    expect(within(details).getByText(label).parentElement).toHaveTextContent(
      `${label}${credits}`,
    );
  }
  expect(within(details).getByText("102")).toBeInTheDocument();
  expect(within(details).queryByText(/monid/iu)).not.toBeInTheDocument();
  expect(within(details).queryByText(/socialkit/iu)).not.toBeInTheDocument();
  for (const platform of ["Instagram", "TikTok", "YouTube", "Facebook"]) {
    expect(within(details).queryByText(platform)).not.toBeInTheDocument();
  }
});
