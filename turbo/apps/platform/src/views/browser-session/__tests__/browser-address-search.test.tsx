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
