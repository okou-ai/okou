import assert from "node:assert/strict";

// The local identity service labels each test window. The indicator endpoint
// records the alias corresponding to the Authorization header it received.
export async function verifySurvivingIndicatorProvider({
  first,
  second,
  boundary,
  publish,
}) {
  const offset = (await boundary.events()).length;
  await boundary.holdBoth();
  await publish();
  await boundary.until(async () => {
    const current = (await boundary.events()).slice(offset);
    return ["A", "B"].every((alias) => {
      return current.some((r) => {
        return r.op === "asked" && r.alias === alias && r.mode === "hold";
      });
    });
  });
  const closed = first.waitForEvent("close");
  await first.close();
  await closed;
  const beforeRelease = (await boundary.events()).length;
  await boundary.releaseHealthy();
  await boundary.until(async () => {
    return (await boundary.events()).slice(beforeRelease).some((r) => {
      return r.op === "indicators" && r.alias === "B";
    });
  });
  const unread = second.getByRole("link", { name: /Side survey.*Unread/s });
  await unread.waitFor();
  const events = await boundary.events();
  const pending = events.slice(offset);
  assert.equal(
    pending.some((r) => {
      return r.op === "settled" && r.alias === "A" && r.mode === "hold";
    }),
    false,
  );
  assert.equal(
    events.slice(beforeRelease).filter((r) => {
      return r.op === "indicators" && r.alias === "B";
    }).length,
    1,
  );
  return {
    heldAt: offset,
    closedBeforeRelease: beforeRelease,
    deliveredBeforeReleasingA: events.length,
    label: await unread.textContent(),
  };
}

// The two rows are first opened after the context goes offline. Keeping a
// previously painted transcript on screen would leave their cache origin unknown.
export async function verifyOfflineRows({ page, target, boundary }) {
  const label = await target.textContent();
  assert.match(label, /Unread/);
  await boundary.failNextWarm();
  assert.match(await target.textContent(), /Unread/);
  await boundary.recoverWarm();
  await boundary.goOffline();
  await target.click();
  for (const title of ["Delivered survey 17", "Delivered survey 18"]) {
    await page.getByText(title, { exact: true }).waitFor({ state: "attached" });
  }
  assert.equal(new globalThis.URL(page.url()).pathname, boundary.targetRoute);
  return {
    unreadDuringFailure: label,
    offlineRows: [17, 18],
    firstVisit: true,
  };
}
