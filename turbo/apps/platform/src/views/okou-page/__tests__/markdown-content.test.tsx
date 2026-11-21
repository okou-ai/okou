import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  getAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { completedMarkdownReply } from "./markdown-page-test-helpers.ts";
const context = testContext();
function read(markdown: string) {
  return setupPage({
    context,
    path: completedMarkdownReply(context, markdown),
  });
}

test("markdown-content-001 a quoted instruction preserves its literal markup", async () => {
  await read("> Before signing, inspect <widget>carefully</widget>.");
  const quote = await screen.findByText(/Before signing, inspect/, {
    selector: "blockquote p",
  });
  expect(quote).toBeVisible();
  expect(quote.textContent).toBe(
    "Before signing, inspect <widget>carefully</widget>.",
  );
});

test("markdown-content-002 a completed checklist keeps its formatting and comparison table", async () => {
  await read(
    "**Urgent** *review* ~~obsolete~~\n\n- [x] Signed\n\n| Team | Reviewer |\n|---|---|\n| Finance | Mila |",
  );
  await screen.findByText("Mila", { selector: "td" });
  for (const [selector, word] of [
    ["strong", "Urgent"],
    ["em", "review"],
    ["del", "obsolete"],
  ]) {
    expect(screen.getByText(word, { selector })).toBeVisible();
  }
  const grid = screen.getByRole("table");
  expect(
    Array.from(grid.querySelectorAll("th")).map((cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual(["Team", "Reviewer"]);
  expect(
    Array.from(grid.querySelectorAll("td")).map((cell) => {
      return cell.textContent;
    }),
  ).toStrictEqual(["Finance", "Mila"]);
  expect(screen.getByRole("checkbox")).toBeChecked();
});
test("markdown-content-003 three contact formats preserve their mail recipients", async () => {
  const links = [
    ["ops@example.org", "mailto:ops@example.org"],
    ["Editor", "mailto:ed@example.org"],
    ["Review group", "mailto:ann@example.org,lee@example.org?subject=Draft"],
  ];
  await read(
    "Contact ops@example.org, [Editor](mailto:ed@example.org), or [Review group](mailto:ann@example.org,lee@example.org?subject=Draft).",
  );
  for (const [name, href] of links) {
    const link = await findAction("link", name);
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")?.split(" ")).toStrictEqual(
      expect.arrayContaining(["noopener", "noreferrer"]),
    );
  }
});
test("markdown-content-004 a six-digit color retains the written value next to its swatch", async () => {
  await read("Apply #12ABef to the shipping label.");
  await screen.findByText(/shipping label/);
  const marker = document.querySelector(
    '[data-markdown-color-preview="#12ABef" i]',
  );
  expect(marker).toBeVisible();
  expect(screen.getByText(/shipping label/)).toHaveTextContent("#12ABef");
});
test("markdown-content-006 the image loads alongside separate media links", async () => {
  const poster = "https://cdn.example.org/assets/poster.png",
    clip = "https://cdn.example.org/assets/clip.mp4";
  await read(
    "[Poster file](" +
      poster +
      ") ![Spring poster](" +
      poster +
      ") [Watch clip](" +
      clip +
      ")",
  );
  const img = await screen.findByRole("img", { name: "Spring poster" });
  fireEvent.load(img);
  expect(img).toBeVisible();
  expect(img).toHaveAttribute("src", poster);
  expect(getAction("link", "Watch clip")).toHaveAttribute("href", clip);
  expect(getAction("link", "Poster file")).toHaveAttribute("href", poster);
});
