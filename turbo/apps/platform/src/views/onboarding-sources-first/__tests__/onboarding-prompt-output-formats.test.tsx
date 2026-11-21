import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getAction,
  findAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  documentInstructions,
  receiveFirstChat,
  findSentPrompt,
} from "./onboarding-first-chat-test-helpers.ts";

const context = testContext();
const formats = [
  "Image",
  "Website",
  "Document",
  "Research brief",
  "People shortlist",
  "Presentation",
] as const;
type Format = (typeof formats)[number];
const deck =
  "Present the findings as a concise presentation with key results, recommendations, and next steps.";
const site =
  "Present the findings as a shareable webpage with clear sections and takeaways.";
const people =
  "Use this task as context to produce a shortlist of relevant people, with their roles, reasons for inclusion, and public professional profile links. If their relevance to the task is unclear, ask a focused question before searching.";
const campaign = "Review my latest campaign and recommend three improvements.";
async function openPrompt(
  task: string,
  {
    mobile = false,
    requested,
    multiple = true,
  }: { mobile?: boolean; requested?: string; multiple?: boolean } = {},
) {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.browser.matchMedia((query) => {
    return mobile && query === "(width < 640px)";
  });
  const params = new URLSearchParams({ prompt: task });
  if (requested !== undefined) {
    params.set("outputFormats", requested);
  }
  await setupPage({
    context,
    path:
      (mobile ? "/onboarding/sources" : "/onboarding") +
      "?" +
      params.toString(),
    featureSwitches: { [FeatureSwitchKey.OnboardingMultipleOutputs]: multiple },
  });
  return screen.findByLabelText("Onboarding prompt");
}
function expectSelection(...selected: Format[]) {
  for (const format of formats) {
    expect(getAction("button", format)).toHaveAttribute(
      "aria-pressed",
      String(selected.includes(format)),
    );
  }
}
async function expectChat(
  receipt: ReturnType<typeof receiveFirstChat>,
  expected: string,
) {
  const sent = await receipt;
  expect(sent.prompt).toBe(expected);
  expect(window.location.pathname).toBe("/chats/" + sent.threadId);
  await expect(findSentPrompt(expected)).resolves.toBeVisible();
}

test.each([
  [
    "onboarding-prompt-output-formats-001",
    "Create a presentation for a planning retreat. Ask me about the audience and goal.",
    "Presentation",
  ],
  [
    "onboarding-prompt-output-formats-003",
    "Find matching people or businesses from public professional sources and explain why each fits our ceramics studio.",
    "People shortlist",
  ],
  [
    "onboarding-prompt-output-formats-004",
    "Create an image from my packaging brief. Ask about the subject, style, and dimensions.",
    "Image",
  ],
  [
    "onboarding-prompt-output-formats-005",
    "Build a landing page for my operations consulting business.",
    "Website",
  ],
  [
    "onboarding-prompt-output-formats-007",
    "/gen presentation Make a pitch deck about image generation for publishers.",
    "Presentation",
  ],
  [
    "onboarding-prompt-output-formats-008",
    "/gen website Build a portfolio for a presentation designer.",
    "Website",
  ],
] as const)(
  "%s matches %s to %s and respects clearing it",
  async (_id, task, format) => {
    const editor = await openPrompt(task);
    expect(editor).toHaveValue(task);
    expectSelection(format);
    click(getAction("button", "Clear selection"));
    expect(editor).toHaveValue(task);
    expectSelection();
    const edit = task + " Create a presentation for the review.";
    await fill(editor, edit);
    expect(editor).toHaveValue(edit);
    expectSelection();
  },
);

test.each([
  [
    "onboarding-prompt-output-formats-033",
    "What is 1 + 2? Reply with only the number.",
  ],
  [
    "onboarding-prompt-output-formats-034",
    "What is 1 + 2? Only return the number.",
  ],
  [
    "onboarding-prompt-output-formats-035",
    "Compare the invoice record with the payment record and return valid JSON.",
  ],
  ["onboarding-prompt-output-formats-036", "计算1加2，只回复数字。"],
])("%s sends the exact response constraint in %s", async (_id, task) => {
  const receipt = receiveFirstChat(context);
  await expect(openPrompt(task)).resolves.toHaveValue(task);
  expectSelection();
  click(getAction("button", "Next"));
  await expectChat(receipt, task);
});

test("onboarding-prompt-output-formats-038 opting into Document and clearing it keeps the numeric question", async () => {
  const task = "What is 1 + 2? Reply with only the number.";
  const editor = await openPrompt(task);
  expect(editor).toHaveValue(task);
  expectSelection();
  click(getAction("button", "Document"));
  expectSelection("Document");
  expect(editor).toHaveValue(task);
  click(getAction("button", "Clear selection"));
  expectSelection();
  expect(editor).toHaveValue(task);
});

test.each([
  [
    "onboarding-prompt-output-formats-039",
    "Create a presentation for my next board meeting.",
    "Presentation",
    deck,
  ],
  [
    "onboarding-prompt-output-formats-040",
    campaign,
    "Document",
    documentInstructions,
  ],
] as const)(
  "%s submits %s with the inferred %s instruction",
  async (_id, task, format, instruction) => {
    const receipt = receiveFirstChat(context);
    await expect(openPrompt(task)).resolves.toHaveValue(task);
    expectSelection(format);
    click(getAction("button", "Next"));
    await expectChat(receipt, task + "\n\n" + instruction);
  },
);

test("onboarding-prompt-output-formats-041 selecting the embedded presentation again adds its instruction only once", async () => {
  const task = "Summarize the quarterly hiring outlook.";
  const shared = task + "\n\n" + deck;
  const receipt = receiveFirstChat(context);
  const editor = await openPrompt(shared);
  expect(editor).toHaveValue(task);
  expectSelection("Presentation");
  click(getAction("button", "Presentation"));
  expect(editor).toHaveValue(task);
  expectSelection("Presentation");
  click(getAction("button", "Next"));
  await expectChat(receipt, shared);
});
test("onboarding-prompt-output-formats-043 clearing an embedded presentation sends only its original task", async () => {
  const task = "Describe the renewal forecast for Monday.";
  const receipt = receiveFirstChat(context);
  const editor = await openPrompt(task + "\n\n" + deck);
  expect(editor).toHaveValue(task);
  expectSelection("Presentation");
  click(getAction("button", "Clear selection"));
  expectSelection();
  expect(editor).toHaveValue(task);
  click(getAction("button", "Next"));
  await expectChat(receipt, task);
});

test.each([
  [
    "onboarding-prompt-output-formats-044",
    false,
    "Evaluate the membership renewal campaign.",
    "Next",
  ],
  [
    "onboarding-prompt-output-formats-045",
    true,
    "Evaluate our spring fundraising campaign.",
    "Start task",
  ],
] as const)(
  "%s compares six formats and submits the chosen one (mobile %s)",
  async (_id, mobile, task, button) => {
    const receipt = receiveFirstChat(context);
    const editor = await openPrompt(task, { mobile });
    await screen.findByRole("region", { name: "Connect your work tools" });
    expectSelection("Document");
    for (const format of formats) {
      click(getAction("button", format));
      expectSelection(format);
      expect(editor).toHaveValue(task);
    }
    click(getAction("button", button));
    await expectChat(receipt, task + "\n\n" + deck);
  },
);

test("onboarding-prompt-output-formats-046 switching deliverables and clearing preserves both edited paragraphs", async () => {
  const receipt = receiveFirstChat(context);
  const editor = await openPrompt(campaign);
  const task = "Please " + campaign + "\n\nUse plain English.";
  await fill(editor, task);
  for (const format of ["Presentation", "Document"] as const) {
    click(getAction("button", format));
    expectSelection(format);
    expect(editor).toHaveValue(task);
  }
  click(getAction("button", "Clear selection"));
  expectSelection();
  expect(editor).toHaveValue(task);
  click(getAction("button", "Next"));
  await expectChat(receipt, task);
});
test("onboarding-prompt-output-formats-047 replacing the document task retains the newly selected presentation", async () => {
  const receipt = receiveFirstChat(context);
  const editor = await openPrompt(campaign);
  expectSelection("Document");
  click(getAction("button", "Presentation"));
  const edit = "Draft a customer update.";
  await fill(editor, edit);
  expect(editor).toHaveValue(edit);
  expectSelection("Presentation");
  click(getAction("button", "Next"));
  await expectChat(receipt, edit + "\n\n" + deck);
});
test("onboarding-prompt-output-formats-048 the presentation chat retains all forty actionable recommendations", async () => {
  const receipt = receiveFirstChat(context);
  const task = campaign + " Keep the recommendations actionable.".repeat(40);
  const editor = await openPrompt(task);
  expect(editor).toHaveValue(task);
  click(getAction("button", "Presentation"));
  expectSelection("Presentation");
  expect(editor).toHaveValue(task);
  click(getAction("button", "Next"));
  await expectChat(receipt, task + "\n\n" + deck);
});

test.each([
  [
    "onboarding-prompt-output-formats-049",
    false,
    "Compare local agency partnerships.",
    "Next",
  ],
  [
    "onboarding-prompt-output-formats-050",
    true,
    "Evaluate potential partners for our studio.",
    "Start task",
  ],
] as const)(
  "%s sends the edited agency task with Website then People (mobile %s)",
  async (_id, mobile, task, button) => {
    const receipt = receiveFirstChat(context);
    const editor = await openPrompt(task, {
      mobile,
      requested: "website,people,website,unsupported",
    });
    expect(editor).toHaveValue(task);
    expectSelection("Website", "People shortlist");
    const edit = task + " Focus on US agencies.";
    await fill(editor, edit);
    expect(editor).toHaveValue(edit);
    expectSelection("Website", "People shortlist");
    click(getAction("button", button));
    await expectChat(receipt, [edit, site, people].join("\n\n"));
  },
);

test("onboarding-prompt-output-formats-051 removing Website submits only the remaining People shortlist", async () => {
  const receipt = receiveFirstChat(context);
  const editor = await openPrompt(campaign, { requested: "website,people" });
  expectSelection("Website", "People shortlist");
  click(getAction("button", "Website"));
  expectSelection("People shortlist");
  expect(editor).toHaveValue(campaign);
  click(getAction("button", "Next"));
  await expectChat(receipt, campaign + "\n\n" + people);
});
test("onboarding-prompt-output-formats-052 clearing a two-format link sends its campaign task verbatim", async () => {
  const receipt = receiveFirstChat(context);
  const editor = await openPrompt(campaign, { requested: "website,people" });
  expectSelection("Website", "People shortlist");
  click(getAction("button", "Clear selection"));
  expectSelection();
  expect(editor).toHaveValue(campaign);
  click(getAction("button", "Next"));
  await expectChat(receipt, campaign);
});
test("onboarding-prompt-output-formats-053 unknown and uppercase IDs leave the campaign's Document default", async () => {
  await expect(
    openPrompt(campaign, { requested: "WEBSITE,ledger" }),
  ).resolves.toHaveValue(campaign);
  expectSelection("Document");
});
test("onboarding-prompt-output-formats-054 removing People shortlist makes the website request fit the exact limit", async () => {
  const task = campaign.padEnd(20_000 - site.length - 2, "x");
  await expect(
    openPrompt(task, { requested: "website,people" }),
  ).resolves.toHaveValue(task);
  expectSelection("Website", "People shortlist");
  const next = await findAction("button", "Next");
  expect(next).toBeDisabled();
  click(getAction("button", "People shortlist"));
  expectSelection("Website");
  expect(next).toBeEnabled();
});
test("onboarding-prompt-output-formats-055 sharing a two-format campaign restores the task and each instruction", async () => {
  const shared = [campaign, site, people].join("\n\n");
  const receipt = receiveFirstChat(context);
  await expect(openPrompt(shared)).resolves.toHaveValue(campaign);
  expectSelection("Website", "People shortlist");
  click(getAction("button", "Next"));
  await expectChat(receipt, shared);
});
test("onboarding-prompt-output-formats-056 disabling multiple outputs leaves the task-selected Document", async () => {
  await expect(
    openPrompt(campaign, { multiple: false, requested: "website,people" }),
  ).resolves.toHaveValue(campaign);
  expectSelection("Document");
});
