import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { setTimeout, clearTimeout } from "node:timers";
import { promisify } from "node:util";
import { openWire } from "../../browser-extension/tests/cdp.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const profile = await mkdtemp(resolve(tmpdir(), "okou-browser-proxy-smoke-"));
const extension = resolve(root, "turbo/apps/browser-extension/dist");
const worker = resolve(root, "turbo/apps/cli/dist/browser-proxy-worker.js");
const children = [];
const wires = [];
const sessions = [];
let browser;
let browserClosed;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<!doctype html><title>Proxy fixture</title><input id="text" style="position:absolute;left:10px;top:10px"><button onclick="window.open('/popup')">Popup</button><p>${request.url}</p>`,
  );
});

async function wire(endpoint) {
  const value = await openWire(endpoint);
  wires.push(value);
  return value;
}

function observe(wire, predicate, operation) {
  let off;
  const observed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off?.();
      reject(new Error("Fixture event deadline exceeded"));
    }, 15000);
    off = wire.onEvent((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
  });
  return Promise.all([observed, operation()]).then(([event]) => {
    return event;
  });
}

async function proxy(endpoint, runtimeId, windowId) {
  const managed = process.argv.includes("--guest-task");
  const child = managed
    ? spawn(
        "/usr/local/bin/guest-task-exec",
        ["--report-fd", "3", "--", process.execPath, worker],
        {
          detached: true,
          stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"],
        },
      )
    : spawn(process.execPath, [worker], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
  const closed = once(child, "close");
  children.push({ child, closed });
  const admission = managed
    ? (async () => {
        let report = "";
        for await (const chunk of child.stdio[3]) report += chunk;
        const value = JSON.parse(report);
        assert.equal(value.pid, child.pid);
        assert.match(value.handle, /^[0-9a-f-]{36}$/u);
      })()
    : Promise.resolve();
  // Observe admission while the application readiness message is in flight.
  const admitted = admission.then(
    () => {
      return { ok: true };
    },
    (error) => {
      return { error };
    },
  );
  const start = performance.now();
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      return reject(new Error("Proxy startup deadline exceeded"));
    }, 20000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Proxy startup exit ${code}`));
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message.endpoint) resolve(message.endpoint);
      else reject(new Error("Proxy startup failed"));
    });
    child.send({ cdpUrl: endpoint, runtimeId, windowId });
  });
  const result = await admitted;
  if (result.error) throw result.error;
  return { endpoint: ready, child, setupMs: performance.now() - start };
}

async function pageSession(wire, targetId) {
  return (
    await wire.request("Target.attachToTarget", { targetId, flatten: true })
  ).sessionId;
}
async function value(wire, sessionId, expression) {
  return (
    await wire.request(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )
  ).result.value;
}
async function pages(wire) {
  return (await wire.request("Target.getTargets")).targetInfos.filter(
    (info) => {
      return info.type === "page";
    },
  );
}

try {
  await new Promise((resolve) => {
    return server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(
    process.env.CHROMIUM_EXECUTABLE ?? "/usr/bin/chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
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
  browserClosed = once(browser, "close");
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      return reject(new Error("Chrome startup deadline exceeded"));
    }, 15000);
    browser.stderr.on("data", (data) => {
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(String(data));
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    browser.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Fixture Chrome exited"));
    });
  });
  const direct = await wire(endpoint);
  let installed = (
    await direct.request("Target.getTargets", { filter: [{}] })
  ).targetInfos.find((info) => {
    return (
      info.type === "service_worker" && info.url.endsWith("/background.js")
    );
  });
  if (!installed)
    installed = (
      await observe(
        direct,
        (event) => {
          return (
            event.method === "Target.targetCreated" &&
            event.params.targetInfo.url.endsWith("/background.js")
          );
        },
        () => {
          return direct.request("Target.setDiscoverTargets", {
            discover: true,
            filter: [{}],
          });
        },
      )
    ).params.targetInfo;
  const runtimeId = new URL(installed.url).hostname;
  const a = (
    await direct.request("Target.createTarget", {
      url: origin + "/a",
      newWindow: true,
    })
  ).targetId;
  const b = (
    await direct.request("Target.createTarget", {
      url: origin + "/b",
      newWindow: true,
    })
  ).targetId;
  const winA = (
    await direct.request("Browser.getWindowForTarget", { targetId: a })
  ).windowId;
  const winB = (
    await direct.request("Browser.getWindowForTarget", { targetId: b })
  ).windowId;
  assert.notEqual(winA, winB);
  const proxyA = await proxy(endpoint, runtimeId, winA);
  const proxyB = await proxy(endpoint, runtimeId, winB);
  const scopedA = await wire(proxyA.endpoint);
  const scopedB = await wire(proxyB.endpoint);
  assert.deepEqual(
    (await pages(scopedA)).map((page) => {
      return page.targetId;
    }),
    [a],
  );
  assert.deepEqual(
    (await pages(scopedB)).map((page) => {
      return page.targetId;
    }),
    [b],
  );
  const sa = await pageSession(scopedA, a);
  const sb = await pageSession(scopedB, b);
  await value(scopedA, sa, "localStorage.setItem('proxy-fixture','shared')");
  assert.equal(
    await value(scopedB, sb, "localStorage.getItem('proxy-fixture')"),
    "shared",
  );
  await scopedA.request("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  const created = await scopedA.request("Target.createTarget", {
    url: "about:blank",
  });
  assert.equal(
    (
      await direct.request("Browser.getWindowForTarget", {
        targetId: created.targetId,
      })
    ).windowId,
    winA,
  );
  const createdTab = await scopedA.request("Target.createTarget", {
    url: origin + "/new",
    forTab: true,
  });
  assert.equal(
    (
      await direct.request("Browser.getWindowForTarget", {
        targetId: createdTab.targetId,
      })
    ).windowId,
    winA,
  );
  assert.deepEqual(
    (await pages(scopedB)).map((page) => {
      return page.targetId;
    }),
    [b],
  );
  const nested = await scopedA.request("Target.attachToTarget", {
    targetId: a,
    flatten: false,
  });
  const nestedReply = await observe(
    scopedA,
    (event) => {
      return (
        event.method === "Target.receivedMessageFromTarget" &&
        event.params.sessionId === nested.sessionId &&
        JSON.parse(event.params.message).id === 93
      );
    },
    () => {
      return scopedA.request("Target.sendMessageToTarget", {
        sessionId: nested.sessionId,
        message: JSON.stringify({
          id: 93,
          method: "Runtime.evaluate",
          params: { expression: "2+2", returnByValue: true },
        }),
      });
    },
  );
  assert.equal(JSON.parse(nestedReply.params.message).result.result.value, 4);
  const input = async (wire, sessionId, composition) => {
    await value(
      wire,
      sessionId,
      "document.querySelector('#text').value='';document.querySelector('#text').focus()",
    );
    const start = performance.now();
    if (composition)
      await wire.request(
        "Input.imeSetComposition",
        { text: "中文", selectionStart: 2, selectionEnd: 2 },
        sessionId,
      );
    await wire.request(
      "Input.insertText",
      { text: composition ? "中文" : "hello" },
      sessionId,
    );
    assert.equal(
      await value(wire, sessionId, "document.querySelector('#text').value"),
      composition ? "中文" : "hello",
    );
    return performance.now() - start;
  };
  const directA = await pageSession(direct, a);
  const metrics = { direct: {}, proxy: {} };
  const transports = [
    ["direct", direct, directA],
    ["proxy", scopedA, sa],
  ];
  for (const composition of [false, true]) {
    const measured = { direct: [], proxy: [] };
    const first = {};
    for (let i = 0; i < 50; i++) {
      // Alternate order after paired warmups to avoid attributing warmup to proxy cost.
      for (const [name, transport, session] of i % 2
        ? [...transports].reverse()
        : transports) {
        const elapsed = await input(transport, session, composition);
        if (i === 0) first[name] = elapsed;
        if (i >= 10) measured[name].push(elapsed);
      }
    }
    for (const name of ["direct", "proxy"]) {
      const samples = measured[name];
      samples.sort((left, right) => {
        return left - right;
      });
      metrics[name][composition ? "composition" : "insert"] = {
        samples: 40,
        first: first[name],
        p50: samples[19],
        p95: samples[37],
      };
    }
  }
  const continuous = { direct: [], proxy: [] };
  for (const [, transport, session] of transports)
    await value(
      transport,
      session,
      "document.querySelector('#text').value='';document.querySelector('#text').focus()",
    );
  for (let i = 0; i < 40; i++) {
    for (const [name, transport, session] of i % 2
      ? [...transports].reverse()
      : transports) {
      // Each transport uses the same document, so reset to the expected prefix.
      await value(
        transport,
        session,
        "document.querySelector('#text').value=" +
          JSON.stringify("x".repeat(i)),
      );
      const start = performance.now();
      await transport.request("Input.insertText", { text: "x" }, session);
      assert.equal(
        await value(
          transport,
          session,
          "document.querySelector('#text').value",
        ),
        "x".repeat(i + 1),
      );
      continuous[name].push(performance.now() - start);
    }
  }
  for (const name of ["direct", "proxy"]) {
    const samples = continuous[name].sort((left, right) => {
      return left - right;
    });
    metrics[name].continuous = {
      samples: 40,
      p50: samples[19],
      p95: samples[37],
    };
  }
  for (const [suffix, connection] of [
    ["a", proxyA],
    ["b", proxyB],
  ]) {
    const session = `proxy-smoke-${process.pid}-${suffix}`;
    sessions.push(session);
    await run(
      "agent-browser",
      ["--session", session, "--no-pin-tab", "connect", connection.endpoint],
      { timeout: 15000 },
    );
    await run(
      "agent-browser",
      [
        "--session",
        session,
        "eval",
        "document.querySelector('#text').value='driver'",
      ],
      { timeout: 15000 },
    );
  }
  await scopedA.request("Target.setAutoAttach", {
    autoAttach: false,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await scopedA.request("Target.setDiscoverTargets", { discover: true });
  const popup = await observe(
    scopedA,
    (event) => {
      return (
        ["Target.targetCreated", "Target.targetInfoChanged"].includes(
          event.method,
        ) && event.params.targetInfo.url === origin + "/popup"
      );
    },
    () => {
      return value(scopedA, sa, "window.open('/popup');true");
    },
  );
  assert.equal(
    (
      await direct.request("Browser.getWindowForTarget", {
        targetId: popup.params.targetInfo.targetId,
      })
    ).windowId,
    winA,
  );
  assert.equal((await pages(scopedB)).length, 1);

  const extensionSession = await pageSession(direct, installed.targetId);
  const invoke = async (request) => {
    const result = await value(
      direct,
      extensionSession,
      `globalThis.__okouBrowser.invoke(${JSON.stringify(request)})`,
    );
    assert.equal(result.ok, true);
    return result.value;
  };
  const nativeWindow = await invoke({
    method: "getWindow",
    windowId: winA,
    populate: true,
  });
  const blankTab = nativeWindow.tabs.filter((tab) => {
    return tab.url === "about:blank";
  });
  assert.equal(blankTab.length, 1);
  const movedSession = await pageSession(scopedA, created.targetId);
  await observe(
    scopedA,
    (event) => {
      return (
        event.method === "Target.detachedFromTarget" &&
        event.params.sessionId === movedSession
      );
    },
    () => {
      return invoke({
        method: "moveTabs",
        tabIds: [blankTab[0].id],
        windowId: winB,
        index: -1,
      });
    },
  );
  await assert.rejects(scopedA.request("Runtime.enable", {}, movedSession));
  assert.ok(
    (await pages(scopedB)).some((page) => {
      return page.targetId === created.targetId;
    }),
  );

  const status = await readFile(`/proc/${proxyA.child.pid}/status`, "utf8");
  const reconnected = await proxy(endpoint, runtimeId, winA);
  const fresh = await wire(reconnected.endpoint);
  assert.ok(
    (await pages(fresh)).some((page) => {
      return page.targetId === a;
    }),
  );
  const retired = once(reconnected.child, "exit");
  fresh.close();
  await retired;
  // A browser-scope close is a logical close of this chat's existing native window.
  const proxyExited = once(proxyA.child, "exit");
  void scopedA.request("Browser.close").catch(() => {});
  await proxyExited;
  assert.equal(
    (await direct.request("Browser.getWindowForTarget", { targetId: b }))
      .windowId,
    winB,
  );
  console.log(
    JSON.stringify(
      {
        chromium: "local isolated fixture",
        twoWindowScope: true,
        sharedStorage: true,
        blankCreation: true,
        forTab: true,
        nestedSessions: true,
        agentBrowser: true,
        guestTaskAdmission: process.argv.includes("--guest-task"),
        popup: true,
        nativeMoveRetiresSession: true,
        reconnect: true,
        logicalClosePreservesSibling: true,
        setupMs: [proxyA.setupMs, proxyB.setupMs],
        proxyRssKiB: Number(/VmRSS:\s+(\d+)/u.exec(status)?.[1]),
        metrics,
      },
      null,
      2,
    ),
  );
} finally {
  for (const session of sessions)
    await run("agent-browser", ["--session", session, "close"], {
      timeout: 15000,
    }).catch(() => {});
  for (const wire of wires) wire.close();
  for (const { child, closed } of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await closed;
  }
  if (browser) {
    if (browser.exitCode === null && browser.signalCode === null)
      browser.kill("SIGTERM");
    await browserClosed;
  }
  server.closeAllConnections();
  await new Promise((resolve) => {
    return server.close(resolve);
  });
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
