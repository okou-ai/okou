import { expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { assistantRow, conversation } from "./attachment-preview-boundaries.ts";
const context = testContext();
function useLosAngelesBrowser() {
  vi.stubEnv("TZ", "America/Los_Angeles");
  context.signal.addEventListener(
    "abort",
    () => {
      return vi.unstubAllEnvs();
    },
    {
      once: true,
    },
  );
}
test("markdown-time-001 seasonal timestamps use the browser zone while preserving their original instants and emphasis", async () => {
  useLosAngelesBrowser();
  context.mocks.data.userPreferences({ timezone: "Pacific/Auckland" });
  const summer = "2026-09-09T15:00:00+08:00",
    winter = "2026-01-09T07:00:00Z";
  await conversation(context, {
    chatEvents: [
      assistantRow(
        'Summer **<time datetime="' +
          summer +
          '">depart</time>** and winter <time datetime="' +
          winter +
          '">arrive</time>.',
      ),
    ],
  });
  const departure = await screen.findByText("Sep 9, 2026, 12:00:00 AM PDT", {
    selector: "time",
  });
  expect(departure).toHaveAttribute("datetime", summer);
  expect(departure.closest("strong")).toBeVisible();
  expect(
    screen.getByText("Jan 8, 2026, 11:00:00 PM PST", { selector: "time" }),
  ).toHaveAttribute("datetime", winter);
});
test("markdown-time-003 non-instant time tags retain their authored labels", async () => {
  useLosAngelesBrowser();
  const inputs = [
    [undefined, "No datetime provided"],
    ["", "Empty datetime"],
    ["not-a-date", "Invalid datetime"],
    ["2026-02-30T00:00:00Z", "Invalid calendar date"],
    ["2026-11-21", "Date only"],
    ["2026-11-21T09:30:00", "No timezone offset"],
    ["PT30M", "Duration"],
  ] as const;
  const message = inputs
    .map(([value, label]) => {
      return (
        "<time" +
        (value === undefined ? "" : ' datetime="' + value + '"') +
        ">" +
        label +
        "</time>"
      );
    })
    .join(" / ");
  await conversation(context, { chatEvents: [assistantRow(message)] });
  for (const [, label] of inputs) {
    await expect(
      screen.findByText(label, { selector: "time" }),
    ).resolves.toBeVisible();
  }
});
