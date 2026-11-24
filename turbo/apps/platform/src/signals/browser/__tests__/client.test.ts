import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { testContext } from "../../__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "../../../views/browser-session/__tests__/browser-native-page-fixture.ts";

import { object, string } from "zod";

const context = testContext();

test("Moving a page during attachment releases its late session and leaves the original page interactive", async () => {
  const estuary = {
    targetId: "estuary",
    url: "https://estuary.example",
    title: "Estuary",
    windowId: 5,
  };
  const bay = {
    targetId: "bay",
    url: "https://bay.example",
    title: "Bay",
    windowId: 5,
  };
  const { cdp, openPage } = arrangeNativePage(
    context,
    { targets: [estuary, bay] },
    5,
  );
  await openPage();
  await expectStreamingAt(estuary.url);
  const attach = cdp.holdNext("Target.attachToTarget", bay.targetId);
  await userEvent.click(screen.getByRole("tab", { name: bay.title }));
  const response = object({ result: object({ sessionId: string() }) }).parse(
    JSON.parse(await attach.received),
  );
  cdp.move(bay.targetId, 7);
  await waitFor(() => {
    expect(screen.queryByRole("tab", { name: bay.title })).toBeNull();
  });
  await attach.release();
  await waitFor(() => {
    expect(cdp.detached).toContain(response.result.sessionId);
  });
  await expectStreamingAt(estuary.url);
  const entry = screen.getByLabelText("Remote browser input");
  await userEvent.click(entry);
  fireEvent.input(entry, {
    data: "return tide",
    inputType: "insertText",
    target: { value: "return tide" },
  });
  await waitFor(() => {
    expect(cdp.inputForTarget(estuary.targetId)).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ text: "return tide" }),
      }),
    );
  });
});
