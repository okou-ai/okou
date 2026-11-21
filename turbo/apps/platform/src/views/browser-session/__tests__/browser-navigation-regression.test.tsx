import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { arrangeNativePage } from "./browser-native-page-fixture.ts";

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
