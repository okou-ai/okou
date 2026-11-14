import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

async function openViewer(options: { blank?: boolean } = {}) {
  const browser = mockBrowserCdp(
    context,
    "wss://browser.example/address-search",
    {
      targets: [
        {
          targetId: "home",
          title: "Home",
          url: options.blank ? "about:blank" : "https://home.example/",
        },
        {
          targetId: "reports",
          title: "Reports",
          url: "https://sales.example/report",
        },
        {
          targetId: "foreign",
          title: "Private report",
          url: "https://foreign.example/report",
          windowId: 9,
        },
      ],
    },
  );
  const session: BrowserSession = {
    threadId,
    name: "Browser",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: 0,
    },
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: session,
      viewer: {
        browser: session,
        cdpUrl: "wss://browser.example/address-search",
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  await setupPage({
    context,
    path: `/browsers/${threadId}`,
  });
  const viewer = await screen.findByRole("region", {
    name: "Remote browser viewer",
  });
  await waitFor(() => {
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  return {
    browser,
    viewer,
    address: within(viewer).getByLabelText<HTMLInputElement>("Address"),
  };
}

test.each([false, true])(
  "Plain text opens Google search on the selected page (blank=%s)",
  async (blank) => {
    const { address, viewer } = await openViewer({ blank });
    await fill(address, "quarterly sales");
    expect(
      within(viewer).getByLabelText("Search Google", {
        selector: "button",
      }),
    ).toBeEnabled();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue(
        "https://www.google.com/search?q=quarterly+sales",
      );
    });
  },
);

test("The pointer submit action distinguishes search from direct URL navigation", async () => {
  const { address, viewer } = await openViewer();
  await fill(address, "annual report");
  click(
    within(viewer).getByLabelText("Search Google", {
      selector: "button",
    }),
  );
  await waitFor(() => {
    expect(address).toHaveValue(
      "https://www.google.com/search?q=annual+report",
    );
  });
  await fill(address, "sales.example/new");
  click(within(viewer).getByLabelText("Open address", { selector: "button" }));
  await waitFor(() => {
    expect(address).toHaveValue("http://sales.example/new");
  });
});

test("Invalid explicit input does not become a search", async () => {
  const { address, viewer } = await openViewer();
  await fill(address, "///invalid");
  expect(
    within(viewer).getByLabelText("Open address", { selector: "button" }),
  ).toBeDisabled();
  fireEvent.submit(address.form!);
  await expect(within(viewer).findByRole("alert")).resolves.toBeInTheDocument();
  expect(address).toHaveValue("///invalid");
});

test("Composition confirmation does not submit a search", async () => {
  const { address } = await openViewer();
  await fill(address, "季度报告");
  fireEvent.compositionStart(address);
  fireEvent.keyDown(address, {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
    isComposing: true,
  });
  fireEvent.keyDown(address, {
    key: "Enter",
    ctrlKey: true,
    isComposing: false,
  });
  fireEvent.submit(address.form!);
  expect(address).toHaveValue("季度报告");
  fireEvent.compositionEnd(address);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue(
      `https://www.google.com/search?q=${encodeURIComponent("季度报告")}`,
    );
  });
});

test("A Google search URL retains its original pending receipt across document replacement", async () => {
  const { browser, viewer, address } = await openViewer();
  const search = browser.holdNext("Page.navigate");
  await fill(address, "quarterly sales");
  await userEvent.keyboard("{Enter}");
  await search.received;
  await expect(
    within(viewer).findByLabelText("www.google.com", {
      selector: '[role="tab"]',
    }),
  ).resolves.toBeInTheDocument();
  expect(address).toHaveValue("quarterly sales");
  expect(address).toHaveAttribute("aria-busy", "true");
  await act(async () => {
    await search.release();
  });
  await waitFor(() => {
    expect(address).toHaveAttribute("aria-busy", "false");
    expect(address).toHaveValue(
      "https://www.google.com/search?q=quarterly+sales",
    );
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("Google search keeps Unicode and reserved characters in a single query parameter", async () => {
  const { address } = await openViewer();
  await fill(address, "季度报告 & revenue + 20% #2026");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue(
      "https://www.google.com/search?q=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A+%26+revenue+%2B+20%25+%232026",
    );
  });
});

// Representative deterministic cases from Chromium's AutocompleteInput/URLFixer tests.
test.each([
  ["site:example.com", "https://www.google.com/search?q=site%3Aexample.com"],
  [
    "filetype:pdf annual report",
    "https://www.google.com/search?q=filetype%3Apdf+annual+report",
  ],
  ["custom:report", "https://www.google.com/search?q=custom%3Areport"],
  [
    "custom://reports/",
    "https://www.google.com/search?q=custom%3A%2F%2Freports%2F",
  ],
  ["report.pdf", "https://www.google.com/search?q=report.pdf"],
  ["co.uk", "https://www.google.com/search?q=co.uk"],
  ["example..com", "https://www.google.com/search?q=example..com"],
  ["java.awt.event", "https://www.google.com/search?q=java.awt.event"],
  ["?example.com", "https://www.google.com/search?q=example.com"],
  ["user@example.com", "https://www.google.com/search?q=user%40example.com"],
  ["user@example.com/path", "http://user@example.com/path"],
  ["intranet/", "http://intranet/"],
  ["//intranet/path", "http://intranet/path"],
  ["example.invalid/", "https://www.google.com/search?q=example.invalid%2F"],
  [
    "http://invalid/",
    "https://www.google.com/search?q=http%3A%2F%2Finvalid%2F",
  ],
  ["intranet/path", "https://www.google.com/search?q=intranet%2Fpath"],
  ["intranet/path?q=1", "http://intranet/path?q=1"],
  ["foo:80", "https://www.google.com/search?q=foo%3A80"],
  ["foo:81", "http://foo:81/"],
  ["foo:80/path", "http://foo/path"],
  ["foo:99999", "https://www.google.com/search?q=foo%3A99999"],
  ["localhost:8080/path", "http://localhost:8080/path"],
  ["foo.localhost", "http://foo.localhost/"],
  ["printer.local", "http://printer.local/"],
  ["127.0.0.1", "http://127.0.0.1/"],
  ["127.0.1", "https://www.google.com/search?q=127.0.1"],
  ["[2001:db8::2]", "http://[2001:db8::2]/"],
  [
    "https;//example.com/report?q=1#total",
    "https://example.com/report?q=1#total",
  ],
  ["https:/example.com", "https://example.com/"],
  ["..example.com..", "http://example.com./"],
  [String.raw`example.com\report`, "http://example.com/report"],
  [
    "例子.中国/季度报告",
    "http://xn--fsqu00a.xn--fiqs8s/%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A",
  ],
])("The address bar resolves Chromium input %s", async (text, expected) => {
  const { address } = await openViewer();
  await fill(address, text);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue(expected);
  });
});

test.each([
  ["acmeportal", "http://www.acmeportal.com/"],
  ["www", "http://www.com/"],
  [
    "www.acmeportal/report?q=a#summary",
    "http://www.acmeportal.com/report?q=a#summary",
  ],
  ["example.co.uk/report", "http://example.co.uk/report"],
  ["co.uk", "http://www.co.uk.com/"],
  ["example..com", "https://www.google.com/search?q=example..com"],
  ["portal.invalid", "http://www.portal.invalid.com/"],
  ["999999999999999", "http://www.999999999999999.com/"],
  ["https://127.0.1", "https://www.127.0.1.com/"],
  ["https:65536", "https://www.65536.com/"],
  ["..example.com..", "http://example.com./"],
  ["例子.中国", "http://xn--fsqu00a.xn--fiqs8s/"],
  ["annual report", "https://www.google.com/search?q=annual+report"],
  ["site:example.com", "https://www.google.com/search?q=site%3Aexample.com"],
])(
  "Ctrl+Enter completes eligible Chromium host input %s",
  async (text, expected) => {
    const { address } = await openViewer();
    await fill(address, text);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => {
      expect(address).toHaveValue(expected);
    });
  },
);

test.each([
  [
    "https://example.com/a-\nreport?q=1",
    "https://example.com/a-report?q=1",
    "https://example.com/a-report?q=1",
  ],
  [
    "1600 Amphitheatre Parkway\nMountain View, CA",
    "1600 Amphitheatre Parkway Mountain View, CA",
    "https://www.google.com/search?q=1600+Amphitheatre+Parkway+Mountain+View%2C+CA",
  ],
  [
    " java\r\nscript:JavaScript:alert(0) ",
    "alert(0)",
    "https://www.google.com/search?q=alert%280%29",
  ],
  [
    "https://example.com/?q=javascript:alert(0)",
    "https://example.com/?q=javascript:alert(0)",
    "https://example.com/?q=javascript:alert(0)",
  ],
])(
  "Pasted address text is sanitized before submission: %s",
  async (pasted, cleaned, expected) => {
    const { address } = await openViewer();
    await fill(address, "replace me");
    address.select();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pasted);
    await userEvent.paste(clipboardData);
    expect(address).toHaveValue(cleaned);
    expect(address.selectionStart).toBe(cleaned.length);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue(expected);
    });
  },
);

test("Sanitized paste replaces the selected address text and retains its caret", async () => {
  const { address } = await openViewer();
  await fill(address, "first old last");
  address.setSelectionRange(6, 9);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "javascript:javascript:NEW");
  await userEvent.paste(clipboardData);
  expect(address).toHaveValue("first NEW last");
  expect(address.selectionStart).toBe(9);
  expect(address.selectionEnd).toBe(9);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue(
      "https://www.google.com/search?q=first+NEW+last",
    );
  });
});

test("A consumed Control gesture submits the query without adding a domain suffix", async () => {
  const { address } = await openViewer();
  await fill(address, "acmeportal");
  await userEvent.keyboard("{Control>}a{Enter}{/Control}");
  await waitFor(() => {
    expect(address).toHaveValue("https://www.google.com/search?q=acmeportal");
  });
});
