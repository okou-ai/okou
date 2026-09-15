import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();

function installMessage(content: string) {
  const chat = createMarkdownChatFixture(context);
  const rows = [
    chat.outputMessage(content, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  return chat;
}

test.each([
  {
    timezone: "America/Los_Angeles",
    summer: "Sep 9, 2026, 12:00:00 AM PDT",
    winter: "Jan 8, 2026, 11:00:00 PM PST",
  },
  {
    timezone: "Asia/Kathmandu",
    summer: "Sep 9, 2026, 12:45:00 PM GMT+5:45",
    winter: "Jan 9, 2026, 12:45:00 PM GMT+5:45",
  },
  {
    timezone: "UTC",
    summer: "Sep 9, 2026, 7:00:00 AM UTC",
    winter: "Jan 9, 2026, 7:00:00 AM UTC",
  },
])(
  "Markdown times use the browser timezone $timezone for each instant",
  async ({ timezone, summer, winter }) => {
    context.mocks.browser.language("en-US");
    context.mocks.data.userPreferences({ timezone: "Pacific/Auckland" });
    const chat = installMessage(
      'Summer meeting: **<time datetime="2026-09-09T15:00:00+08:00">source summer time</time>**. ' +
        'Winter meeting: <time datetime="2026-01-09T07:00:00Z">source winter time</time>.',
    );

    await setupPage({
      context,
      path: chat.path,
      host: "app.okou.ai",
      locale: "en-US",
      env: { TZ: timezone },
    });

    const summerTime = await screen.findByText(summer);
    expect(summerTime.tagName).toBe("TIME");
    expect(summerTime).toHaveAttribute("datetime", "2026-09-09T15:00:00+08:00");
    expect(summerTime.closest("strong")).not.toBeNull();
    expect(summerTime.closest("p")).toHaveTextContent(
      `Summer meeting: ${summer}. Winter meeting: ${winter}.`,
    );
    expect(screen.getByText(winter)).toHaveAttribute(
      "datetime",
      "2026-01-09T07:00:00Z",
    );
  },
);

test.each([
  {
    scenario: "British English uses day-first dates and a 24-hour clock",
    languages: ["en-GB", "en-US"],
    expected: "9 Sept 2026, 15:00:00 GMT+8",
  },
  {
    scenario: "Chinese works even when the application UI is in English",
    languages: ["zh-CN", "en-US"],
    expected: "2026年9月9日 GMT+8 15:00:00",
  },
  {
    scenario: "the single browser language is used when its list is empty",
    languages: [],
    expected: "9 Sept 2026, 15:00:00 GMT+8",
  },
])("Markdown times follow browser locale: $scenario", async (scenario) => {
  context.mocks.browser.language("en-GB");
  context.mocks.browser.languages(scenario.languages);
  const chat = installMessage(
    '<time datetime="2026-09-09T15:00:00+08:00">source time</time>',
  );

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    locale: "en-US",
    env: { TZ: "Asia/Shanghai" },
  });

  const time = await screen.findByText(scenario.expected);
  expect(time).toBeVisible();
  expect(time).toHaveAttribute("datetime", "2026-09-09T15:00:00+08:00");
  expect(document.documentElement).toHaveAttribute("lang", "en-US");
});

test("A time tag can render from datetime without a text label", async () => {
  context.mocks.browser.language("en-US");
  const chat = installMessage(
    '<time datetime="2026-09-09T07:00:00.123Z"></time>',
  );
  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    locale: "en-US",
    env: { TZ: "Asia/Shanghai" },
  });

  const time = await screen.findByText("Sep 9, 2026, 3:00:00 PM GMT+8");
  expect(time).toHaveAttribute("datetime", "2026-09-09T07:00:00.123Z");
});

test("Missing, invalid, and timezone-free datetimes retain their original text", async () => {
  const chat = installMessage(
    [
      "<time>No datetime provided</time>",
      '<time datetime="">Empty datetime</time>',
      '<time datetime="not-a-date">Invalid datetime</time>',
      '<time datetime="2026-02-30T07:00:00Z">Invalid calendar date</time>',
      '<time datetime="2026-09-09">Date only</time>',
      '<time datetime="2026-09-09T07:00:00">No timezone offset</time>',
      '<time datetime="PT1H">Duration</time>',
    ].join("\n\n"),
  );
  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    env: { TZ: "America/Los_Angeles" },
  });

  await expect(
    screen.findByText("No datetime provided"),
  ).resolves.toBeVisible();
  for (const text of [
    "Empty datetime",
    "Invalid datetime",
    "Invalid calendar date",
    "Date only",
    "No timezone offset",
    "Duration",
  ]) {
    expect(screen.getByText(text)).toBeVisible();
  }
});

test("Time tags in inline and fenced code remain literal code", async () => {
  context.mocks.browser.language("en-US");
  const inline =
    '<time datetime="2026-09-09T15:00:00+08:00">inline example</time>';
  const fenced =
    '<time datetime="2026-09-09T15:00:00+08:00">fenced example</time>';
  const chat = installMessage(
    [
      `Inline code: \`${inline}\``,
      "",
      "```html",
      fenced,
      "```",
      "",
      '<time datetime="2026-09-09T15:00:00+08:00">actual meeting</time>',
    ].join("\n"),
  );
  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    locale: "en-US",
    env: { TZ: "America/Los_Angeles" },
  });

  const time = await screen.findByText("Sep 9, 2026, 12:00:00 AM PDT");
  const frame = time.closest(".wmde-markdown");
  expect(frame).not.toBeNull();
  expect(frame?.querySelectorAll("time")).toHaveLength(1);
  expect(screen.getByText(inline).closest("code")).not.toBeNull();
  expect(frame?.querySelector("pre code.language-html")?.textContent).toBe(
    `${fenced}\n`,
  );
});
