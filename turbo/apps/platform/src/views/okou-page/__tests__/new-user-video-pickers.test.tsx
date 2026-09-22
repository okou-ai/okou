import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, vi } from "vitest";

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
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

const BEFORE_CUTOFF = "2026-09-21T07:13:24.999Z";
const AT_CUTOFF = "2026-09-21T07:13:25.000Z";
const AFTER_CUTOFF = "2026-09-22T00:00:00.000Z";

// Draw a deterministic card order that offers video and avatar entries when
// permitted, so their absence cannot pass just because neither was sampled.
vi.hoisted(() => {
  let sample = 1;
  vi.spyOn(Math, "random").mockImplementation(() => {
    sample += 1;
    return 1 / sample;
  });
});

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
  { cohort: "new", createdAt: AFTER_CUTOFF, enabled: false, visible: false },
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
  "Video entry points for $cohort paid accounts",
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

    const cards = await screen.findByTestId("start-cards");
    await waitFor(() => {
      const templateButtons = queryAllByRoleFast("button", cards).filter(
        (button) => {
          return button.getAttribute("aria-label") === "Browse templates";
        },
      );
      expect(templateButtons).toHaveLength(3);
    });
    for (const title of ["Create a video", "Create an avatar"]) {
      expect(within(cards).queryAllByText(title)).toHaveLength(visible ? 1 : 0);
    }

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

    const dialog = await openTemplatePicker(user);
    const templates = within(dialog).getByRole("tablist", {
      name: "Template categories",
    });
    const categories = queryAllByRoleFast("tab", templates).map((tab) => {
      return tab.textContent;
    });
    expect(categories).toStrictEqual(
      visible
        ? [
            "Presentation",
            "Website",
            "Illustration",
            "Video",
            "Avatar",
            "Workflow",
          ]
        : ["Presentation", "Website", "Illustration", "Workflow"],
    );
  },
);

test("New paid accounts cannot reopen the video catalog through a picker link", async () => {
  mockTemplateChat({ tier: "pro" });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?templatePicker=video`,
    auth: { user: account(AT_CUTOFF) },
  });

  const dialog = await screen.findByRole("dialog");
  const templates = within(dialog).getByRole("tablist", {
    name: "Template categories",
  });
  const tabs = queryAllByRoleFast("tab", templates);
  const selected = tabs.find((tab) => {
    return tab.getAttribute("aria-selected") === "true";
  });
  expect(selected).toHaveTextContent("Presentation");
  expect(
    tabs.map((tab) => {
      return tab.textContent;
    }),
  ).not.toContain("Video");
  expect(
    tabs.map((tab) => {
      return tab.textContent;
    }),
  ).not.toContain("Avatar");
  expect(
    within(dialog).queryByLabelText(/^Select video template/u),
  ).not.toBeInTheDocument();
});

test("New paid accounts see neither video models nor video templates in compact pickers", async () => {
  mockTemplateChat({ tier: "pro" });
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: { user: account(AFTER_CUTOFF) },
  });

  await openModels();
  const models = await screen.findByRole("region", { name: "Models" });
  const labels = queryAllByRoleFast("button", models).map((button) => {
    return button.getAttribute("aria-label");
  });
  expect(
    labels.some((label) => {
      return label?.startsWith("Change Image model,");
    }),
  ).toBeTruthy();
  expect(
    labels.some((label) => {
      return label?.startsWith("Change Video model,");
    }),
  ).toBeFalsy();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Models" }),
    ).not.toBeInTheDocument();
  });

  const dialog = await openTemplatePicker(user);
  click(within(dialog).getByRole("combobox", { name: "Template category" }));
  const options = await screen.findByRole("listbox");
  expect(
    queryAllByRoleFast("option", options).map((option) => {
      return option.textContent;
    }),
  ).toStrictEqual(["Presentation", "Website", "Illustration", "Workflow"]);
});
