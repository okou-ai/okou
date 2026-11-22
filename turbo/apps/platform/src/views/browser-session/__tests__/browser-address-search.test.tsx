import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { arrangeNativePage } from "./browser-native-page-fixture.ts";
const context = testContext();
const salesReport = "https://sales.example/report";
const searches = [
  [
    "001",
    "quarterly sales",
    "https://www.google.com/search?q=quarterly+sales",
    salesReport,
  ],
  [
    "002",
    "quarterly sales",
    "https://www.google.com/search?q=quarterly+sales",
    "about:blank",
  ],
  [
    "009",
    "季度报告 & revenue + 20% #2026",
    "https://www.google.com/search?q=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A+%26+revenue+%2B+20%25+%232026",
    salesReport,
  ],
  [
    "010",
    "site:example.com",
    "https://www.google.com/search?q=site%3Aexample.com",
    salesReport,
  ],
  [
    "011",
    "filetype:pdf annual report",
    "https://www.google.com/search?q=filetype%3Apdf+annual+report",
    salesReport,
  ],
  [
    "012",
    "custom:report",
    "https://www.google.com/search?q=custom%3Areport",
    salesReport,
  ],
  [
    "014",
    "report.pdf",
    "https://www.google.com/search?q=report.pdf",
    salesReport,
  ],
  [
    "017",
    "java.awt.event",
    "https://www.google.com/search?q=java.awt.event",
    salesReport,
  ],
  ["020", "user@example.com/path", "http://user@example.com/path", salesReport],
  ["024", "intranet/", "http://intranet/", salesReport],
  [
    "028",
    "intranet/path",
    "https://www.google.com/search?q=intranet%2Fpath",
    salesReport,
  ],
  ["031", "foo:80", "https://www.google.com/search?q=foo%3A80", salesReport],
  ["036", "localhost:8080/path", "http://localhost:8080/path", salesReport],
  ["038", "printer.local", "http://printer.local/", salesReport],
] as const;
async function openAddress(initial = salesReport) {
  const tab = "field-survey";
  const browser = arrangeNativePage(context, {
    targets: [
      { targetId: tab, title: "Sales report", url: initial, windowId: 101 },
    ],
  });
  await browser.openPage();
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Address",
  });
  await waitFor(() => {
    return expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  async function arrived(destination: string) {
    await waitFor(() => {
      expect(
        browser.cdp.targets.find((target) => {
          return target.targetId === tab;
        })?.url,
      ).toBe(destination);
      expect(address).toHaveValue(destination);
      expect(address).toHaveAttribute("aria-busy", "false");
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
  }
  return { address, arrived, cdp: browser.cdp };
}
test.each(searches)(
  "browser-address-search-%s Submitting %s navigates the selected remote page",
  async (_id, input, destination, initial) => {
    const { address, arrived } = await openAddress(initial);
    expect(address).toHaveValue(initial === "about:blank" ? "" : initial);
    await fill(address, input);
    await userEvent.keyboard("{Enter}");
    await arrived(destination);
  },
);

const label63 = "a".repeat(63);
const host64 = "a".repeat(64) + ".com";
const longHost = [label63, label63, label63, label63, "com"].join(".");
const enter = "{Enter}";
const complete = "{Control>}{Enter}{/Control}";

test.each([
  ["021", "user:pass@1.2:45", enter, "http://user:pass@1.0.0.2:45/"],
  [
    "030",
    "intranet/report\u2028part?q=1",
    enter,
    "http://intranet/report%E2%80%A8part?q=1",
  ],
  [
    "050",
    "http://foo._",
    enter,
    "https://www.google.com/search?q=http%3A%2F%2Ffoo._",
  ],
  ["052", label63 + ".com", enter, "http://" + label63 + ".com/"],
  ["053", host64, enter, "https://www.google.com/search?q=" + host64],
  [
    "056",
    "例子.中国/季度报告",
    enter,
    "http://xn--fsqu00a.xn--fiqs8s/%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A",
  ],
  ["057", "acmeportal", complete, "http://www.acmeportal.com/"],
  ["061", "example.co.uk/report", complete, "http://example.co.uk/report"],
  [
    "063",
    "example..com",
    complete,
    "https://www.google.com/search?q=example..com",
  ],
  ["070", host64, complete, "http://" + host64 + "/"],
  ["071", longHost, complete, "http://" + longHost + "/"],
  [
    "072",
    "https://example.com/report?q=1#total",
    complete,
    "https://example.com/report?q=1#total",
  ],
  [
    "074",
    "site:example.com",
    complete,
    "https://www.google.com/search?q=site%3Aexample.com",
  ],
  [
    "075",
    "filetype:pdf annual report",
    complete,
    "https://www.google.com/search?q=filetype%3Apdf+annual+report",
  ],
  [
    "076",
    "?example.com",
    complete,
    "https://www.google.com/search?q=example.com",
  ],
])(
  "browser-address-search-%s The selected tab receives the submitted address for %s",
  async (_id, text, gesture, url) => {
    const { address, arrived } = await openAddress();
    // Enter a line separator as an input edit, independent of clipboard cleanup.
    await userEvent.click(address);
    fireEvent.input(address, { target: { value: text } });
    expect(address).toHaveValue(text);
    await userEvent.keyboard(gesture);
    await arrived(url);
  },
);

test.each([
  [
    "077",
    "https://example.com/a-\nreport?q=1",
    "https://example.com/a-report?q=1",
    "https://example.com/a-report?q=1",
  ],
  [
    "078",
    "1600 Amphitheatre Parkway\nMountain View, CA",
    "1600 Amphitheatre Parkway Mountain View, CA",
    "https://www.google.com/search?q=1600+Amphitheatre+Parkway+Mountain+View%2C+CA",
  ],
  [
    "079",
    "  java\r\nscript:JavaScript:alert(0)  ",
    "alert(0)",
    "https://www.google.com/search?q=alert%280%29",
  ],
  [
    "080",
    "https://example.com/?q=javascript:alert(0)",
    "https://example.com/?q=javascript:alert(0)",
    "https://example.com/?q=javascript:alert(0)",
  ],
  [
    "081",
    "javascript:javascript:NEW",
    "first NEW last",
    "https://www.google.com/search?q=first+NEW+last",
  ],
])(
  "browser-address-search-%s Clipboard editing retains its caret and navigates the resulting text",
  async (id, clipboard, cleaned, url) => {
    const { address, arrived } = await openAddress();
    const partial = id === "081";
    await fill(address, partial ? "first old last" : "replace me");
    address.setSelectionRange(
      partial ? 6 : 0,
      partial ? 9 : address.value.length,
    );
    await userEvent.paste(clipboard);
    expect(address).toHaveValue(cleaned);
    expect(address.selectionStart).toBe(partial ? 9 : cleaned.length);
    expect(address.selectionEnd).toBe(address.selectionStart);
    await userEvent.keyboard(enter);
    await arrived(url);
  },
);

function action(label: string) {
  const button = queryAllByRoleFast("button").find((el) => {
    return el.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error("Missing browser action " + label);
  }
  return button;
}

test("browser-address-search-003 The address toolbar switches from search to direct navigation", async () => {
  const { address, arrived } = await openAddress();
  await fill(address, "annual report");
  expect(address).toHaveValue("annual report");
  click(action("Search Google"));
  await arrived("https://www.google.com/search?q=annual+report");
  await fill(address, "sales.example/new");
  click(action("Open address"));
  await arrived("http://sales.example/new");
});
test("browser-address-search-005 Confirming the active composition leaves the current page in place", async () => {
  const { address, arrived, cdp } = await openAddress();
  await userEvent.click(address);
  fireEvent.compositionStart(address);
  fireEvent.input(address, { target: { value: "季度报告" } });
  expect(
    fireEvent.keyDown(address, { key: "Enter", isComposing: true }),
  ).toBeFalsy();
  const form = address.form;
  if (!form) {
    throw new Error("Address form missing");
  }
  fireEvent.submit(form);
  expect(address).toHaveValue("季度报告");
  expect(address).toHaveAttribute("aria-busy", "false");
  expect(cdp.targets[0]?.url).toBe(salesReport);
  fireEvent.compositionEnd(address);
  await userEvent.keyboard(enter);
  await arrived(
    "https://www.google.com/search?q=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A",
  );
});
test.each([
  [
    "006",
    "quarterly sales",
    enter,
    "www.google.com",
    "https://www.google.com/search?q=quarterly+sales",
  ],
  [
    "007",
    "acmeportal",
    complete,
    "www.acmeportal.com",
    "http://www.acmeportal.com/",
  ],
])(
  "browser-address-search-%s The draft survives until the remote document commits",
  async (_id, text, keys, host, url) => {
    const { address, arrived, cdp } = await openAddress();
    const pending = cdp.holdNext("Page.navigate");
    await fill(address, text);
    await userEvent.keyboard(keys);
    await pending.received;
    const navigation = cdp.requests.find((request) => {
      return request.method === "Page.navigate";
    });
    expect(navigation?.params?.url).toBe(url);
    await waitFor(() => {
      expect(
        queryAllByRoleFast("tab").find((tab) => {
          return tab.getAttribute("aria-selected") === "true";
        }),
      ).toHaveTextContent(host);
      expect(address).toHaveAttribute("aria-busy", "true");
      expect(address).toHaveValue(text);
    });
    cdp.event(
      "Page.frameNavigated",
      { frame: { id: "example-frame", loaderId: "replacement-document", url } },
      navigation?.sessionId,
    );
    await pending.release();
    await arrived(url);
  },
);
test("browser-address-search-008 A failed completed host can be retried as a search", async () => {
  const { address, arrived, cdp } = await openAddress();
  cdp.rejectNextNavigation("net::ERR_NAME_NOT_RESOLVED");
  await fill(address, "acmeportal");
  await userEvent.keyboard(complete);
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
  expect(
    cdp.requests.find((r) => {
      return r.method === "Page.navigate";
    })?.params?.url,
  ).toBe("http://www.acmeportal.com/");
  expect(address).toHaveValue("acmeportal");
  await userEvent.keyboard(enter);
  await arrived("https://www.google.com/search?q=acmeportal");
});
test("browser-address-search-082 Selecting all consumes the held Control gesture", async () => {
  const { address, arrived } = await openAddress();
  await fill(address, "acmeportal");
  const keyboard = userEvent.setup();
  await keyboard.keyboard("{Control>}a");
  expect(address.selectionStart).toBe(0);
  expect(address.selectionEnd).toBe(address.value.length);
  await keyboard.keyboard("{Enter}{/Control}");
  await arrived("https://www.google.com/search?q=acmeportal");
});
