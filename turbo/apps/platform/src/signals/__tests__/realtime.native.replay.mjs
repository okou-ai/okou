import assert from "node:assert/strict";

// The provider exposes channel registrations, and the queue API exposes the
// resulting read. The drawer confirms that the returned capacity reached the user.
export async function verifyOrganizationQueueUpdate({ page, boundary }) {
  const drawer = page.getByRole("dialog", { name: "Your request is queued" });
  await drawer.getByText("6 of 7 slots in use").waitFor({ timeout: 65_000 });
  const topic = "runQueueChanged";
  const subscriptions = (await boundary.events()).filter((event) => {
    return event.op === "subscribe" && event.topic === topic;
  });
  const organization = subscriptions.find((event) => {
    return event.name.startsWith("org:");
  });
  assert.ok(organization);
  assert.equal(
    subscriptions.some((event) => {
      return event.name.startsWith("user:");
    }),
    false,
  );
  await boundary.setCapacity(4);
  await boundary.publish("user:test-user-123", topic);
  assert.equal(await drawer.getByText("6 of 7 slots in use").isVisible(), true);
  const before = (await boundary.events()).length;
  await boundary.publish(organization.name, topic);
  await drawer.getByText("4 of 7 slots in use").waitFor();
  const after = (await boundary.events()).slice(before);
  assert.equal(
    after.filter((event) => {
      return (
        event.op === "delivery-1" &&
        event.name === organization.name &&
        event.topic === topic
      );
    }).length,
    1,
  );
  assert.equal(
    after.filter((event) => {
      return event.op === "capacity" && event.active === 4;
    }).length,
    1,
  );
  assert.equal(
    after.some((event) => {
      return (
        event.op === "subscribe" &&
        event.topic === topic &&
        event.name.startsWith("user:")
      );
    }),
    false,
  );
}

export async function verifySuspendedAutomationSubscription({
  page,
  events,
  changeConnection,
  openAutomations,
  publishAutomation,
  topic,
  until,
}) {
  const subscribed = (event) => {
    return event.op === "subscribe" && event.topic === topic;
  };
  assert.equal((await events()).some(subscribed), false);
  await changeConnection("suspended");
  await openAutomations();
  await until(async () => {
    return (await events()).some(subscribed);
  });
  const subscription = (await events()).find(subscribed);
  const card = page.getByText("Harbor schedule", { exact: true });
  await changeConnection("connected");
  assert.equal(await card.isVisible(), false);
  const before = (await events()).length;
  await publishAutomation(subscription.name, topic);
  await card.waitFor({ state: "visible" });
  const delivered = (await events()).slice(before);
  assert.equal(
    delivered.filter((event) => {
      return (
        event.op === "delivery-1" &&
        event.name === subscription.name &&
        event.topic === topic
      );
    }).length,
    1,
  );
  assert.equal(
    delivered.filter((event) => {
      return event.op === "automations" && event.status === 200;
    }).length,
    1,
  );
}
