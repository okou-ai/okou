import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { previewGuest } from "./sandbox-file-preview-test-helpers.ts";
import {
  filesButton,
  openFiles,
  setupFilesPage,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

async function openJson(source: string) {
  await setupFilesPage(context, {
    jsonTree: true,
    handler: previewGuest({ "data.json": new TextEncoder().encode(source) }),
  });
  await openFiles();
  await screen.findByText("data.json");
  click(filesButton("Preview data.json"));
  const dialog = await screen.findByRole("dialog", { name: "data.json" });
  await within(dialog).findByTestId("json-preview");
  return dialog;
}

test("Files JSON nodes expand with the keyboard and copy exact source ranges", async () => {
  const user = userEvent.setup();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const nested = '{"name":"你好","payload":"<img src=x>"}';
  const source = `{"profile":${nested},"id":9223372036854775807,"mode":1,"mode":2,"large":1e309,"negative":-0}`;
  const dialog = await openJson(source);
  expect(within(dialog).queryByText('"你好"')).not.toBeInTheDocument();
  expect(within(dialog).getAllByText('"mode"')).toHaveLength(2);
  expect(within(dialog).getByText("9223372036854775807")).toBeInTheDocument();
  expect(within(dialog).getByText("1e309")).toBeInTheDocument();
  expect(within(dialog).getByText("-0")).toBeInTheDocument();
  const expand = filesButton('Expand "profile"', dialog);
  expand.focus();
  await user.keyboard("{Enter}");
  expect(filesButton('Collapse "profile"', dialog)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(within(dialog).getByText('"你好"')).toBeInTheDocument();
  expect(dialog.querySelector("img, script, iframe")).toBeNull();
  click(filesButton('Copy "profile"', dialog));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([nested]);
  });
  click(filesButton("Collapse all", dialog));
  expect(within(dialog).queryByText('"profile"')).not.toBeInTheDocument();
  click(filesButton("Copy preview source", dialog));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([nested, source]);
  });
  click(filesButton("Source", dialog));
  expect(dialog.querySelector("pre")?.textContent).toBe(source);
  expect(filesButton("Download", dialog)).toBeEnabled();
});

test("A valid prefix of a longer Guest file stays incomplete source", async () => {
  const prefix = '{"ok":true}'.padEnd(65_536, " ");
  const dialog = await openJson(`${prefix} trailing bytes`);
  const tree = within(dialog).getByTestId("json-preview");
  expect(filesButton("Tree", dialog)).toBeDisabled();
  expect(within(tree).getByRole("status")).toHaveTextContent(
    "Only part of this file is loaded",
  );
  expect(dialog.querySelector("pre")?.textContent).toBe(prefix);
  expect(filesButton("Download", dialog)).toBeEnabled();
});

test.each([
  { name: "invalid", source: '{"x":1,}', message: "This is not valid JSON" },
  {
    name: "deep",
    source: "[".repeat(65) + "0" + "]".repeat(65),
    message: "too complex",
  },
  {
    name: "wide",
    source: "[" + "0,".repeat(8200) + "0]",
    message: "too complex",
  },
])(
  "A $name JSON file keeps its original downloadable source",
  async ({ source, message }) => {
    const dialog = await openJson(source);
    expect(filesButton("Tree", dialog)).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(message);
    expect(dialog.querySelector("pre")?.textContent).toBe(source);
    expect(filesButton("Download", dialog)).toBeEnabled();
  },
);

test.each(["{}", "[]", "null"])(
  "The %s root has a readable tree and source",
  async (source) => {
    const dialog = await openJson(source);
    expect(filesButton("Tree", dialog)).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText(source)).toBeInTheDocument();
    click(filesButton("Source", dialog));
    expect(dialog.querySelector("pre")?.textContent).toBe(source);
  },
);

test("Large arrays reveal bounded pages while source and copy retain every loaded item", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const source = JSON.stringify(
    Array.from({ length: 600 }, (_, index) => {
      return index;
    }),
  );
  const dialog = await openJson(source);
  expect(within(dialog).getByText("[49]")).toBeInTheDocument();
  expect(within(dialog).queryByText("[50]")).not.toBeInTheDocument();
  for (let page = 0; page < 10; page++) {
    click(filesButton("Show more", dialog));
  }
  expect(within(dialog).getByText("[510]")).toBeInTheDocument();
  expect(within(dialog).queryByText("[511]")).not.toBeInTheDocument();
  expect(within(dialog).getByRole("status")).toHaveTextContent(
    "Some nodes are hidden",
  );
  click(filesButton("Copy preview source", dialog));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([source]);
  });
  click(filesButton("Source", dialog));
  expect(dialog.querySelector("pre")?.textContent).toBe(source);
});

test("Nested JSON pagination retains following siblings and keyboard focus", async () => {
  const user = userEvent.setup();
  const dialog = await openJson(
    JSON.stringify({
      before: "first marker",
      items: Array.from({ length: 120 }, (_, index) => {
        return index;
      }),
      after: "last marker",
    }),
  );
  click(filesButton('Expand "items"', dialog));
  expect(within(dialog).getByText("[49]")).toBeInTheDocument();
  expect(within(dialog).queryByText("[50]")).not.toBeInTheDocument();
  const more = filesButton("Show more", dialog);
  more.focus();
  await user.keyboard("{Enter}");
  expect(within(dialog).getByText("[99]")).toBeInTheDocument();
  expect(within(dialog).queryByText("[100]")).not.toBeInTheDocument();
  expect(filesButton("Show more", dialog)).toHaveFocus();
  await user.keyboard("{Enter}");
  const last = within(dialog).getByText("[119]");
  expect(last).toBeInTheDocument();
  const sibling = within(dialog).getByText('"last marker"');
  expect(
    last.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(within(dialog).getByText('"first marker"')).toBeInTheDocument();
  const allShown = filesButton("All items shown", dialog);
  expect(allShown).toHaveAttribute("aria-disabled", "true");
  expect(allShown).toHaveFocus();
});

test("Browsing another JSON file restores filename focus and keeps each source isolated", async () => {
  const user = userEvent.setup();
  await setupFilesPage(context, {
    jsonTree: true,
    handler: previewGuest({
      "first.json": new TextEncoder().encode('{"items":["first document"]}'),
      "second.json": new TextEncoder().encode('{"items":["second document"]}'),
    }),
  });
  await openFiles();
  await screen.findByText("first.json");
  const first = filesButton("Preview first.json");
  first.focus();
  await user.keyboard("{Enter}");
  const firstDialog = await screen.findByRole("dialog", { name: "first.json" });
  await within(firstDialog).findByTestId("json-preview");
  click(filesButton('Expand "items"', firstDialog));
  expect(within(firstDialog).getByText('"first document"')).toBeInTheDocument();
  click(filesButton("Source", firstDialog));
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(first).toHaveFocus();
  });
  click(filesButton("Preview second.json"));
  const second = await screen.findByRole("dialog", { name: "second.json" });
  await within(second).findByTestId("json-preview");
  expect(filesButton("Tree", second)).toHaveAttribute("aria-pressed", "true");
  expect(
    within(second).queryByText('"first document"'),
  ).not.toBeInTheDocument();
  expect(
    within(second).queryByText('"second document"'),
  ).not.toBeInTheDocument();
  click(filesButton('Expand "items"', second));
  expect(within(second).getByText('"second document"')).toBeInTheDocument();
});
