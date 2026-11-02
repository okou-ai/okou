import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { OkouBrowserClient } from "@okouai/browser-extension-client";
import { openWire, tabTargetForPage } from "./cdp.mjs";

let server;
let origin;
test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<!doctype html><title>Owned bridge fixture</title><p>Fixture</p>",
    );
  });
  await new Promise((resolve) => {
    return server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    return server.close((error) => {
      return error ? reject(error) : resolve();
    });
  });
});

async function fixture() {
  const parent = resolve("test-results/profiles");
  await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(resolve(parent, "bridge-"));
  const extension = resolve("dist");
  const owner = spawn(
    process.env.CHROMIUM_EXECUTABLE ?? chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-component-extensions-with-background-pages",
      "--enable-unsafe-extension-debugging",
      "--disable-popup-blocking",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const lines = createInterface({
    input: owner.stderr,
    signal: AbortSignal.timeout(10000),
  });
  let browser;
  let wire;
  const clients = [];
  async function close() {
    for (const client of clients) await client.close();
    wire?.close();
    await browser?.close();
    lines.close();
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, "exit");
      owner.kill("SIGTERM");
      await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
  try {
    let endpoint;
    for await (const line of lines) {
      const match = line.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        endpoint = match[1];
        break;
      }
    }
    if (!endpoint) throw new Error("Owned browser has no CDP endpoint");
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const worker =
      context.serviceWorkers().find((worker) => {
        return worker.url().endsWith("/background.js");
      }) ??
      (await context.waitForEvent("serviceworker", {
        predicate: (worker) => {
          return worker.url().endsWith("/background.js");
        },
      }));
    expect(
      await worker.evaluate(() => {
        return chrome.runtime.getManifest().name;
      }),
    ).toBe("Okou Browser");
    const runtimeId = new URL(worker.url()).hostname;
    wire = await openWire(endpoint);
    return {
      context,
      worker,
      wire,
      runtimeId,
      async client() {
        const client = await OkouBrowserClient.connect({
          transport: wire,
          runtimeId,
        });
        clients.push(client);
        return client;
      },
      async window(url) {
        return await worker.evaluate((url) => {
          return chrome.windows.create({ url, focused: false });
        }, url);
      },
      async target(page) {
        const session = await context.newCDPSession(page);
        try {
          return (await session.send("Target.getTargetInfo")).targetInfo
            .targetId;
        } finally {
          await session.detach();
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test("native window operations and event subscriptions preserve independent clients and siblings", async () => {
  const f = await fixture();
  try {
    const a = await f.client();
    const b = await f.client();
    const eventsA = [],
      eventsB = [];
    a.onEvent((event) => {
      return eventsA.push(event);
    });
    b.onEvent((event) => {
      return eventsB.push(event);
    });
    const left = await f.window(`${origin}/left`);
    const right = await f.window(`${origin}/right`);
    const created = (
      await a.call("createTab", {
        windowId: left.id,
        url: `${origin}/created`,
        active: false,
      })
    ).value;
    expect(created.windowId).toBe(left.id);
    expect(created.active).toBe(false);
    await expect
      .poll(() => {
        return eventsA.some((e) => {
          return e.kind === "tab-created" && e.tabId === created.id;
        });
      })
      .toBe(true);
    await expect
      .poll(() => {
        return eventsB.some((e) => {
          return e.kind === "tab-created" && e.tabId === created.id;
        });
      })
      .toBe(true);
    const moved = (
      await a.call("moveTabs", {
        tabIds: [created.id],
        windowId: right.id,
        index: -1,
      })
    ).value;
    expect(moved[0].windowId).toBe(right.id);
    await expect
      .poll(() => {
        return eventsB.some((e) => {
          return (
            e.kind === "tab-attached" &&
            e.tabId === created.id &&
            e.windowId === right.id
          );
        });
      })
      .toBe(true);
    await a.close();
    const activated = (await b.call("activateTab", { tabId: created.id }))
      .value;
    expect(activated.active).toBe(true);
    await expect
      .poll(() => {
        return eventsB.some((e) => {
          return e.kind === "tab-activated" && e.tabId === created.id;
        });
      })
      .toBe(true);
    const current = await b.call("getWindow", {
      windowId: right.id,
      populate: true,
    });
    expect(
      current.value.tabs.find((tab) => {
        return tab.id === created.id;
      }).active,
    ).toBe(true);
    expect(current.sequence).toBeGreaterThanOrEqual(current.startedSequence);
    await b.call("closeWindow", { windowId: left.id });
    await expect
      .poll(async () => {
        return (await b.call("getWindow", { windowId: left.id })).value;
      })
      .toBeNull();
    expect((await b.call("getWindow", { windowId: right.id })).value.id).toBe(
      right.id,
    );
    await b.close();
    expect(f.wire.listeners.size).toBe(0);
    expect(
      await f.worker.evaluate((id) => {
        return chrome.windows.get(id);
      }, right.id),
    ).toHaveProperty("id", right.id);
  } finally {
    await f.close();
  }
});

test("events overtaking the hello response establish a contiguous fresh baseline", async () => {
  const f = await fixture();
  const captured = Promise.withResolvers();
  const release = Promise.withResolvers();
  let client;
  try {
    let held = false;
    const connecting = OkouBrowserClient.connect({
      runtimeId: f.runtimeId,
      transport: {
        onEvent: (listener) => {
          return f.wire.onEvent(listener);
        },
        async request(method, params, sessionId) {
          const value = await f.wire.request(method, params, sessionId);
          if (
            !held &&
            method === "Runtime.evaluate" &&
            params.expression?.includes('"method":"hello"')
          ) {
            held = true;
            captured.resolve();
            await release.promise;
          }
          return value;
        },
      },
    });
    await captured.promise;
    await f.worker.evaluate(async () => {
      await chrome.tabs.create({ url: "about:blank" });
    });
    release.resolve();
    client = await connecting;
    const events = [];
    client.onEvent((event) => {
      return events.push(event);
    });
    const created = (await client.call("createTab", { url: "about:blank" }))
      .value;
    expect(created.id).toBeGreaterThan(0);
    expect(client.signal.aborted).toBe(false);
    expect(
      events.some((event) => {
        return event.kind === "tab-created" && event.tabId === created.id;
      }),
    ).toBe(true);
  } finally {
    release.resolve();
    await client?.close();
    await f.close();
  }
});

test("native tab observations retain an uncommitted navigation destination", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers();
  let held;
  const pending = createServer((_request, response) => {
    held = response;
    entered.resolve();
  });
  try {
    await new Promise((resolve) => {
      return pending.listen(0, "127.0.0.1", resolve);
    });
    const client = await f.client();
    const created = (await client.call("createTab", { url: "about:blank" }))
      .value;
    const destination = `http://127.0.0.1:${pending.address().port}/pending`;
    await f.worker.evaluate(
      ({ tabId, url }) => {
        return chrome.tabs.update(tabId, { url });
      },
      { tabId: created.id, url: destination },
    );
    await entered.promise;
    const observed = (await client.call("getTab", { tabId: created.id })).value;
    expect(observed.pendingUrl).toBe(destination);
    expect(observed.url).not.toBe(destination);
  } finally {
    held?.end("<!doctype html><title>Completed</title>");
    pending.closeAllConnections();
    await new Promise((resolve) => {
      return pending.close(resolve);
    });
    await f.close();
  }
});

test("a missing binding event retires only its client without mutation replay", async () => {
  const f = await fixture();
  let client;
  try {
    const sibling = await f.client();
    let drop = false;
    let ownedWorker;
    client = await OkouBrowserClient.connect({
      runtimeId: f.runtimeId,
      transport: {
        async request(...args) {
          const value = await f.wire.request(...args);
          if (args[0] === "Target.attachToTarget")
            ownedWorker = value.sessionId;
          return value;
        },
        onEvent: (listener) => {
          return f.wire.onEvent((event) => {
            if (
              drop &&
              event.method === "Runtime.bindingCalled" &&
              event.sessionId === ownedWorker
            ) {
              drop = false;
              return;
            }
            listener(event);
          });
        },
      },
    });
    drop = true;
    await f.worker.evaluate(async () => {
      await chrome.tabs.create({ url: "about:blank" });
      await chrome.tabs.create({ url: "about:blank" });
    });
    await expect
      .poll(() => {
        return client.signal.aborted;
      })
      .toBe(true);
    expect((await sibling.call("hello", {})).value.protocol).toBe(1);
  } finally {
    await client?.close();
    await f.close();
  }
});

test("a failed native response cannot conceal a missing event sequence", async () => {
  const f = await fixture();
  let client;
  try {
    let corrupt = false;
    client = await OkouBrowserClient.connect({
      runtimeId: f.runtimeId,
      transport: {
        onEvent: (listener) => {
          return f.wire.onEvent(listener);
        },
        async request(method, params, sessionId) {
          const result = await f.wire.request(method, params, sessionId);
          if (corrupt && method === "Runtime.evaluate") {
            result.result.value.sequence += 1000000;
          }
          return result;
        },
      },
    });
    corrupt = true;
    await expect(
      client.call("closeWindow", { windowId: 1073741824 }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(client.signal.aborted).toBe(true);
  } finally {
    await client?.close();
    await f.close();
  }
});

test("one-shot native evidence distinguishes duplicate URLs and rejects webpage control", async () => {
  const f = await fixture();
  try {
    const a = await f.client();
    const b = await f.client();
    const left = await f.window(`${origin}/duplicate`);
    const right = await f.window(`${origin}/duplicate`);
    await expect
      .poll(() => {
        return f.context.pages().filter((p) => {
          return p.url() === `${origin}/duplicate`;
        }).length;
      })
      .toBe(2);
    const pages = f.context.pages().filter((p) => {
      return p.url() === `${origin}/duplicate`;
    });
    await Promise.all(
      pages.map((p) => {
        return p.waitForLoadState();
      }),
    );
    const targets = await Promise.all(
      pages.map((p) => {
        return f.target(p);
      }),
    );
    const ids = await Promise.all([
      a.identifyTarget(targets[0]),
      b.identifyTarget(targets[1]),
    ]);
    expect(ids.every(Boolean)).toBe(true);
    expect(
      new Set(
        ids.map((id) => {
          return id.tabId;
        }),
      ),
    ).toEqual(new Set([left.tabs[0].id, right.tabs[0].id]));
    for (const id of ids)
      expect((await a.call("getTab", { tabId: id.tabId })).value.windowId).toBe(
        id.windowId,
      );
    await pages[0].evaluate(() => {
      chrome.runtime.sendMessage = (_id, _message, callback) => {
        return callback();
      };
    });
    expect(await a.identifyTarget(targets[0])).toBeNull();
    const before = ids[0];
    await pages[0].goto(`${origin}/navigated`);
    const after = await a.identifyTarget(await f.target(pages[0]));
    expect(after.tabId).toBe(before.tabId);
    expect(after.loaderId).not.toBe(before.loaderId);
    const blank = await f.context.newPage();
    expect(await a.identifyTarget(await f.target(blank))).toBeNull();
    await pages[0].evaluate(
      ({ runtimeId, windowId }) => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage(
            runtimeId,
            { method: "closeWindow", windowId },
            () => {
              void chrome.runtime.lastError;
              resolve();
            },
          );
        });
      },
      { runtimeId: f.runtimeId, windowId: right.id },
    );
    expect((await a.call("getWindow", { windowId: right.id })).value.id).toBe(
      right.id,
    );
  } finally {
    await f.close();
  }
});

test("worker retirement invalidates clients and action bootstrap obtains a fresh epoch", async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    const epoch = (await client.call("hello", {})).epoch;
    const actionCount = f.wire.commands.filter((c) => {
      return c.method === "Extensions.triggerAction";
    }).length;
    const page = f.context.pages()[0];
    const cdp = await f.context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await expect
      .poll(() => {
        return client.signal.aborted;
      })
      .toBe(true);
    const next = await f.client();
    expect((await next.call("hello", {})).epoch).not.toBe(epoch);
    expect(
      f.wire.commands.filter((c) => {
        return c.method === "Extensions.triggerAction";
      }).length,
    ).toBeGreaterThan(actionCount);
    await cdp.detach();
  } finally {
    await f.close();
  }
});

async function pauseWorkerRestart(f, client) {
  const { targetInfos } = await f.wire.request("Target.getTargets");
  const worker = targetInfos.find((target) => {
    return (
      target.type === "service_worker" &&
      new URL(target.url).hostname === f.runtimeId
    );
  });
  const { sessionId } = await f.wire.request("Target.attachToTarget", {
    targetId: worker.targetId,
    flatten: true,
  });
  const paused = Promise.withResolvers();
  let suspended = false;
  const off = f.wire.onEvent((event) => {
    if (event.sessionId === sessionId && event.method === "Debugger.paused") {
      suspended = true;
      paused.resolve(event.params.callFrames[0].callFrameId);
      off();
    }
  });
  const cdp = await f.context.newCDPSession(f.context.pages()[0]);
  await cdp.send("ServiceWorker.enable");
  const invalidated = new Promise((resolve) => {
    client.signal.addEventListener("abort", resolve, { once: true });
  });
  await cdp.send("ServiceWorker.stopAllWorkers");
  await invalidated;
  // The retained inspector queues these commands for the new worker context.
  // Nothing in the extension source or its Runtime responses is substituted.
  const armed = Promise.all([
    f.wire.request("Debugger.enable", {}, sessionId),
    f.wire.request(
      "Debugger.setBreakpointByUrl",
      { lineNumber: 0, url: worker.url },
      sessionId,
    ),
  ]);
  const ready = Promise.all([paused.promise, armed]).then(([frame]) => {
    return frame;
  });
  async function resume() {
    if (!suspended) return;
    suspended = false;
    await f.wire.request("Debugger.resume", {}, sessionId);
  }
  return {
    ready,
    async bridgeType(frame) {
      const result = await f.wire.request(
        "Debugger.evaluateOnCallFrame",
        {
          callFrameId: frame,
          expression: "typeof globalThis.__okouBrowser",
          returnByValue: true,
        },
        sessionId,
      );
      return result.result.value;
    },
    resume,
    async close() {
      off();
      await resume();
      await cdp.detach();
      await f.wire.request("Target.detachFromTarget", { sessionId });
    },
  };
}

for (const completion of ["resume", "abort", "timeout", "observer-loss"]) {
  test(`a fresh client owns pending native worker startup until ${completion}`, async () => {
    const f = await fixture();
    const owner = new AbortController();
    let startup;
    let connecting;
    let next;
    try {
      const previous = await f.client();
      const epoch = (await previous.call("hello", {})).epoch;
      const window = (await previous.call("listWindows", {})).value[0];
      startup = await pauseWorkerRestart(f, previous);
      const observing = Promise.withResolvers();
      const hello = Promise.withResolvers();
      let browserSession;
      let readinessSession;
      let running = false;
      let helloCount = 0;
      let prematureHello = false;
      connecting = OkouBrowserClient.connect({
        runtimeId: f.runtimeId,
        signal: owner.signal,
        ...(completion === "timeout" ? { readinessTimeoutMs: 500 } : {}),
        transport: {
          onEvent(listener) {
            return f.wire.onEvent((event) => {
              if (
                event.sessionId === readinessSession &&
                event.method === "ServiceWorker.workerVersionUpdated"
              ) {
                for (const version of event.params.versions) {
                  if (new URL(version.scriptURL).hostname === f.runtimeId)
                    running = version.runningStatus === "running";
                }
              }
              listener(event);
            });
          },
          async request(method, params, sessionId) {
            const response = f.wire.request(method, params, sessionId);
            if (method === "ServiceWorker.enable") {
              readinessSession = sessionId;
              observing.resolve("observing");
            }
            if (method === "Runtime.evaluate") {
              helloCount++;
              prematureHello ||= !running;
              hello.resolve("hello");
            }
            const value = await response;
            if (method === "Target.attachToBrowserTarget")
              browserSession = value.sessionId;
            return value;
          },
        },
      });
      // Observe rejection immediately while the native startup gate is held.
      void connecting.catch(() => {});
      const frame = await startup.ready;
      expect(await startup.bridgeType(frame)).toBe("undefined");
      expect(await Promise.race([observing.promise, hello.promise])).toBe(
        "observing",
      );
      if (completion === "resume") {
        await startup.resume();
        next = await connecting;
        expect(helloCount).toBe(1);
        expect(prematureHello).toBe(false);
        expect((await next.call("hello", {})).epoch).not.toBe(epoch);
        expect(
          (await next.call("getWindow", { windowId: window.id })).value.id,
        ).toBe(window.id);
        await next.close();
        expect(f.wire.listeners.size).toBe(0);
      } else {
        if (completion === "abort") owner.abort();
        if (completion === "observer-loss") {
          await f.wire.request(
            "Target.detachFromTarget",
            { sessionId: readinessSession },
            browserSession,
          );
        }
        await expect(connecting).rejects.toHaveProperty("kind", "unavailable");
        expect(helloCount).toBe(0);
        expect(f.wire.listeners.size).toBe(0);
        await startup.resume();
        next = await f.client();
        expect(
          (await next.call("getWindow", { windowId: window.id })).value.id,
        ).toBe(window.id);
      }
    } finally {
      owner.abort();
      await startup?.close();
      await connecting?.then(
        (client) => {
          return client.close();
        },
        () => {},
      );
      await next?.close();
      await f.close();
    }
  });
}

test("navigation during correlation rejects stale evidence; a lost close reply is never replayed", async () => {
  const f = await fixture();
  let guarded;
  try {
    const client = await f.client();
    const left = await f.window(`${origin}/source`);
    const right = await f.window(`${origin}/sibling`);
    await expect
      .poll(() => {
        return f.context.pages().some((p) => {
          return p.url() === `${origin}/source`;
        });
      })
      .toBe(true);
    const page = f.context.pages().find((p) => {
      return p.url() === `${origin}/source`;
    });
    await page.waitForLoadState();
    let closeCalls = 0;
    let replaced = false;
    guarded = await OkouBrowserClient.connect({
      runtimeId: f.runtimeId,
      transport: {
        onEvent: f.wire.onEvent,
        async request(method, params, sessionId) {
          const response = await f.wire.request(method, params, sessionId);
          if (
            method === "Runtime.evaluate" &&
            params.expression?.includes('kind: "okou-browser-identify"') &&
            !replaced
          ) {
            replaced = true;
            await page.goto(`${origin}/replacement`);
          }
          if (
            method === "Runtime.evaluate" &&
            params.expression?.includes('"method":"closeWindow"')
          ) {
            closeCalls++;
            throw new Error("Synthetic lost native reply");
          }
          return response;
        },
      },
    });
    expect(await guarded.identifyTarget(await f.target(page))).toBeNull();
    expect(replaced).toBe(true);
    await expect(
      guarded.call("closeWindow", { windowId: left.id }),
    ).rejects.toHaveProperty("kind", "native");
    expect(closeCalls).toBe(1);
    await expect
      .poll(async () => {
        return (await client.call("getWindow", { windowId: left.id })).value;
      })
      .toBeNull();
    expect(
      (await client.call("getWindow", { windowId: right.id })).value.id,
    ).toBe(right.id);
  } finally {
    await guarded?.close();
    await f.close();
  }
});

test("an invalidation after native snapshot completion supersedes its delayed reply", async () => {
  const f = await fixture();
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reader;
  try {
    const writer = await f.client();
    const window = await f.window(`${origin}/snapshot`);
    reader = await OkouBrowserClient.connect({
      runtimeId: f.runtimeId,
      transport: {
        onEvent: f.wire.onEvent,
        async request(method, params, sessionId) {
          const response = await f.wire.request(method, params, sessionId);
          if (
            method === "Runtime.evaluate" &&
            params.expression?.includes('"method":"getWindow"')
          ) {
            arrived.resolve(response.result.value);
            await release.promise;
          }
          return response;
        },
      },
    });
    const events = [];
    reader.onEvent((event) => {
      return events.push(event);
    });
    const pending = reader.call("getWindow", {
      windowId: window.id,
      populate: true,
    });
    const held = await arrived.promise;
    const created = (
      await writer.call("createTab", {
        windowId: window.id,
        url: `${origin}/newer`,
      })
    ).value;
    await expect
      .poll(() => {
        return events.some((event) => {
          return event.tabId === created.id;
        });
      })
      .toBe(true);
    release.resolve();
    const snapshot = await pending;
    expect(
      snapshot.value.tabs.some((tab) => {
        return tab.id === created.id;
      }),
    ).toBe(false);
    expect(snapshot.epoch).toBe(events[0].epoch);
    expect(
      events.some((event) => {
        return event.sequence > held.sequence;
      }),
    ).toBe(true);
    expect(snapshot.sequence).toBe(held.sequence);
  } finally {
    release.resolve();
    await reader?.close();
    await f.close();
  }
});

test("action on an inactive tab target receives its containing window's active tab", async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    const window = await f.window(`${origin}/inactive`);
    const active = (
      await client.call("createTab", {
        windowId: window.id,
        url: `${origin}/active`,
      })
    ).value;
    await expect
      .poll(() => {
        return f.context.pages().some((p) => {
          return p.url() === `${origin}/inactive`;
        });
      })
      .toBe(true);
    const page = f.context.pages().find((p) => {
      return p.url() === `${origin}/inactive`;
    });
    const targetId = await tabTargetForPage(f.wire, await f.target(page));
    await f.worker.evaluate(() => {
      globalThis.fixtureActionTab = null;
      chrome.action.onClicked.addListener((tab) => {
        globalThis.fixtureActionTab = { tabId: tab.id, windowId: tab.windowId };
      });
    });
    await f.wire.request("Extensions.triggerAction", {
      id: f.runtimeId,
      targetId,
    });
    await expect
      .poll(() => {
        return f.worker.evaluate(() => {
          return globalThis.fixtureActionTab;
        });
      })
      .toEqual({ tabId: active.id, windowId: window.id });
  } finally {
    await f.close();
  }
});

test("reentrant close waits for the pending native teardown", async () => {
  const f = await fixture();
  const cleanupStarted = Promise.withResolvers();
  const releaseCleanup = Promise.withResolvers();
  let client;
  let reentered;
  try {
    client = await OkouBrowserClient.connect({
      runtimeId: f.runtimeId,
      transport: {
        onEvent: f.wire.onEvent,
        async request(method, params, sessionId) {
          const response = await f.wire.request(method, params, sessionId);
          if (method === "Runtime.removeBinding") {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          }
          return response;
        },
      },
    });
    client.signal.addEventListener("abort", () => {
      reentered = client.close();
    });
    const closing = client.close();
    const first = await Promise.race([
      closing.then(() => {
        return "closed";
      }),
      cleanupStarted.promise.then(() => {
        return "cleanup-pending";
      }),
    ]);
    expect(first).toBe("cleanup-pending");
    releaseCleanup.resolve();
    await Promise.all([closing, reentered]);
    expect(f.wire.listeners.size).toBe(0);
    expect(
      (await f.wire.request("Target.getTargets")).targetInfos.length,
    ).toBeGreaterThan(0);
  } finally {
    releaseCleanup.resolve();
    await reentered;
    await client?.close();
    await f.close();
  }
});

test("abort during worker setup does not register a binding on the caller session", async () => {
  const f = await fixture();
  const enabled = Promise.withResolvers();
  const releaseEnable = Promise.withResolvers();
  const owner = new AbortController();
  const bindings = [];
  let connecting;
  try {
    connecting = OkouBrowserClient.connect({
      runtimeId: f.runtimeId,
      signal: owner.signal,
      transport: {
        onEvent: f.wire.onEvent,
        async request(method, params, sessionId) {
          if (method === "Runtime.addBinding") bindings.push(sessionId);
          const response = await f.wire.request(method, params, sessionId);
          if (method === "Runtime.enable") {
            enabled.resolve();
            await releaseEnable.promise;
          }
          return response;
        },
      },
    });
    await enabled.promise;
    owner.abort();
    releaseEnable.resolve();
    await expect(connecting).rejects.toHaveProperty("kind", "unavailable");
    expect(bindings).toHaveLength(0);
    expect(f.wire.listeners.size).toBe(0);
  } finally {
    owner.abort();
    releaseEnable.resolve();
    await connecting?.catch(() => {});
    await f.close();
  }
});

test("losing the owned browser session retires only that client", async () => {
  const f = await fixture();
  let client;
  let browserSession;
  try {
    const sibling = await f.client();
    client = await OkouBrowserClient.connect({
      runtimeId: f.runtimeId,
      transport: {
        onEvent: f.wire.onEvent,
        async request(method, params, sessionId) {
          const response = await f.wire.request(method, params, sessionId);
          if (method === "Target.attachToBrowserTarget")
            browserSession = response.sessionId;
          return response;
        },
      },
    });
    await f.wire.request("Target.detachFromTarget", {
      sessionId: browserSession,
    });
    await expect
      .poll(() => {
        return client.signal.aborted;
      })
      .toBe(true);
    await client.close();
    expect(
      (await sibling.call("listWindows", {})).value.length,
    ).toBeGreaterThan(0);
  } finally {
    await client?.close();
    await f.close();
  }
});

test("resubscribing from an event observer does not redeliver the same event", async () => {
  const f = await fixture();
  let off;
  try {
    const client = await f.client();
    const window = await f.window(`${origin}/resubscribe`);
    const events = [];
    const listener = (event) => {
      if (event.kind !== "tab-created") return;
      events.push(event);
      if (events.length === 1) {
        off();
        off = client.onEvent(listener);
      }
    };
    off = client.onEvent(listener);
    const created = (
      await client.call("createTab", {
        windowId: window.id,
        url: `${origin}/event`,
      })
    ).value;
    await expect
      .poll(() => {
        return events.some((event) => {
          return event.tabId === created.id;
        });
      })
      .toBe(true);
    expect(
      events.filter((event) => {
        return event.tabId === created.id;
      }),
    ).toHaveLength(1);
  } finally {
    off?.();
    await f.close();
  }
});
