import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { composerModelTriggerIn } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

const BEFORE_CUTOFF = "2026-09-21T07:13:24.999Z";
const AT_CUTOFF = "2026-09-21T07:13:25.000Z";
const AFTER_CUTOFF = "2026-09-22T00:00:00.000Z";

function account(createdAt: string | null) {
  return {
    id: "test-user-123",
    fullName: "Test User",
    createdAt: createdAt === null ? null : new Date(createdAt),
  };
}

async function openModels(): Promise<void> {
  const trigger = await waitFor(() => {
    const control = composerModelTriggerIn(document);
    if (!control) {
      throw new Error("Composer model picker not found");
    }
    return control;
  });
  click(trigger);
}

test.each([
  {
    cohort: "existing",
    createdAt: BEFORE_CUTOFF,
    enabled: false,
    visible: true,
  },
  {
    cohort: "at the cutoff",
    createdAt: AT_CUTOFF,
    enabled: false,
    visible: false,
  },
  {
    cohort: "unknown registration",
    createdAt: null,
    enabled: false,
    visible: false,
  },
  {
    cohort: "new with an explicit opt-in",
    createdAt: AFTER_CUTOFF,
    enabled: true,
    visible: true,
  },
])(
  "Video model selection for $cohort paid accounts",
  async ({ createdAt, enabled, visible }) => {
    mockTemplateChat({ tier: "pro" });
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 640px)";
    });
    const user = userEvent.setup();
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      auth: { user: account(createdAt) },
      featureSwitches: { [FeatureSwitchKey.NewUserVideoPickers]: enabled },
    });

    await openModels();
    const models = await screen.findByRole("menu", { name: "Models" });
    await screen.findByRole("menu", { name: "Chat models" });
    await waitFor(() => {
      const categories = queryAllByRoleFast("menuitem", models).map((tab) => {
        return tab.textContent;
      });
      expect(categories).toHaveLength(visible ? 3 : 2);
      expect(
        categories.some((label) => {
          return label?.startsWith("Image");
        }),
      ).toBeTruthy();
      expect(
        categories.some((label) => {
          return label?.startsWith("Video");
        }),
      ).toBe(visible);
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("menu", { name: "Models" }),
      ).not.toBeInTheDocument();
    });
  },
);
