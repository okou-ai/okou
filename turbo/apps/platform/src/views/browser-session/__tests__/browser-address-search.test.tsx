import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fill } from "../../../__tests__/page-helper.ts";
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
test.each(searches)(
  "browser-address-search-%s Submitting %s navigates the selected remote page",
  async (_id, input, destination, initial) => {
    const tab = "field-survey";
    const browser = arrangeNativePage(context, {
      targets: [
        { targetId: tab, title: "Sales report", url: initial, windowId: 101 },
      ],
    });
    await browser.openPage();
    const address = await screen.findByRole("textbox", { name: "Address" });
    await waitFor(() => {
      return expect(
        screen.getByLabelText("Remote browser input"),
      ).toBeEnabled();
    });
    await fill(address, input);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(
        browser.cdp.targets.find((target) => {
          return target.targetId === tab;
        })?.url,
      ).toBe(destination);
      expect(address).toHaveValue(destination);
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
  },
);
