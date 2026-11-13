import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

async function openViewer(
  options: {
    blank?: boolean;
    searchAvailable?: boolean;
    secondReport?: boolean;
    reportTitle?: string;
  } = {},
) {
  const browser = mockBrowserCdp(
    context,
    "wss://browser.example/address-suggestions",
    {
      searchAvailable: options.searchAvailable,
      targets: [
        {
          targetId: "home",
          title: "Home",
          url: options.blank ? "about:blank" : "https://home.example/",
        },
        {
          targetId: "reports",
          title: options.reportTitle ?? "Quarterly report",
          url: "https://sales.example/report",
        },
        ...(options.secondReport
          ? [
              {
                targetId: "other-report",
                title: "Annual report",
                url: "https://other.example/report",
              },
            ]
          : []),
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
        cdpUrl: "wss://browser.example/address-suggestions",
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
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", name: "Staff" },
        memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
      },
    },
    featureSwitches: { [FeatureSwitchKey.BrowserAddressSuggestions]: true },
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

test.each([
  { query: "SALES quart", title: "Quarterly report" },
  { query: "SALES 报告", title: "季度报告" },
])(
  "Address suggestions match every term across title and URL ($query) without duplicating tabs",
  async ({ query, title }) => {
    const { viewer, address } = await openViewer({ reportTitle: title });
    await fill(address, query);
    const list = await screen.findByRole("listbox");
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("Search with default search engine");
    expect(options[1]).toHaveTextContent(title);
    click(options[1]!);
    await waitFor(() => {
      expect(address).toHaveValue("https://sales.example/report");
    });
    expect(
      within(viewer).getByLabelText(title, {
        selector: '[role="tab"]',
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(queryAllByRoleFast("tab", viewer)).toHaveLength(2);
  },
);

test.each([false, true])(
  "Plain text searches the selected page through Chrome's default engine (blank=%s)",
  async (blank) => {
    const { address } = await openViewer({ blank });
    await fill(address, "quarterly sales");
    await expect(
      screen.findByRole("option", {
        name: /Search with default search engine/,
      }),
    ).resolves.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue(
        "https://search.example/?q=quarterly%20sales",
      );
    });
  },
);

test("URL input remains a direct navigation and Escape preserves the typed query", async () => {
  const { address } = await openViewer();
  await fill(address, "sales.example/new");
  await expect(
    screen.findByRole("option", { name: /Open address/ }),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(address).toHaveValue("sales.example/new");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.submit(address.form!);
  await waitFor(() => {
    expect(address).toHaveValue("http://sales.example/new");
  });
});

test("A keyboard-selected tab survives metadata reranking and is not replaced by another action", async () => {
  const { browser, address } = await openViewer({ secondReport: true });
  await fill(address, "report");
  await screen.findByRole("option", { name: /Quarterly report/ });
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  act(() => {
    browser.targets[1]!.title = "Report updated";
    browser.event("Target.targetInfoChanged", {
      targetInfo: { ...browser.targets[1]!, type: "page" },
    });
  });
  await screen.findByRole("option", { name: /Report updated/ });
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("https://sales.example/report");
  });
});

test("Removing an explicitly selected tab does not turn Enter into another action", async () => {
  const { browser, viewer, address } = await openViewer();
  await fill(address, "report");
  await screen.findByRole("option", { name: /Switch to tab/ });
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  act(() => {
    browser.event("Target.targetDestroyed", { targetId: "reports" });
  });
  await expect(
    screen.findByRole("option", { name: /Tab no longer available/ }),
  ).resolves.toHaveAttribute("aria-disabled", "true");
  fireEvent.submit(address.form!);
  await expect(within(viewer).findByRole("alert")).resolves.toBeInTheDocument();
  expect(address).toHaveValue("report");
});

test("Editing a query clears its earlier explicit tab selection", async () => {
  const { address } = await openViewer();
  await fill(address, "report");
  await screen.findByRole("option", { name: /Switch to tab/ });
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  await fill(address, "reports");
  await fill(address, "report");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("https://search.example/?q=report");
  });
});

test("Composition confirmation does not submit a search", async () => {
  const { address } = await openViewer();
  await fill(address, "季度报告");
  await screen.findByRole("listbox");
  fireEvent.compositionStart(address);
  fireEvent.keyDown(address, {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
    isComposing: true,
  });
  fireEvent.submit(address.form!);
  expect(address).toHaveValue("季度报告");
  fireEvent.compositionEnd(address);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue(
      `https://search.example/?q=${encodeURIComponent("季度报告")}`,
    );
  });
});

test("Browsers with an older extension retain URL navigation after an unsupported search", async () => {
  const { viewer, address } = await openViewer({ searchAvailable: false });
  await fill(address, "quarterly sales");
  await userEvent.keyboard("{Enter}");
  await expect(within(viewer).findByRole("alert")).resolves.toHaveTextContent(
    "Reopen Browser to enable search",
  );
  await fill(address, "sales.example/new");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://sales.example/new");
  });
});

test("A native search receipt remains pending through its document replacement", async () => {
  const { browser, viewer, address } = await openViewer();
  const search = browser.holdNextNative("search");
  await fill(address, "quarterly sales");
  await userEvent.keyboard("{Enter}");
  await search.received;
  await expect(
    within(viewer).findByLabelText("search.example", {
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
    expect(address).toHaveValue("https://search.example/?q=quarterly%20sales");
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("Native membership changes during search identity verification cancel the search", async () => {
  const { browser, viewer, address } = await openViewer();
  await fill(address, "quarterly sales");
  const read = browser.holdNextNative("listTabs");
  await userEvent.keyboard("{Enter}");
  await read.received;
  await act(async () => {
    browser.move("reports", 9);
    await read.release();
  });
  await waitFor(() => {
    expect(queryAllByRoleFast("tab", viewer)).toHaveLength(1);
  });
  click(within(viewer).getByLabelText("New tab"));
  await waitFor(() => {
    expect(address).toHaveValue("");
  });
  click(within(viewer).getByLabelText("Home", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(address).toHaveValue("https://home.example/");
  });
});
