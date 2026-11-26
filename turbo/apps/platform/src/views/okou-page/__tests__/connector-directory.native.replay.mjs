// Both orderings start in the production directory. The consent page submits a
// local provider denial through the real callback for this same OAuth attempt.
export async function exerciseGmailCallback(page, order) {
  const dialog = page.getByRole("dialog", { name: "Connectors", exact: true });
  const connect = dialog.getByRole("button", {
    name: "Connect Gmail",
    exact: true,
  });
  const steps = [];
  await connect.waitFor();
  for (
    let i = 0;
    i < 60 &&
    !(await connect.evaluate((node) => {
      return node === globalThis.document.activeElement;
    }));
    i++
  ) {
    await page.keyboard.press("Tab");
  }
  if (
    !(await connect.evaluate((node) => {
      return node === globalThis.document.activeElement;
    }))
  ) {
    throw new Error("Connect Gmail was unreachable in the directory tab order");
  }
  const opened = page.waitForEvent("popup");
  await page.keyboard.press("Enter");
  const popup = await opened;
  const decline = popup.getByRole("link", { name: "Decline access" });
  await decline.waitFor();
  steps.push("provider displayed");
  let closedOnDismiss;
  async function dismiss() {
    await page.bringToFront();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    steps.push("directory closed");
    closedOnDismiss = popup.isClosed();
  }
  async function callback() {
    if (popup.isClosed()) {
      steps.push("original popup already closed");
      return;
    }
    await decline.click();
    await popup
      .getByRole("heading", { name: "Authorization declined" })
      .waitFor();
    steps.push("callback delivered");
  }
  if (order === "close-first") {
    await dismiss();
    await callback();
  } else {
    await callback();
    await dismiss();
  }
  return { steps, closedOnDismiss, finallyClosed: popup.isClosed() };
}
