import assert from "node:assert/strict";

// browser-viewer-interaction-107. The relay withholds the acknowledgement after the remote
// Chromium has inserted the text. The client still writes to its real clipboard.
export async function verifyPendingCopy({
  page,
  remotePage,
  viewerUrl,
  holdNextTextAcknowledgement,
  observeReports,
}) {
  await page.addInitScript(() => {
    const receipts = { gestures: [], writes: [], alerts: [] };
    window.copyReceipts = receipts;
    document.addEventListener(
      "copy",
      (event) => {
        receipts.gestures.push({
          trusted: event.isTrusted,
          focused: document.activeElement?.getAttribute("aria-label"),
        });
      },
      true,
    );
    const write = Clipboard.prototype.write;
    Clipboard.prototype.write = function (items) {
      const receipt = {};
      receipts.writes.push(receipt);
      const result = write.call(this, items);
      result.then(
        () => {
          receipt.write = "fulfilled";
        },
        (error) => {
          receipt.writeError = error.name;
        },
      );
      items[0]
        .getType("text/plain")
        .then((blob) => blob.text())
        .then(
          (text) => {
            receipt.item = text;
          },
          (error) => {
            receipt.itemError = error.name;
          },
        );
      return result;
    };
    new MutationObserver(() => {
      for (const node of document.querySelectorAll(
        '[role="alert"], [role="status"]',
      )) {
        const text = node.innerText?.trim();
        if (text && !receipts.alerts.includes(text)) receipts.alerts.push(text);
      }
    }).observe(document, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });
  const input = page.getByLabel("Remote browser input", { exact: true });
  const canvas = page.getByRole("img", { name: "Live browser view" });
  await canvas.waitFor({ timeout: 90000 });
  await page.getByLabel("Browser settings").click();
  const size = page.getByText("Window size", { exact: true });
  await size.hover();
  await size.press("ArrowRight");
  await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();

  const finishReports = await observeReports(page);
  const observed = [];
  const editor = remotePage.locator("textarea");
  for (const blur of [true, false]) {
    await editor.fill("");
    await editor.focus();
    await page.bringToFront();
    await page.evaluate(() => navigator.clipboard.writeText("prior clipboard"));
    await canvas.click();
    await input.focus();
    const acknowledgement = holdNextTextAcknowledgement();
    await page.keyboard.insertText("ordered");
    const release = await acknowledgement;
    let pending;
    try {
      assert.equal(await editor.inputValue(), "ordered");
      await editor.evaluate((node) => node.select());
      await input.focus();
      await page.keyboard.press("Control+c");
      await page.waitForFunction(
        (index) => window.copyReceipts.writes.length > index,
        observed.length,
        { timeout: 5000 },
      );
      pending = await page.evaluate(() => ({
        ...window.copyReceipts.writes.at(-1),
      }));
      assert.deepEqual(pending, {});
      if (blur) await page.getByLabel("Address", { exact: true }).click();
    } finally {
      release();
    }
    await page.waitForFunction(() => {
      const receipt = window.copyReceipts.writes.at(-1);
      return (
        (receipt.write || receipt.writeError) &&
        (receipt.item || receipt.itemError)
      );
    });
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    await canvas.click();
    await input.focus();
    await page.keyboard.insertText("fresh");
    await remotePage.waitForFunction(
      () => document.querySelector("textarea").value === "orderedfresh",
    );
    const receipts = await page.evaluate(() => window.copyReceipts);
    const result = {
      blur,
      pending,
      clipboard,
      gesture: receipts.gestures.at(-1),
      write: receipts.writes.at(-1),
      alerts: receipts.alerts,
      remoteTitle: await remotePage.title(),
      remoteText: await editor.inputValue(),
      enabled: await input.isEnabled(),
    };
    assert.deepEqual(result.gesture, {
      trusted: true,
      focused: "Remote browser input",
    });
    assert.deepEqual(
      result.write,
      blur
        ? { writeError: "AbortError", itemError: "AbortError" }
        : { write: "fulfilled", item: "ordered" },
    );
    assert.equal(result.clipboard, blur ? "prior clipboard" : "ordered");
    assert.equal(result.remoteTitle, "Example");
    assert.equal(result.enabled, true);
    assert.doesNotMatch(result.alerts.join(" "), /copy|clipboard|failed/i);
    observed.push(result);
  }
  await finishReports();
  return observed;
}
