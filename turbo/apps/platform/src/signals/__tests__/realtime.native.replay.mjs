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

// Keep the connector menu and the automation panel mounted across both
// publications. The queued event makes thread detail visible in the composer.
export async function verifyThreadInvalidations({
  page,
  stageChanges,
  publishDetail,
  publishAutomation,
}) {
  const oldPreference = page
    .getByText("Cedar account", { exact: true })
    .first();
  const newPreference = page
    .getByText("Maple account", { exact: true })
    .first();
  const oldSchedule = page.getByText("Cedar schedule", { exact: true });
  const newSchedule = page.getByText("Maple schedule", { exact: true });
  const recovery = page.getByText(
    "Finalizing the cancelled run before queued work continues.",
    { exact: true },
  );
  await oldPreference.waitFor();
  await oldSchedule.waitFor();
  await stageChanges();
  assert.equal(await oldPreference.isVisible(), true);
  assert.equal(await oldSchedule.isVisible(), true);
  assert.equal(await recovery.isVisible(), false);
  await publishDetail();
  await newPreference.waitFor();
  await recovery.waitFor();
  assert.equal(await oldSchedule.isVisible(), true);
  assert.equal(await newSchedule.isVisible(), false);
  await publishAutomation();
  await newSchedule.waitFor();
  assert.equal(await oldSchedule.isVisible(), false);
  assert.equal(await newPreference.isVisible(), true);
}
