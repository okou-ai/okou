import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";
import { getConnectorAction } from "../../okou-page/__tests__/connector-page-test-helpers.ts";

const context = testContext();
const TASK = "Review my latest campaign and recommend three improvements.";
const PRESENTATION =
  "Present the findings as a concise presentation with key results, recommendations, and next steps.";
const REPORT =
  "Present the findings as a structured report with key results, recommendations, and next steps.";

async function openPrompt({
  prompt = TASK,
  mobile = false,
  path = ROUTES.onboarding,
}: {
  readonly prompt?: string;
  readonly mobile?: boolean;
  readonly path?: string;
} = {}): Promise<HTMLTextAreaElement> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.browser.matchMedia((query) => {
    return mobile && query === "(width < 640px)";
  });
  await setupPage({
    context,
    path: `${path}?prompt=${encodeURIComponent(prompt)}`,
    locale: "en-US",
  });
  const input = await screen.findByRole("textbox", {
    name: "Onboarding prompt",
  });
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error("Expected the onboarding prompt textarea");
  }
  return input;
}

test.each([
  { mobile: false, path: ROUTES.onboarding, action: "Next" },
  { mobile: true, path: ROUTES.onboardingSources, action: "Start task" },
])(
  "prompt links offer the main onboarding formats and send the visible prompt (mobile: $mobile)",
  async ({ mobile, path, action }) => {
    let sentPrompt: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentPrompt = body.prompt;
      },
    });
    const input = await openPrompt({ mobile, path });
    expect(input).toHaveValue(TASK);
    expect(
      screen.getByRole("region", { name: "Connect your work tools" }),
    ).toBeInTheDocument();

    const choices = [
      ["Image", "Present the findings as a clear visual summary image."],
      [
        "Website",
        "Present the findings as a shareable webpage with clear sections and takeaways.",
      ],
      ["Report", REPORT],
      [
        "Research brief",
        "Present the findings as a research brief with supporting sources and open questions. Distinguish sourced facts from recommendations.",
      ],
      [
        "People shortlist",
        "Use this task as context to produce a shortlist of relevant people, with their roles, reasons for inclusion, and public professional profile links. If their relevance to the task is unclear, ask a focused question before searching.",
      ],
      ["Presentation", PRESENTATION],
    ] as const;
    for (const [name, instruction] of choices) {
      click(getConnectorAction("button", name));
      await waitFor(() => {
        expect(input).toHaveValue(`${TASK}\n\n${instruction}`);
        expect(getConnectorAction("button", name)).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(input).toHaveFocus();
      });
    }
    click(getConnectorAction("button", "Presentation"));
    expect(input).toHaveValue(`${TASK}\n\n${PRESENTATION}`);
    click(getConnectorAction("button", action));
    await waitFor(() => {
      expect(sentPrompt).toBe(`${TASK}\n\n${PRESENTATION}`);
    });
  },
);

test("switching and clearing a prompt link's format preserve surrounding edits", async () => {
  const input = await openPrompt();
  click(getConnectorAction("button", "Presentation"));
  await waitFor(() => {
    expect(input).toHaveValue(`${TASK}\n\n${PRESENTATION}`);
  });
  const user = userEvent.setup({ delay: null });
  await user.click(input);
  await user.keyboard("{Control>}{Home}{/Control}Please ");
  const wordStart = input.value.indexOf("concise");
  input.setSelectionRange(wordStart, wordStart + "concise".length);
  await user.keyboard("detailed");
  await user.keyboard(
    "{Control>}{End}{/Control}{Enter}{Enter}Use plain English.",
  );
  click(getConnectorAction("button", "Report"));
  await waitFor(() => {
    expect(input).toHaveValue(
      `Please ${TASK}\n\n${REPORT}\n\nUse plain English.`,
    );
  });
  click(getConnectorAction("button", "Clear selection"));
  await waitFor(() => {
    expect(input).toHaveValue(`Please ${TASK}\n\nUse plain English.`);
    expect(getConnectorAction("button", "Report")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(input).toHaveFocus();
  });
});

test("replacing a landing-page prompt clears its old format selection", async () => {
  const input = await openPrompt();
  click(getConnectorAction("button", "Presentation"));
  await waitFor(() => {
    expect(input).toHaveValue(`${TASK}\n\n${PRESENTATION}`);
  });
  await fill(input, "Draft a customer update.");
  await waitFor(() => {
    expect(getConnectorAction("button", "Presentation")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
  click(getConnectorAction("button", "Report"));
  await waitFor(() => {
    expect(input).toHaveValue(`Draft a customer update.\n\n${REPORT}`);
  });
});

test("long landing-page prompts can choose a format without being truncated", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const prompt = `${TASK}\n${"Keep the recommendations actionable. ".repeat(40)}`;
  const input = await openPrompt({ prompt });
  expect(input).toHaveValue(prompt);
  click(getConnectorAction("button", "Presentation"));
  await waitFor(() => {
    expect(input).toHaveValue(`${prompt}\n\n${PRESENTATION}`);
  });
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${prompt}\n\n${PRESENTATION}`);
  });
});
