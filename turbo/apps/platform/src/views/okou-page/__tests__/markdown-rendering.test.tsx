import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  getAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedMarkdownReply,
  createMarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";

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

test("Long bare URLs show a short label and retain their destination", async () => {
  const short = "https://example.com/".padEnd(80, "a");
  const long = short + "?callback=" + "b".repeat(200);
  const name = "Read the full document";
  await read([short, long, `[${name}](${long})`].join("\n\n"));

  const clipped = await findAction("link", long.slice(0, 77) + "...");
  expect(clipped).toHaveAttribute("href", long);
  expect(getAction("link", short)).toHaveAttribute("href", short);
  expect(getAction("link", name)).toHaveAttribute("href", long);
});

test("markdown-interactions-001 copying the second snippet leaves the first copy action untouched", async () => {
  const sample = 'const second = "beta";';
  const clipboard = context.mocks.browser.clipboardWriteText();
  const path = completedMarkdownReply(
    context,
    [
      "~~~typescript",
      'const first = "alpha";',
      "~~~",
      "",
      "~~~typescript",
      sample,
      "~~~",
    ].join("\n"),
  );
  await setupPage({ context, path });
  const buttons = await screen.findAllByLabelText("Copy to clipboard");
  expect(buttons).toHaveLength(2);
  click(buttons[1]);
  await waitFor(() => {
    return expect(buttons[1]).toHaveAccessibleName("Copied");
  });
  expect(buttons[0]).toHaveAccessibleName("Copy to clipboard");
  expect(clipboard.writes).toStrictEqual([sample + "\n"]);
});
test("markdown-interactions-003 run completion preserves one copy of each rich message element", async () => {
  const chat = createMarkdownChatFixture(context),
    runId = crypto.randomUUID();
  const text = [
    "# Ledger digest",
    "",
    "**Signed** and *reviewed*",
    "",
    "~~~typescript",
    "const total = 2;",
    "~~~",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> Quoted sum",
    "",
    "- open item",
    "",
    String.raw`\(x+2\) [Record][ref] ![Stable image](https://cdn.example.org/stable.png) <trial>literal</trial>`,
    "",
    "[ref]: https://example.org/record",
  ].join("\n");
  const rows = [
    chat.inputPrompt("Audit the digest", { seqId: 1, runId }),
    chat.outputMessage(text, { seqId: 2, runId }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  await setupPage({ context, path: chat.path });
  await screen.findByRole("heading", { name: "Ledger digest" });
  const checkDigest = () => {
    const reply = screen
      .getByRole("heading", { name: "Ledger digest" })
      .closest('[data-role="assistant"]');
    if (!reply) {
      throw new Error("Missing digest response");
    }
    for (const selector of [
      "h1",
      "strong",
      "em",
      "pre code",
      "table",
      "blockquote",
      "ul",
      'img[alt="Stable image"]',
    ]) {
      expect(reply.querySelectorAll(selector)).toHaveLength(1);
    }
    expect(reply.querySelector("annotation")?.textContent).toBe("x+2");
    expect(
      reply.querySelector('a[href="https://example.org/record"]'),
    ).toHaveTextContent("Record");
    expect(reply).toHaveTextContent("<trial>literal</trial>");
  };
  await screen.findByText("x+2", { selector: "annotation" });
  checkDigest();
  await expect(screen.findByLabelText("Stop")).resolves.toBeVisible();
  rows.push(chat.runCompleted({ seqId: 3, runId }));
  context.mocks.ably.trigger(chat.realtimeTopic);
  await waitFor(() => {
    return expect(screen.queryByLabelText("Stop")).toBeNull();
  });
  checkDigest();
});
