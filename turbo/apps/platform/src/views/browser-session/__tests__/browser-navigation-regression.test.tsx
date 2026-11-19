import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const home = "https://example.com";

async function submitAddress(url: string) {
  const address = screen.getByLabelText("Address");
  await fill(address, url);
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
  return address;
}

function selectedTab() {
  return queryAllByRoleFast("tab").find((candidate) => {
    return candidate.getAttribute("aria-selected") === "true";
  });
}

test("Keep remote input usable while the first history response is held", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  const history = cdp.holdNext("Page.getNavigationHistory");
  await openPage();
  await history.received;
  await expectStreamingAt(home);
  const address = screen.getByLabelText("Address");
  expect(address).toBeEnabled();

  const input = screen.getByLabelText("Remote browser input");
  input.focus();
  fireEvent.input(input, {
    target: { value: "hello browser" },
    data: "hello browser",
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(cdp.input).toContainEqual({
      method: "Input.insertText",
      params: { text: "hello browser" },
      sessionId: cdp.pageSession("example-page"),
    });
  });
  await history.release();
  await expectStreamingAt(home);
  expect(address).toBeEnabled();
});

test("Clear a failed reload notice by submitting a working address", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(home);
  cdp.failNext("Page.reload", "Reload unavailable");

  click(screen.getByLabelText("Reload"));

  const notice = await screen.findByRole("alert");
  expect(notice).toHaveTextContent("The browser action could not be completed");
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();

  await submitAddress("https://next.example.test/");
  await expectStreamingAt("https://next.example.test/");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("Keep the confirmed document selected when a navigation starts a download without history", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  cdp.failNext("Page.getNavigationHistory", "History unavailable");
  await openPage();
  await expectStreamingAt(home);
  const tab = selectedTab();
  expect(tab).toHaveTextContent("Example");
  expect(
    cdp.requests.filter((request) => {
      return request.method === "Page.getNavigationHistory";
    }),
  ).toHaveLength(1);
  cdp.failNext("Page.getNavigationHistory", "History remains unavailable");
  cdp.downloadNextNavigation();

  const address = await submitAddress("https://files.example.test/file.zip");

  await waitFor(() => {
    expect(cdp.requests).toContainEqual(
      expect.objectContaining({
        method: "Page.navigate",
        params: expect.objectContaining({
          url: "https://files.example.test/file.zip",
        }),
      }),
    );
    expect(address).toHaveValue(home);
    expect(address).toBeEnabled();
  });
  expect(selectedTab()).toBe(tab);
});

test("Display the final redirect address when the pending navigation is acknowledged", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(home);
  const finalUrl = "https://destination.example.test/final";
  cdp.redirectNextNavigation(finalUrl);
  const navigation = cdp.holdNext("Page.navigate");

  const address = await submitAddress("https://redirect.example.test/");
  await navigation.received;
  await waitFor(() => {
    expect(selectedTab()).toHaveTextContent("destination.example.test");
    expect(address).toBeEnabled();
  });

  await navigation.release();
  await expectStreamingAt(finalUrl);
  expect(address).toBeEnabled();
});
