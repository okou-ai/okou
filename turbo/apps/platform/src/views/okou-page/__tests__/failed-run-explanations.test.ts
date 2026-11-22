import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const thread = "d7266439-549c-40a1-9264-8aaa8cb7e937";
const diagnostic = "Underlying upstream diagnostic (private detail)";

const examples = [
  ["chat-run-models-001", "unknown", "This run couldn't finish", null, false],
  [
    "chat-run-models-003",
    "guest_root_filesystem_full",
    "This run ran out of space",
    "Try again",
    false,
  ],
  [
    "chat-run-models-005",
    "execution_timeout",
    "Time limit reached",
    "Continue",
    false,
  ],
  [
    "chat-run-models-009",
    "invalid_api_key",
    "Your subscription sign-in needs updating",
    "Open model settings",
    false,
  ],
  [
    "chat-run-models-011",
    "terms_acceptance_required",
    "Claude terms need acceptance",
    "Open Claude",
    false,
  ],
  [
    "chat-run-models-012",
    "account_verification_required",
    "Claude account verification required",
    null,
    false,
  ],
  [
    "chat-run-models-017",
    "provider_rate_limited",
    "Too many model requests right now",
    "Try again",
    true,
  ],
  [
    "chat-run-models-022",
    "codex_access_program_unavailable",
    "Codex access is temporarily unavailable",
    "Try again",
    false,
  ],
  [
    "chat-run-models-030",
    "provider_model_restricted",
    "Selected model isn't available",
    "Try again",
    true,
  ],
  [
    "chat-run-models-040",
    "provider_overloaded",
    "This model is busy right now",
    "Try again",
    true,
  ],
  [
    "chat-run-models-041",
    "provider_insufficient_credits",
    "Your subscription account needs more credit",
    "Open model settings",
    false,
  ],
] as const;

test.each(examples)(
  "%s The conversation explains %s and offers the matching recovery",
  async (_id, reason, title, action, hasPicker) => {
    const raw =
      reason === "provider_insufficient_credits"
        ? "The upstream provider has insufficient balance."
        : reason === "provider_overloaded"
          ? "The model provider returned an error."
          : diagnostic;
    mockChatLifecycle(context, {
      threadId: thread,
      selectedModel: null,
      chatEvents: [
        {
          id: "instruction",
          role: "user",
          runId: "compose",
          content: "Review the document",
          createdAt: "2026-07-01T09:00:00Z",
        },
        {
          id: "failure",
          role: "assistant",
          runId: "compose",
          content: raw,
          runLifecycleEvent: "failed",
          failureReason: reason,
          createdAt: "2026-07-01T09:01:00Z",
        },
      ],
    });
    await setupPage({
      context,
      path: `/chats/${thread}`,
      auth: {
        user: { id: "reader", fullName: "Test Reader" },
        organization: {
          activeOrg: { id: "org_default", name: "Test workspace" },
          memberships: [{ id: "org_default", role: "org:admin" }],
        },
      },
    });
    const heading = await screen.findByText(title, { exact: true });
    const card = heading.closest<HTMLElement>(
      '[data-testid="assistant-error-card-shell"]',
    );
    if (!card) {
      throw new Error(
        "The conversation did not present the failure as a status",
      );
    }
    const q = within(card);
    expect(card).toBeVisible();
    expect(screen.queryByText(raw, { exact: false })).toBeNull();
    const description = q.queryByTestId("assistant-error-description");
    expect(description).toBeVisible();
    expect(description).toHaveTextContent(/\S/);
    const descriptionText =
      reason === "account_verification_required"
        ? /(?:cannot|can.t) receive replies.*Anthropic Verification Portal/is
        : reason === "provider_model_restricted"
          ? /The current model is unavailable\./
          : /\S/;
    expect(description).toHaveTextContent(descriptionText);
    const actions = ["button", "link"].flatMap((role) => {
      return queryAllByRoleFast(role as "button" | "link", card).map(
        (control) => {
          return (
            control.getAttribute("aria-label") ?? control.textContent?.trim()
          );
        },
      );
    });
    const recovery = actions.filter((label) => {
      return label === action;
    });
    expect(action ? recovery : actions).toStrictEqual(action ? [action] : []);
    expect(Boolean(q.queryByRole("combobox"))).toBe(hasPicker);
    expect(q.queryByText("View details")).toBeNull();
    expect(q.queryByText("Upgrade to Pro")).toBeNull();
  },
);
