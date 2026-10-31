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
const operationError =
  "The browser action could not be completed. Check the browser before trying again.";

function mockViewer() {
  const session: BrowserSession = {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
  const cdpUrl = "wss://browser.example/navigation-regressions";
  const browser = mockBrowserCdp(context, cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
      },
      {
        targetId: "other-page",
        title: "Other",
        url: "https://other.example.com",
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: session });
  });
  context.mocks.api(browserContract.viewerConnection, ({ respond }) => {
    return respond(200, { cdpUrl, extension: TEST_BROWSER_EXTENSION });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  return browser;
}

async function openViewer() {
  await setupPage({ context, path: `/browsers/${threadId}` });
  const viewer = await screen.findByRole("region", {
    name: "Remote browser viewer",
  });
  await waitFor(() => {
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();
  });
  return viewer;
}

async function enterRemoteText(
  viewer: HTMLElement,
  browser: ReturnType<typeof mockViewer>,
) {
  const input = within(viewer).getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "live text" },
    data: "live text",
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual({
      method: "Input.insertText",
      params: { text: "live text" },
      sessionId: "example-page-session",
    });
  });
  expect(input).toHaveFocus();
}

test.each([
  ["google.com", "http://google.com/"],
  ["https://google.com", "https://google.com/"],
])(
  "The address bar submits %s through the native form without a keydown",
  async (value, expected) => {
    mockViewer();
    const viewer = await openViewer();
    const address = within(viewer).getByLabelText<HTMLInputElement>("Address");
    await fill(address, value);
    fireEvent.submit(address.form!);
    await waitFor(() => {
      expect(address).toHaveValue(expected);
      expect(address).toBeEnabled();
    });
  },
);

test("A pending initial history response does not block live remote input", async () => {
  const browser = mockViewer();
  const history = browser.holdNext("Page.getNavigationHistory");
  const viewer = await openViewer();
  await history.received;
  expect(within(viewer).getByLabelText("Address")).toBeEnabled();
  await enterRemoteText(viewer, browser);

  await act(async () => {
    await history.release();
  });
  expect(within(viewer).getByLabelText("Address")).toHaveValue(
    "https://example.com",
  );
});

test("A history failure has local feedback without disabling live input", async () => {
  const browser = mockViewer();
  browser.failNext(
    "Page.getNavigationHistory",
    "Navigation history unavailable",
  );
  const viewer = await openViewer();
  const alert = await within(viewer).findByRole("alert");
  expect(alert).toHaveTextContent(operationError);
  expect(within(viewer).getByLabelText("Address")).toBeEnabled();
  await enterRemoteText(viewer, browser);
  expect(alert).toBeInTheDocument();
});

test.each(["successful submission", "another tab"] as const)(
  "A failed Reload is cleared by %s",
  async (recovery) => {
    const browser = mockViewer();
    const viewer = await openViewer();
    browser.failNext("Page.reload", "The page could not reload");
    click(within(viewer).getByLabelText("Reload"));
    const alert = await within(viewer).findByRole("alert");
    expect(alert).toHaveTextContent(operationError);
    expect(within(viewer).getByLabelText("Remote browser input")).toBeEnabled();

    if (recovery === "successful submission") {
      await fill(
        within(viewer).getByLabelText("Address"),
        "recovered.example/path",
      );
      await userEvent.keyboard("{Enter}");
    } else {
      click(
        within(viewer).getByLabelText("Other", { selector: '[role="tab"]' }),
      );
    }
    await waitFor(() => {
      expect(within(viewer).getByLabelText("Address")).toHaveValue(
        recovery === "successful submission"
          ? "http://recovered.example/path"
          : "https://other.example.com",
      );
      expect(within(viewer).getByLabelText("Address")).toBeEnabled();
    });
    expect(within(viewer).queryByRole("alert")).not.toBeInTheDocument();
  },
);

test("A download acknowledgement preserves the confirmed document address without history", async () => {
  const browser = mockViewer();
  browser.failNext("Page.getNavigationHistory", "History is unavailable");
  const viewer = await openViewer();
  await within(viewer).findByRole("alert");
  browser.downloadNextNavigation();
  const navigation = browser.holdNext("Page.navigate");
  const address = within(viewer).getByLabelText("Address");
  await fill(address, "https://files.example/report.csv");
  await userEvent.keyboard("{Enter}");
  await navigation.received;
  expect(address).toBeDisabled();

  await act(async () => {
    await navigation.release();
  });
  await waitFor(() => {
    expect(address).toBeEnabled();
    expect(address).toHaveValue("https://example.com");
  });
  expect(
    within(viewer).getByLabelText("Example", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
});

test("A redirect shows its committed URL after the navigation receipt", async () => {
  const browser = mockViewer();
  const viewer = await openViewer();
  browser.redirectNextNavigation("https://destination.example/account");
  const navigation = browser.holdNext("Page.navigate");
  const address = within(viewer).getByLabelText("Address");
  await fill(address, "https://redirect.example/start");
  await userEvent.keyboard("{Enter}");
  await navigation.received;
  await waitFor(() => {
    expect(
      within(viewer).getByLabelText("destination.example", {
        selector: '[role="tab"]',
      }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(address).toBeDisabled();

  await act(async () => {
    await navigation.release();
  });
  await waitFor(() => {
    expect(address).toBeEnabled();
    expect(address).toHaveValue("https://destination.example/account");
  });
});
