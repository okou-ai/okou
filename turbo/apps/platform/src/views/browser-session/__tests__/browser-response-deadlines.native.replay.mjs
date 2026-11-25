import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// The navigation is forwarded to Chromium. Only its protocol response is held.
// Each non-cacheable HTTP document displays its ordinal in its title.
export async function verifyNavigationDelivery({
  page,
  remotePage,
  remoteSession,
  address,
  receiver,
}) {
  const observations = [];
  const input = page.getByLabel("Remote browser input", { exact: true });
  const field = page.getByRole("textbox", { name: "Address" });
  const submit = page
    .locator("form")
    .filter({ has: field })
    .locator('button[type="submit"]');

  async function visit() {
    await field.click();
    await field.press("Control+a");
    await field.pressSequentially(address);
    await submit.click();
  }

  async function snapshot(step) {
    const history = await remoteSession.send("Page.getNavigationHistory");
    const entries = history.entries.filter((entry) => {
      return entry.url === address;
    });
    const result = {
      step,
      arrivals: receiver.count(),
      ids: entries.map((entry) => {
        return entry.id;
      }),
      title: await remotePage.title(),
      input: await input.isEnabled(),
      at: Date.now(),
    };
    observations.push(result);
    return result;
  }

  await visit();
  await remotePage.waitForURL(address);
  await remotePage.getByRole("textbox", { name: "Receipt" }).waitFor();
  await receiver.acknowledgement;
  const first = await snapshot("committed ACK held");
  assert.equal(first.arrivals, 1);
  assert.equal(first.title, "Arrival 1");
  assert.equal(first.ids.length, 1);

  await delay(31_500);
  await snapshot("beyond deadline");
  receiver.release();
  await page.waitForFunction(() => {
    return (
      globalThis.document.querySelector('[aria-label="Remote browser input"]')
        ?.disabled === false
    );
  });
  const recovered = await snapshot("recovered");
  assert.equal(recovered.arrivals, 1);
  assert.deepEqual(recovered.ids, first.ids);
  assert.equal(recovered.title, "Arrival 1");

  await visit();
  await remotePage.waitForFunction(() => {
    return globalThis.document.title === "Arrival 2";
  });
  const repeated = await snapshot("repeat control");
  assert.equal(repeated.arrivals, 2);
  assert.notDeepEqual(repeated.ids, first.ids);
  return observations;
}
