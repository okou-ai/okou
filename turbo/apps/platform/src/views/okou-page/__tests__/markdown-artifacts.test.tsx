import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { findAction } from "./connector-integrations-test-helpers.ts";

import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";
const context = testContext();

const prefix = "https://cdn.okou.io/artifacts/field-team/run/";
async function conversation(text: string) {
  const chat = createMarkdownChatFixture(context);
  chat.install({
    rows: () => {
      return [
        chat.outputMessage(text, { seqId: 1 }),
        chat.runCompleted({ seqId: 2 }),
      ];
    },
  });
  await setupPage({ context, path: chat.path });
}
test("markdown-artifacts-001 five contexts keep their own labels for the same image", async () => {
  const url = prefix + "report.png";
  await conversation(
    [
      "[Key screenshot](" + url + ")",
      "- [List evidence](" + url + ")",
      "> [Quoted result](" + url + ")",
      "| Review |\n| --- |\n| [Table detail](" + url + ") |",
      "[Reference view][map]",
      "[map]: " + url,
    ].join("\n\n"),
  );
  for (const [label, tag] of [
    ["Key screenshot", "p"],
    ["List evidence", "li"],
    ["Quoted result", "blockquote"],
    ["Table detail", "td"],
    ["Reference view", "p"],
  ]) {
    const link = await findAction("link", label);
    expect(link).toHaveAttribute("href", url);
    expect(link.closest(tag)).toBeInTheDocument();
  }
  click(await findAction("link", "Key screenshot"));
  await waitFor(() => {
    return expect(
      document.querySelector('[role="dialog"] img[src="' + url + '"]'),
    ).toBeVisible();
  });
});
test("markdown-artifacts-003 artifact links advertise their file types while an external image stays a plain link", async () => {
  const samples = [
    ["png", "image"],
    ["mp4", "video"],
    ["html", "website"],
    ["pdf", "document"],
    ["xlsx", "spreadsheet"],
    ["pptx", "presentation"],
    ["mp3", "audio"],
    ["ts", "code"],
    ["zip", "archive"],
    ["bin", "file"],
  ];
  await conversation(
    [
      ...samples.map(([ext, kind]) => {
        return "[" + kind + " sample](" + prefix + "report." + ext + ")";
      }),
      "[Remote diagram](https://outside.example.org/picture.png)",
    ].join("\n\n"),
  );
  for (const [ext, kind] of samples) {
    const link = await findAction("link", kind + " sample");
    expect(link).toHaveAttribute("href", prefix + "report." + ext);
    expect(
      within(link).getByTestId("markdown-artifact-link-icon-" + kind),
    ).toBeVisible();
  }
  const external = await findAction("link", "Remote diagram");
  expect(external.querySelector("svg")).toBeNull();
});
test("markdown-artifacts-004 type icons follow the actual URL despite presentation query parameters and a descriptive title", async () => {
  const deckUrl = prefix + "Q4.PPTX?edition=2",
    site = prefix + "overview.html";
  await conversation(
    "[Field data](" + deckUrl + ") and [Regional workbook](" + site + ")",
  );
  for (const [name, kind, href] of [
    ["Field data", "presentation", deckUrl],
    ["Regional workbook", "website", site],
  ]) {
    const link = await findAction("link", name);
    expect(link).toHaveAttribute("href", href);
    expect(
      within(link).getByTestId("markdown-artifact-link-icon-" + kind),
    ).toBeVisible();
  }
});
test("markdown-artifacts-006 a bare artifact opens its image while a fenced address remains literal", async () => {
  const url = prefix + "rain.png",
    example = "https://guide.example.org/how";
  await conversation([url, "", "```text", example, "```"].join("\n"));
  const code = await waitFor(() => {
    const block = Array.from(document.querySelectorAll("pre,code")).find(
      (n) => {
        return n.textContent?.includes(example);
      },
    );
    if (!block) {
      throw new Error("Missing fenced example");
    }
    return block;
  });
  expect(code.querySelector("a")).toBeNull();
  const link = await findAction("link", url);
  click(link);
  await waitFor(() => {
    return expect(
      document.querySelector('[role="dialog"] img[src="' + url + '"]'),
    ).toBeVisible();
  });
});
