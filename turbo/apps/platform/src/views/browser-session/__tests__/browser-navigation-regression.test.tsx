import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click } from "../../../__tests__/page-helper.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
test("browser-navigation-regression-02 delivers text to the active page before its history is ready", async () => {
  const url = "https://meeting.example/agenda";
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [
      { targetId: "agenda", windowId: 101, url, title: "Planning agenda" },
    ],
  });
  const history = cdp.holdNext("Page.getNavigationHistory");
  await openPage();
  await history.received;
  const input = await screen.findByLabelText("Remote browser input");
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  input.focus();
  fireEvent.input(input, {
    inputType: "insertText",
    target: { value: "Review agenda" },
    data: "Review agenda",
  });
  await waitFor(() => {
    expect(cdp.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "Review agenda" },
        sessionId: cdp.pageSession("agenda"),
      }),
    );
  });
  expect(screen.getByLabelText("Address")).toBeEnabled();
  expect(screen.getByLabelText("Back")).toBeDisabled();
  await history.release({
    currentIndex: 1,
    entries: [
      {
        id: 40,
        url: "https://meeting.example/",
        title: "Overview",
        userTypedURL: "",
        transitionType: "link",
      },
      {
        id: 41,
        url,
        userTypedURL: url,
        title: "Confirmed agenda",
        transitionType: "link",
      },
    ],
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Back")).toBeEnabled();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(url);
  });
});

function openAddress(destination: string) {
  const field = screen.getByRole("textbox", { name: "Address" });
  fireEvent.change(field, { target: { value: destination } });
  click(screen.getByLabelText("Open address"));
  return field;
}

test("browser-navigation-regression-04.01 opening a working URL dismisses the reload failure", async () => {
  const { openPage, cdp } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt("https://example.com");
  cdp.failNext("Page.reload", "Reload unavailable");
  click(screen.getByLabelText("Reload"));
  const failure = await screen.findByText(
    /browser action could not be completed/i,
  );
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  const destination = "https://manual.example/troubleshooting";
  const field = openAddress(destination);
  await screen.findByLabelText("manual.example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  await waitFor(() => {
    expect(field).toHaveValue(destination);
    expect(failure).not.toBeInTheDocument();
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("browser-navigation-regression-05 the download receipt returns the address field to the selected document", async () => {
  const { openPage, cdp } = arrangeNativePage(context);
  const history = cdp.holdNext("Page.getNavigationHistory");
  await openPage();
  await history.received;
  await expectStreamingAt("https://example.com");
  const documentTab = screen.getByLabelText("Example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  cdp.downloadNextNavigation();
  const download = cdp.holdNext("Page.navigate");
  const field = openAddress("https://exports.example/plan.zip");
  await download.received;
  expect(screen.getByLabelText("Reload")).toBeDisabled();
  await download.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Reload")).toBeEnabled();
    expect(field).toHaveValue("https://example.com");
    expect(field).toBeEnabled();
    expect(
      screen.getByLabelText("Example", {
        selector: '[role="tab"][aria-selected="true"]',
      }),
    ).toBe(documentTab);
  });
});

test("browser-navigation-regression-06 a redirect selects its committed page before the held receipt settles", async () => {
  const { openPage, cdp } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt("https://example.com");
  const finalUrl = "https://reports.example/weekly";
  cdp.redirectNextNavigation(finalUrl);
  const receipt = cdp.holdNext("Page.navigate");
  const field = openAddress("https://short.example/week");
  await receipt.received;
  await screen.findByLabelText("reports.example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  expect(field).toBeEnabled();
  expect(screen.getByLabelText("Reload")).toBeDisabled();
  await receipt.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Reload")).toBeEnabled();
    expect(field).toHaveValue(finalUrl);
  });
});
