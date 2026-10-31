import { screen, waitFor } from "@testing-library/react";
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
  [
    "Create a presentation from my topic or files. Ask me about the audience and goal.",
    "Presentation",
  ],
  [
    "Analyze the social profiles or posts I share. Summarize the evidence and recommend next steps.",
    "Report",
  ],
  [
    "Find people or businesses that match my criteria, using public professional sources. Explain why each result fits.",
    "People shortlist",
  ],
  [
    "Create an image from my brief. Ask me about the subject, style, and dimensions.",
    "Image",
  ],
  ["Build a landing page for my consulting business.", "Website"],
  [
    "Research the market for AI assistants and compare competitors.",
    "Research brief",
  ],
  [
    "/gen presentation, create a pitch deck about image generation",
    "Presentation",
  ],
  ["/gen website create a portfolio for a presentation designer", "Website"],
  ["Create a report about image generation trends.", "Report"],
  ["Review our website traffic and recommend improvements.", "Report"],
  ["Research website builders for a small business.", "Research brief"],
  ["Find creators who reach small business owners.", "People shortlist"],
  ["帮我制作一份产品介绍PPT", "Presentation"],
  ["生成一张产品宣传海报", "Image"],
  ["为咨询业务搭建一个网站", "Website"],
  ["寻找适合推广办公工具的达人", "People shortlist"],
  ["调研AI助手的市场和竞争对手", "Research brief"],
  ["分析上周广告效果并提出改进建议", "Report"],
  ["Turn these notes into a 10-slide presentation.", "Presentation"],
  ["把这些资料整理成一份PPT。", "Presentation"],
  ["Don't create a presentation. Create a report with the findings.", "Report"],
  ["Do not create a report; instead create a presentation.", "Presentation"],
  ["不要制作PPT，写一份报告。", "Report"],
  ["Do not return JSON. Create a report.", "Report"],
  ["Find people who can help me design a website.", "People shortlist"],
  ["Find designers to create a presentation.", "People shortlist"],
  ["找能帮我设计网站的人", "People shortlist"],
  [
    "Find people who can design a website. Present the shortlist as a report.",
    "Report",
  ],
])("selects a task-matched default for %s", async (prompt, label) => {
  const input = await openPrompt({ prompt });
  expect(getConnectorAction("button", label)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(input).toHaveValue(prompt);
  // Clearing a default leaves the task intact, and editing does not select again.
  click(getConnectorAction("button", "Clear selection"));
  await waitFor(() => {
    expect(input).toHaveValue(prompt);
    expect(getConnectorAction("button", label)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
  await fill(input, "Create a presentation for the board.");
  expect(getConnectorAction("button", "Presentation")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test.each([
  "What is 1 + 2? Reply with only the number.",
  "What is 1 + 2? Only return the number.",
  "Compare these two records. Return valid JSON.",
  "计算1加2，只回复数字。",
  "Create a report on the campaign. Reply with only one sentence.",
])("preserves an explicit response contract: %s", async (prompt) => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openPrompt({ prompt });
  expect(input).toHaveValue(prompt);
  expect(getConnectorAction("button", "Report")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(prompt);
  });
});

test("an explicit response contract can still be changed with the format controls", async () => {
  const prompt = "What is 1 + 2? Reply with only the number.";
  const input = await openPrompt({ prompt });
  expect(input).toHaveValue(prompt);
  click(getConnectorAction("button", "Report"));
  await waitFor(() => {
    expect(input).toHaveValue(prompt);
    expect(getConnectorAction("button", "Report")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  click(getConnectorAction("button", "Clear selection"));
  await waitFor(() => {
    expect(input).toHaveValue(prompt);
  });
});

test("the default format reaches the first chat without requiring a selection", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const prompt = "Create a presentation for my next board meeting.";
  const input = await openPrompt({ prompt });
  expect(input).toHaveValue(prompt);
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${prompt}\n\n${PRESENTATION}`);
  });
});

test.each([
  ["Presentation", PRESENTATION],
  ["Report", REPORT],
  ["Clear selection", null],
] as const)(
  "a shared prompt separates its format before selecting %s",
  async (choice, instruction) => {
    let sentPrompt: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentPrompt = body.prompt;
      },
    });
    const input = await openPrompt({ prompt: `${TASK}\n\n${PRESENTATION}` });
    expect(input).toHaveValue(TASK);
    expect(getConnectorAction("button", "Presentation")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    click(getConnectorAction("button", choice));
    expect(input).toHaveValue(TASK);
    click(getConnectorAction("button", "Next"));
    await waitFor(() => {
      expect(sentPrompt).toBe(instruction ? `${TASK}\n\n${instruction}` : TASK);
    });
  },
);

test.each([
  { mobile: false, path: ROUTES.onboarding, action: "Next" },
  { mobile: true, path: ROUTES.onboardingSources, action: "Start task" },
])(
  "prompt links keep the task separate and submit only the latest selected format (mobile: $mobile)",
  async ({ mobile, path, action }) => {
    let sentPrompt: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentPrompt = body.prompt;
      },
    });
    const input = await openPrompt({ mobile, path });
    expect(input).toHaveValue(TASK);
    expect(getConnectorAction("button", "Report")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("region", { name: "Connect your work tools" }),
    ).toBeInTheDocument();

    const choices = [
      "Image",
      "Website",
      "Report",
      "Research brief",
      "People shortlist",
      "Presentation",
    ];
    for (const name of choices) {
      click(getConnectorAction("button", name));
      await waitFor(() => {
        expect(input).toHaveValue(TASK);
        expect(getConnectorAction("button", name)).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      });
    }
    click(getConnectorAction("button", "Presentation"));
    expect(input).toHaveValue(TASK);
    click(getConnectorAction("button", action));
    await waitFor(() => {
      expect(sentPrompt).toBe(`${TASK}\n\n${PRESENTATION}`);
    });
  },
);

test("switching and clearing formats preserve the edited task and submit it unchanged", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openPrompt();
  const edited = `Please ${TASK}\n\nUse plain English.`;
  await fill(input, edited);
  for (const choice of ["Presentation", "Report", "Clear selection"]) {
    click(getConnectorAction("button", choice));
    expect(input).toHaveValue(edited);
  }
  expect(getConnectorAction("button", "Report")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(edited);
  });
});

test("editing the task preserves the selected format for submission", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openPrompt();
  click(getConnectorAction("button", "Presentation"));
  const edited = "Draft a customer update.";
  await fill(input, edited);
  expect(input).toHaveValue(edited);
  expect(getConnectorAction("button", "Presentation")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${edited}\n\n${PRESENTATION}`);
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
    expect(input).toHaveValue(prompt);
  });
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${prompt}\n\n${PRESENTATION}`);
  });
});
