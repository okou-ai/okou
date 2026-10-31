import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";
import { getConnectorAction } from "../../okou-page/__tests__/connector-page-test-helpers.ts";

const context = testContext();
const TASK = "Review my latest campaign and recommend three improvements.";
const PRESENTATION = "Output format: Okou presentation. Share its link.";
const REPORT = "Output format: Report.";

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
  [
    "Create two flyer designs from my event brief and brand assets. Deliver ready-to-use PNGs with the event details and call to action.",
    "Image",
  ],
  [
    "Create three YouTube thumbnails from my title, summary and visual assets. Deliver 1280×720 PNGs with readable headlines that match the video.",
    "Image",
  ],
  [
    "Create studio, lifestyle and seasonal product images from the photo I upload. Keep the product itself unchanged and deliver ready-to-use image files.",
    "Image",
  ],
  [
    "Turn the spreadsheet I provide into a dashboard for [audience]. Include key metrics, charts and a short summary, and share the finished dashboard.",
    "Website",
  ],
  [
    "Create a wireframe for [page or product] aimed at [audience]. Show desktop and mobile layouts and deliver a viewable prototype.",
    "Website",
  ],
  [
    "Find recruiters for [role or industry] in [location]. Give me a shortlist with professional profile links and reasons each is relevant.",
    "People shortlist",
  ],
  [
    "Find professionals matching [role, industry and location]. Give me a shortlist with profile links, current roles and reasons they fit.",
    "People shortlist",
  ],
  ["Research website builders for a small business.", "Research brief"],
  ["Find creators who reach small business owners.", "People shortlist"],
  ["帮我制作一份产品介绍PPT", "Presentation"],
  ["生成一张产品宣传海报", "Image"],
  ["根据活动信息制作两张宣传传单。", "Image"],
  ["为视频制作三张缩略图。", "Image"],
  ["把这些数据整理成仪表盘。", "Website"],
  ["寻找上海的招聘顾问。", "People shortlist"],
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
  // Task edits do not change the separate format choice.
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
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openPrompt({ prompt });
  click(getConnectorAction("button", "Report"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Report")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(input).toHaveValue(prompt);
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${prompt}\n\n${REPORT}`);
  });
});

test("the default format is added only when starting the first chat", async () => {
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

test("changing a presentation task to Report sends the selected output format", async () => {
  const prompt =
    "Turn my notes into a presentation for the agency owner. Share the finished presentation link.";
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openPrompt({ prompt });
  click(getConnectorAction("button", "Report"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Report")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(input).toHaveValue(prompt);
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${prompt}\n\n${REPORT}`);
  });
});

test.each([
  { mobile: false, path: ROUTES.onboarding, action: "Next" },
  { mobile: true, path: ROUTES.onboardingSources, action: "Start task" },
])(
  "format switches preserve the task and submit only the latest choice (mobile: $mobile)",
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
    for (const name of [
      "Image",
      "Website",
      "Report",
      "Research brief",
      "People shortlist",
      "Presentation",
    ]) {
      click(getConnectorAction("button", name));
      await waitFor(() => {
        expect(getConnectorAction("button", name)).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      });
      expect(input).toHaveValue(TASK);
    }
    click(getConnectorAction("button", "Presentation"));
    click(getConnectorAction("button", action));
    await waitFor(() => {
      expect(sentPrompt).toBe(`${TASK}\n\n${PRESENTATION}`);
    });
  },
);

test("editing, switching and clearing formats preserve the task sent to chat", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openPrompt();
  click(getConnectorAction("button", "Presentation"));
  const edited = `Please ${TASK}\n\nUse plain English.`;
  await fill(input, edited);
  expect(getConnectorAction("button", "Presentation")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(getConnectorAction("button", "Report"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Report")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(input).toHaveValue(edited);
  click(getConnectorAction("button", "Clear selection"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Report")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(input).toHaveFocus();
  });
  expect(input).toHaveValue(edited);
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(edited);
  });
});

test("replacing the task keeps the independently selected format", async () => {
  let sentPrompt: string | undefined;
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      sentPrompt = body.prompt;
    },
  });
  const input = await openPrompt();
  click(getConnectorAction("button", "Presentation"));
  await fill(input, "Draft a customer update.");
  expect(getConnectorAction("button", "Presentation")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(input).toHaveValue("Draft a customer update.");
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`Draft a customer update.\n\n${PRESENTATION}`);
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
  click(getConnectorAction("button", "Presentation"));
  await waitFor(() => {
    expect(getConnectorAction("button", "Presentation")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(input).toHaveValue(prompt);
  click(getConnectorAction("button", "Next"));
  await waitFor(() => {
    expect(sentPrompt).toBe(`${prompt}\n\n${PRESENTATION}`);
  });
});
