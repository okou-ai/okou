import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { observeWorkerTraffic } from "./worker-traffic-fixture.ts";

const context = testContext();
test("message-port-015 A workspace receives the template update published to its organization", async () => {
  const wire = observeWorkerTraffic(context.signal);
  const topic = "presentationTemplatesChanged";
  await setupPage({
    context,
    path: "/workflows",
    sharedWorkerTestTransport: "message-port",
  });
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  const request = await waitFor(() => {
    const active = wire.requests().find((message) => {
      return (
        message.type === "realtime-subscribe" &&
        message.scope === "org" &&
        message.topic === topic
      );
    });
    if (active?.type !== "realtime-subscribe") {
      throw new Error("The page has not requested workspace template updates");
    }
    expect(wire.received()).toContainEqual({
      type: "realtime-subscribed",
      subscriptionId: active.subscriptionId,
    });
    return active;
  });
  for (const org of ["neighbor", "org_default"]) {
    context.mocks.ably.triggerOnChannel("org:" + org, topic, { revision: org });
  }
  await waitFor(() => {
    const revisions = wire.received().flatMap((msg) => {
      return msg.type === "realtime-event" &&
        msg.subscriptionId === request.subscriptionId
        ? [msg.message]
        : [];
    });
    expect(revisions).toStrictEqual([
      { name: topic, data: { revision: "org_default" } },
    ]);
  });
});
