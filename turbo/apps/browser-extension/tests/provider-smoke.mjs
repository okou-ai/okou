// Opt-in paid provider fixture. Never uses an existing Browser/profile or changes configuration.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, basename } from "node:path";
import { OkouBrowserClient } from "@okouai/browser-extension-client";
import { openWire, tabTargetForPage } from "./cdp.mjs";

if (!process.env.OKOU_BROWSER_USE_API_KEY)
  throw new Error("OKOU_BROWSER_USE_API_KEY is required");
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const archive = resolve(
  process.argv[2] ?? `artifacts/browser-extension-${pkg.version}.zip`,
);
const bytes = await readFile(archive);
const headers = {
  "X-Browser-Use-API-Key": process.env.OKOU_BROWSER_USE_API_KEY,
};
const receipt = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirty:
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
      .length > 0,
  archive: basename(archive),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  checks: [],
};
let uploadedId;
let browserId;
let wire;
const clients = [];
async function api(path, method = "GET", body) {
  const multipart = body instanceof FormData;
  const response = await fetch(`https://api.browser-use.com${path}`, {
    method,
    headers: {
      ...headers,
      ...(!multipart && body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    ...(body !== undefined
      ? { body: multipart ? body : JSON.stringify(body) }
      : {}),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new Error(`Provider ${method} ${path} failed (${response.status})`);
  return response.status === 204 ? null : await response.json();
}

// Native events drive readiness; reads may coalesce, with one explicit fixture deadline.
async function eventually(predicate) {
  return await new Promise((resolve, reject) => {
    let running = false;
    let again = false;
    let done = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      off();
    };
    const check = async () => {
      if (done) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const value = await predicate();
        if (value) {
          cleanup();
          resolve(value);
        }
      } catch (error) {
        cleanup();
        reject(error);
      } finally {
        running = false;
        if (again && !done) {
          again = false;
          void check();
        }
      }
    };
    const off = wire.onEvent(() => {
      return void check();
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Owned provider fixture readiness timed out"));
    }, 15000);
    void check();
  });
}

async function connect(runtimeId) {
  const client = await OkouBrowserClient.connect({
    transport: wire,
    runtimeId,
  });
  clients.push(client);
  return client;
}

try {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "application/zip" }),
    basename(archive),
  );
  const uploaded = await api("/api/v4/extensions", "POST", form);
  uploadedId = uploaded.id;
  assert.ok(uploadedId);
  receipt.uploadedExtensionId = uploadedId;
  console.log(
    JSON.stringify({
      phase: "uploaded",
      id: uploadedId,
      sha256: receipt.sha256,
    }),
  );
  const browser = await api("/api/v3/browsers", "POST", {
    timeout: 5,
    enableRecording: false,
    allowResizing: true,
    extensionIds: [uploadedId],
    metadata: { okouIssue: "43958", purpose: "owned-unified-extension-g1" },
  });
  browserId = browser.id;
  receipt.ownedBrowserId = browserId;
  const extension = browser.extensions.find((item) => {
    return item.id === uploadedId;
  });
  assert.ok(extension?.runtimeId);
  assert.equal(extension.version, pkg.version);
  receipt.runtimeId = extension.runtimeId;
  receipt.version = extension.version;
  let endpoint = browser.cdpUrl;
  if (endpoint.startsWith("https:")) {
    const response = await fetch(
      endpoint.replace(/\/$/, "") + "/json/version",
      { signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) throw new Error("Owned CDP discovery failed");
    endpoint = (await response.json()).webSocketDebuggerUrl;
  }
  wire = await openWire(endpoint);
  receipt.browserProduct = (await wire.request("Browser.getVersion")).product;
  const a = await connect(extension.runtimeId);
  const b = await connect(extension.runtimeId);
  const eventsA = [],
    eventsB = [];
  a.onEvent((event) => {
    return eventsA.push(event);
  });
  b.onEvent((event) => {
    return eventsB.push(event);
  });
  const initial = (await a.call("listWindows", { populate: true })).value;
  assert.equal(initial.length, 1);
  const leftId = initial[0].id;
  const root = await wire.request("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const rightId = (
    await wire.request("Browser.getWindowForTarget", {
      targetId: root.targetId,
    })
  ).windowId;
  assert.notEqual(leftId, rightId);
  const first = (
    await a.call("createTab", {
      windowId: leftId,
      url: "https://example.com",
      active: false,
    })
  ).value;
  const second = (
    await b.call("createTab", {
      windowId: rightId,
      url: "https://example.com",
      active: false,
    })
  ).value;
  await eventually(() => {
    return (
      eventsA.some((e) => {
        return e.tabId === first.id && e.kind === "tab-created";
      }) &&
      eventsB.some((e) => {
        return e.tabId === first.id && e.kind === "tab-created";
      })
    );
  });
  receipt.checks.push("two-client-event-fanout");
  const pages = await eventually(async () => {
    const result = await wire.request("Target.getTargets");
    const matches = result.targetInfos.filter((t) => {
      return t.type === "page" && t.url === "https://example.com/";
    });
    if (matches.length !== 2) return false;
    for (const target of matches) {
      const attached = await wire.request("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      try {
        const ready = await wire.request(
          "Runtime.evaluate",
          {
            expression: 'document.readyState === "complete"',
            returnByValue: true,
          },
          attached.sessionId,
        );
        if (!ready.result?.value) return false;
      } finally {
        await wire.request("Target.detachFromTarget", {
          sessionId: attached.sessionId,
        });
      }
    }
    return matches;
  });
  const identities = await Promise.all(
    pages.map((page) => {
      return a.identifyTarget(page.targetId);
    }),
  );
  assert.ok(identities.every(Boolean));
  assert.deepEqual(
    new Set(
      identities.map((id) => {
        return id.tabId;
      }),
    ),
    new Set([first.id, second.id]),
  );
  receipt.checks.push("duplicate-url-native-identities");
  assert.equal(await a.identifyTarget(root.targetId), null);
  receipt.checks.push("sourceless-blank-unavailable");
  await a.close();
  const moved = (
    await b.call("moveTabs", {
      tabIds: [first.id],
      windowId: rightId,
      index: -1,
    })
  ).value;
  assert.equal(moved[0].windowId, rightId);
  await b.call("activateTab", { tabId: first.id });
  const tabs = (await b.call("listTabs", { windowId: rightId })).value;
  assert.equal(
    tabs.find((tab) => {
      return tab.id === first.id;
    }).active,
    true,
  );
  await eventually(() => {
    return eventsB.some((e) => {
      return (
        e.tabId === first.id &&
        e.kind === "tab-attached" &&
        e.windowId === rightId
      );
    });
  });
  receipt.checks.push("independent-client-cleanup-and-intentional-move");
  const source = identities.find((id) => {
    return id.tabId === second.id;
  });
  receipt.phase = "action-parent-tab";
  const tabTarget = await tabTargetForPage(wire, source.targetId);
  const workerTarget = (
    await wire.request("Target.getTargets", { filter: [{ exclude: false }] })
  ).targetInfos.find((target) => {
    return (
      target.type === "service_worker" &&
      new URL(target.url).hostname === extension.runtimeId
    );
  });
  const observer = await wire.request("Target.attachToTarget", {
    targetId: workerTarget.targetId,
    flatten: true,
  });
  try {
    receipt.phase = "action-focus-observation";
    await wire.request(
      "Runtime.evaluate",
      {
        expression: `globalThis.fixtureActionTab = null; globalThis.fixtureActionListener = tab => { globalThis.fixtureActionTab = {tabId: tab.id, windowId: tab.windowId}; }; chrome.action.onClicked.addListener(globalThis.fixtureActionListener); chrome.windows.update(${leftId}, {focused: true})`,
        awaitPromise: true,
      },
      observer.sessionId,
    );
    // Headless Chromium can report both native windows as focused. Preserve the
    // observation rather than treating focus as page/active-tab identity.
    receipt.focusObservation = (await b.call("listWindows", {})).value.map(
      ({ id, focused }) => {
        return { id, focused };
      },
    );
    receipt.phase = "inactive-action-dispatch";
    await wire.request("Extensions.triggerAction", {
      id: extension.runtimeId,
      targetId: tabTarget,
    });
    const actionTab = await eventually(async () => {
      return (
        await wire.request(
          "Runtime.evaluate",
          { expression: "globalThis.fixtureActionTab", returnByValue: true },
          observer.sessionId,
        )
      ).result.value;
    });
    assert.deepEqual(actionTab, { tabId: first.id, windowId: rightId });
    assert.notEqual(actionTab.tabId, second.id);
    receipt.checks.push(
      "inactive-target-action-uses-containing-window-active-tab",
    );
  } finally {
    await wire.request(
      "Runtime.evaluate",
      {
        expression:
          "chrome.action.onClicked.removeListener(globalThis.fixtureActionListener); delete globalThis.fixtureActionListener; delete globalThis.fixtureActionTab",
      },
      observer.sessionId,
    );
    await wire.request("Target.detachFromTarget", {
      sessionId: observer.sessionId,
    });
  }
  const attached = await wire.request("Target.attachToTarget", {
    targetId: source.targetId,
    flatten: true,
  });
  try {
    receipt.phase = "navigation";
    const navigated = await wire.request(
      "Page.navigate",
      { url: "https://example.com/?okou-owned-navigation=43958" },
      attached.sessionId,
    );
    await eventually(async () => {
      const frame = (
        await wire.request("Page.getFrameTree", {}, attached.sessionId)
      ).frameTree.frame;
      const ready = (
        await wire.request(
          "Runtime.evaluate",
          {
            expression: 'document.readyState === "complete"',
            returnByValue: true,
          },
          attached.sessionId,
        )
      ).result.value;
      return frame.loaderId === navigated.loaderId && ready;
    });
    const replacement = await b.identifyTarget(source.targetId);
    assert.equal(replacement.tabId, source.tabId);
    assert.notEqual(replacement.loaderId, source.loaderId);
    receipt.checks.push("navigation-replaces-document-identity");
    const marker = `about:blank#okou-owned-popup-${crypto.randomUUID()}`;
    const popup = await wire.request(
      "Runtime.evaluate",
      {
        expression: `!!window.open(${JSON.stringify(marker)}, "_blank", "popup,width=320,height=240")`,
        returnByValue: true,
        userGesture: true,
      },
      attached.sessionId,
    );
    assert.equal(popup.result.value, true);
    await eventually(async () => {
      const { targetInfos } = await wire.request("Target.getTargets");
      const target = targetInfos.find((t) => {
        return t.type === "page" && t.url === marker;
      });
      return (
        target &&
        (
          await wire.request("Browser.getWindowForTarget", {
            targetId: target.targetId,
          })
        ).windowId === rightId
      );
    });
    receipt.checks.push("known-source-popup-consolidation");
  } finally {
    await wire.request("Target.detachFromTarget", {
      sessionId: attached.sessionId,
    });
  }
  await b.call("closeWindow", { windowId: rightId });
  await eventually(async () => {
    return (await b.call("getWindow", { windowId: rightId })).value === null;
  });
  assert.equal(
    (await b.call("getWindow", { windowId: leftId })).value.id,
    leftId,
  );
  receipt.checks.push("native-close-confirmation-and-sibling-preservation");
  const oldEpoch = (await b.call("hello", {})).epoch;
  const blankTarget = (
    await wire.request("Target.getTargets")
  ).targetInfos.find((t) => {
    return t.type === "page";
  });
  const control = await wire.request("Target.attachToTarget", {
    targetId: blankTarget.targetId,
    flatten: true,
  });
  try {
    await wire.request("ServiceWorker.enable", {}, control.sessionId);
    await wire.request("ServiceWorker.stopAllWorkers", {}, control.sessionId);
    await eventually(() => {
      return b.signal.aborted;
    });
    await b.close();
    const c = await connect(extension.runtimeId);
    assert.notEqual((await c.call("hello", {})).epoch, oldEpoch);
    assert.equal(
      (await c.call("getWindow", { windowId: leftId })).value.id,
      leftId,
    );
    receipt.checks.push(
      "worker-retirement-and-action-wake",
      "fresh-epoch-reconnect",
    );
  } finally {
    await wire.request("Target.detachFromTarget", {
      sessionId: control.sessionId,
    });
  }
  receipt.passed = true;
  delete receipt.phase;
} catch (error) {
  receipt.passed = false;
  console.error(
    JSON.stringify({
      phase: "fixture-failed",
      error: error.name,
      lastCompletedCheck: receipt.checks.at(-1) ?? "startup",
      fixtureStep: receipt.phase,
    }),
  );
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.close();
  wire?.close();
  if (browserId) {
    try {
      const stopped = await api(`/api/v3/browsers/${browserId}`, "PATCH", {
        action: "stop",
      });
      receipt.browserStopped = stopped.status === "stopped";
      assert.equal(stopped.status, "stopped");
    } catch {
      receipt.browserStopped = false;
      process.exitCode = 1;
    }
  }
  if (uploadedId) {
    try {
      await api(`/api/v4/extensions/${uploadedId}`, "DELETE");
      receipt.disposableUploadDeleted = true;
    } catch {
      receipt.disposableUploadDeleted = false;
      process.exitCode = 1;
    }
  }
  await mkdir("test-results/provider", { recursive: true });
  await writeFile(
    "test-results/provider/receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
}
