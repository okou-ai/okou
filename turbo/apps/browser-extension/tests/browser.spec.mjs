import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, cp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

let server;
let origin;
let reconnectGate;
let disconnectedCreation;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/reconnect-gate") {
      reconnectGate.resolve(response);
      return;
    }
    if (request.url === "/after-driver-disconnect")
      disconnectedCreation.resolve();
    if (request.url.startsWith("/coop")) {
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    }
    response.end(`<!doctype html><title>Owned fixture</title>
      <a id="link" href="/child-link" target="_blank">Open</a>
      <a id="noopener" href="/child-noopener-link" target="_blank" rel="noopener">Open safely</a>
      <form action="/child-form" target="_blank"><button>Submit</button></form>
      <script>window.messages=[];addEventListener('message',e=>window.messages.push(e.data));</script>`);
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

async function installExtensions(profile) {
  const extension = resolve(profile, "extension");
  await cp(resolve("dist"), extension, { recursive: true });
  // Public Chrome APIs in a separate test extension observe URLs and placement.
  // The separate observer does not alter the production manifest or worker.
  const observer = resolve(profile, "observer");
  await mkdir(observer);
  await writeFile(
    resolve(observer, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Owned browser test observer",
      version: "1.0.0",
      permissions: ["tabs"],
      background: { service_worker: "observer.js" },
    }),
  );
  await writeFile(resolve(observer, "observer.js"), "void 0;\n");
  await writeFile(
    resolve(observer, "probe.html"),
    "<!doctype html><title>Owned test observer</title>",
  );
  // This blank production-origin page only observes/stops its worker through
  // native runtime/CDP APIs. It does not alter the installed worker or manifest.
  await writeFile(
    resolve(extension, "probe.html"),
    "<!doctype html><title>Owned test driver</title>",
  );
  return `${extension},${observer}`;
}

async function browser() {
  const parent = resolve("test-results/profiles");
  await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(resolve(parent, "owned-"));
  let context;
  try {
    const extensions = await installExtensions(profile);
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE,
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${extensions}`,
        `--load-extension=${extensions}`,
      ],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    const background =
      context.serviceWorkers().find((worker) => {
        return worker.url().endsWith("/background.js");
      }) ??
      (await context.waitForEvent("serviceworker", {
        predicate: (worker) => {
          return worker.url().endsWith("/background.js");
        },
      }));
    const observer =
      context.serviceWorkers().find((worker) => {
        return worker.url().endsWith("/observer.js");
      }) ??
      (await context.waitForEvent("serviceworker", {
        predicate: (worker) => {
          return worker.url().endsWith("/observer.js");
        },
      }));
    const worker = await context.newPage();
    await worker.goto(new URL("probe.html", observer.url()).href);
    const manifest = await background.evaluate(() => {
      return chrome.runtime.getManifest();
    });
    async function root(label) {
      const url = `${origin}/source?${label}`;
      const created = await worker.evaluate(async (url) => {
        return await chrome.windows.create({
          url,
          type: "normal",
          focused: false,
        });
      }, url);
      await expect
        .poll(() => {
          return context.pages().some((page) => {
            return page.url() === url;
          });
        })
        .toBe(true);
      const page = context.pages().find((page) => {
        return page.url() === url;
      });
      await page.waitForLoadState();
      return { page, windowId: created.id, tabId: created.tabs[0].id };
    }
    async function tab(url) {
      return await worker.evaluate(async (url) => {
        return (await chrome.tabs.query({})).find((tab) => {
          return tab.url === url;
        });
      }, url);
    }
    async function settled(url, windowId) {
      await expect
        .poll(async () => {
          return (await tab(url))?.windowId;
        })
        .toBe(windowId);
      return await tab(url);
    }
    return {
      context,
      root,
      tab,
      settled,
      worker,
      manifest,
      async restart(whileStopped = async () => {}) {
        const probe = await context.newPage();
        await probe.goto(new URL("probe.html", background.url()).href);
        const cdp = await context.newCDPSession(probe);
        const before = await probe.evaluate(() => {
          return chrome.runtime.getContexts({ contextTypes: ["BACKGROUND"] });
        });
        expect(before).toHaveLength(1);
        await cdp.send("ServiceWorker.enable");
        await cdp.send("ServiceWorker.stopAllWorkers");
        await expect
          .poll(async () => {
            return (
              await probe.evaluate(() => {
                return chrome.runtime.getContexts({
                  contextTypes: ["BACKGROUND"],
                });
              })
            ).map((entry) => {
              return entry.contextId;
            });
          })
          .not.toContain(before[0].contextId);
        await whileStopped();
        // A real native tab event wakes the installed worker again.
        await cdp.send("Target.createTarget", {
          url: "about:blank#worker-wake",
        });
        await expect
          .poll(async () => {
            return (
              await probe.evaluate(() => {
                return chrome.runtime.getContexts({
                  contextTypes: ["BACKGROUND"],
                });
              })
            )[0]?.contextId;
          })
          .toEqual(expect.any(String));
        expect(
          (
            await probe.evaluate(() => {
              return chrome.runtime.getContexts({
                contextTypes: ["BACKGROUND"],
              });
            })
          )[0].contextId,
        ).not.toBe(before[0].contextId);
        await cdp.detach();
      },
      async close() {
        await context.close();
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

for (const kind of [
  "normal",
  "noopener",
  "coop",
  "link",
  "noopener-link",
  "form",
]) {
  test(`automatically moves ${kind} creation to its source despite sibling focus`, async () => {
    const b = await browser();
    try {
      const a = await b.root("A");
      const sibling = await b.root("B");
      await b.worker.evaluate((id) => {
        return chrome.windows.update(id, { focused: true });
      }, sibling.windowId);
      let path = `/child-${kind}`;
      if (kind === "coop") path = "/coop";
      if (kind === "link" || kind === "noopener-link") {
        await a.page.locator(kind === "link" ? "#link" : "#noopener").click();
      } else if (kind === "form") {
        await a.page.locator("button").click();
        path = "/child-form?";
      } else {
        await a.page.evaluate(
          ({ path, kind }) => {
            window.open(
              path,
              "_blank",
              `popup,width=400,height=400${kind === "noopener" ? ",noopener" : ""}`,
            );
          },
          { path, kind },
        );
      }
      const created = await b.settled(origin + path, a.windowId);
      expect(created.windowId).not.toBe(sibling.windowId);
      expect((await b.tab(`${origin}/source?B`)).windowId).toBe(
        sibling.windowId,
      );
    } finally {
      await b.close();
    }
  });
}

test("keeps document/opener messaging and script-close; does not undo a later deliberate move", async () => {
  const b = await browser();
  try {
    const a = await b.root("A");
    const sibling = await b.root("B");
    const popup = a.page.waitForEvent("popup");
    await a.page.evaluate(() => {
      const child = window.open(
        "about:blank#owned-document",
        "_blank",
        "popup,width=400,height=400",
      );
      child.marker = "document-survived";
      child.document.body.textContent = "Preserve this document";
    });
    const page = await popup;
    const info = await b.settled("about:blank#owned-document", a.windowId);
    expect(
      await page.evaluate(() => {
        return window.marker;
      }),
    ).toBe("document-survived");
    expect(
      await page.evaluate(() => {
        return !!window.opener;
      }),
    ).toBe(true);
    await page.evaluate(() => {
      return window.opener.postMessage("moved", "*");
    });
    await expect
      .poll(() => {
        return a.page.evaluate(() => {
          return window.messages;
        });
      })
      .toContain("moved");
    await b.worker.evaluate(
      ({ id, windowId }) => {
        return chrome.tabs.move(id, { windowId, index: -1 });
      },
      { id: info.id, windowId: sibling.windowId },
    );
    await page.reload();
    await expect
      .poll(async () => {
        return (await b.tab("about:blank#owned-document"))?.windowId;
      })
      .toBe(sibling.windowId);
    await page.evaluate(() => {
      return window.open(
        "about:blank#after-relocation",
        "_blank",
        "popup,width=300,height=300",
      );
    });
    await b.settled("about:blank#after-relocation", sibling.windowId);
    const closed = page.waitForEvent("close");
    await page.evaluate(() => {
      return window.close();
    });
    await closed;
    expect(a.page.isClosed()).toBe(false);
  } finally {
    await b.close();
  }
});

for (const kind of ["normal", "noopener"]) {
  test(`accepts later relocation before an empty ${kind} popup's first navigation`, async () => {
    const b = await browser();
    try {
      const a = await b.root("empty-A");
      const sibling = await b.root("empty-B");
      const before = await b.worker.evaluate(async () => {
        return (await chrome.tabs.query({})).map((tab) => {
          return tab.id;
        });
      });
      const opened = b.context.waitForEvent("page");
      await a.page.evaluate((kind) => {
        window.open(
          "",
          "_blank",
          `popup,width=300,height=300${kind === "noopener" ? ",noopener" : ""}`,
        );
      }, kind);
      const page = await opened;
      const created = await b.worker.evaluate(async (before) => {
        return (await chrome.tabs.query({})).filter((tab) => {
          return !before.includes(tab.id);
        });
      }, before);
      expect(created).toHaveLength(1);
      const tabId = created[0].id;
      await expect
        .poll(() => {
          return b.worker.evaluate(async (id) => {
            return (await chrome.tabs.get(id)).windowId;
          }, tabId);
        })
        .toBe(a.windowId);
      await b.worker.evaluate(
        ({ id, windowId }) => {
          return chrome.tabs.move(id, { windowId, index: -1 });
        },
        { id: tabId, windowId: sibling.windowId },
      );
      await page.goto(`${origin}/first-navigation-after-relocation`);
      // Completing later source work also waits through earlier creation work;
      // an immediate placement assertion could pass before a late callback runs.
      await a.page.evaluate(() => {
        return window.open(
          "/after-first-navigation",
          "_blank",
          "popup,width=300,height=300",
        );
      });
      await b.settled(`${origin}/after-first-navigation`, a.windowId);
      expect(
        (await b.tab(`${origin}/first-navigation-after-relocation`)).windowId,
      ).toBe(sibling.windowId);
      await page.evaluate(() => {
        return window.open(
          "/child-after-first-navigation",
          "_blank",
          "popup,width=300,height=300",
        );
      });
      await b.settled(
        `${origin}/child-after-first-navigation`,
        sibling.windowId,
      );
    } finally {
      await b.close();
    }
  });
}

test("leaves an already-correct tab in place and accepts its later relocation", async () => {
  const b = await browser();
  try {
    const a = await b.root("A");
    const sibling = await b.root("B");
    const created = await b.worker.evaluate(
      async ({ windowId, sourceTabId, origin }) => {
        await chrome.tabs.create({ windowId, url: "about:blank#tail" });
        return await chrome.tabs.create({
          windowId,
          openerTabId: sourceTabId,
          url: `${origin}/already-correct`,
          index: 1,
          active: false,
        });
      },
      { windowId: a.windowId, sourceTabId: a.tabId, origin },
    );
    await a.page.evaluate(() => {
      return window.open(
        "/next-creation",
        "_blank",
        "popup,width=300,height=300",
      );
    });
    await b.settled(`${origin}/next-creation`, a.windowId);
    const info = await b.settled(`${origin}/already-correct`, a.windowId);
    // An unnecessary tabs.move(index: -1) would reorder this existing tab.
    expect(info.index).toBe(1);
    await b.worker.evaluate(
      ({ id, windowId }) => {
        return chrome.tabs.move(id, { windowId, index: -1 });
      },
      { id: created.id, windowId: sibling.windowId },
    );
    await expect
      .poll(() => {
        return b.context.pages().some((page) => {
          return page.url() === `${origin}/already-correct`;
        });
      })
      .toBe(true);
    const page = b.context.pages().find((page) => {
      return page.url() === `${origin}/already-correct`;
    });
    await page.waitForLoadState();
    await page.reload();
    await page.evaluate(() => {
      return window.open(
        "/child-after-noop",
        "_blank",
        "popup,width=300,height=300",
      );
    });
    await b.settled(`${origin}/child-after-noop`, sibling.windowId);
    expect((await b.tab(`${origin}/already-correct`)).windowId).toBe(
      sibling.windowId,
    );
  } finally {
    await b.close();
  }
});

test("routes nested pages and simultaneous sources to their respective windows", async () => {
  const b = await browser();
  try {
    const a = await b.root("A");
    const sibling = await b.root("B");
    await Promise.all([
      a.page.evaluate(() => {
        const child = window.open(
          "about:blank#nested-parent",
          "_blank",
          "popup,width=400,height=400",
        );
        child.open(
          "about:blank#nested-child",
          "_blank",
          "popup,width=300,height=300",
        );
      }),
      sibling.page.evaluate(() => {
        return window.open(
          "about:blank#sibling-child",
          "_blank",
          "popup,width=300,height=300",
        );
      }),
    ]);
    await b.settled("about:blank#nested-parent", a.windowId);
    await b.settled("about:blank#nested-child", a.windowId);
    await b.settled("about:blank#sibling-child", sibling.windowId);
  } finally {
    await b.close();
  }
});

test("consolidates nested creation when the source and intermediate openers close immediately", async () => {
  const b = await browser();
  try {
    const a = await b.root("A");
    const sibling = await b.root("B");
    const anchor = await b.worker.evaluate((windowId) => {
      return chrome.tabs.create({ windowId, url: "about:blank#nested-anchor" });
    }, a.windowId);
    const closed = a.page.waitForEvent("close");
    await a.page.evaluate(() => {
      const parent = window.open(
        "about:blank#vanishing-parent",
        "_blank",
        "popup,width=400,height=400",
      );
      const child = parent.open(
        "about:blank#vanishing-child",
        "_blank",
        "popup,width=300,height=300",
      );
      child.open(
        "/surviving-grandchild",
        "_blank",
        "popup,width=300,height=300,noopener",
      );
      child.close();
      parent.close();
      window.close();
    });
    await closed;
    await b.settled(`${origin}/surviving-grandchild`, a.windowId);
    expect((await b.tab("about:blank#nested-anchor")).id).toBe(anchor.id);
    expect((await b.tab(`${origin}/source?B`)).windowId).toBe(sibling.windowId);
  } finally {
    await b.close();
  }
});

test("handles new creation and instant opener loss after a worker restart", async () => {
  const b = await browser();
  try {
    const a = await b.root("A");
    await a.page.evaluate(() => {
      return window.open(
        "/child-before-restart",
        "_blank",
        "popup,width=400,height=400",
      );
    });
    await b.settled(`${origin}/child-before-restart`, a.windowId);
    await b.restart();
    const opener = a.page.waitForEvent("popup");
    await a.page.evaluate(() => {
      return window.open(
        "/temporary-opener",
        "_blank",
        "popup,width=400,height=400",
      );
    });
    const temporary = await opener;
    await temporary.waitForLoadState();
    await temporary.evaluate(() => {
      window.open(
        "/child-after-loss",
        "_blank",
        "popup,width=300,height=300,noopener",
      );
      window.close();
    });
    await b.settled(`${origin}/child-after-loss`, a.windowId);
  } finally {
    await b.close();
  }
});

test("handles an opener disappearing during cold wake without saved state", async () => {
  const b = await browser();
  try {
    expect(b.manifest.permissions).toEqual(["webNavigation", "tabs"]);
    const a = await b.root("cold-A");
    const sibling = await b.root("cold-B");
    const anchor = await b.worker.evaluate((windowId) => {
      return chrome.tabs.create({ windowId, url: "about:blank#cold-anchor" });
    }, a.windowId);
    await b.restart(async () => {
      const closed = a.page.waitForEvent("close");
      await a.page.evaluate(() => {
        window.open(
          "/child-during-cold-wake",
          "_blank",
          "popup,width=300,height=300,noopener",
        );
        window.close();
      });
      await closed;
    });
    await b.settled(`${origin}/child-during-cold-wake`, a.windowId);
    expect((await b.tab("about:blank#cold-anchor")).id).toBe(anchor.id);
    expect((await b.tab(`${origin}/source?cold-B`)).windowId).toBe(
      sibling.windowId,
    );
  } finally {
    await b.close();
  }
});

test("retains a freely created page when its destination closes; new workers leave it alone", async () => {
  const b = await browser();
  try {
    const a = await b.root("A");
    const sibling = await b.root("B");
    await b.restart(async () => {
      const closed = a.page.waitForEvent("close");
      await a.page.evaluate(() => {
        window.open(
          "/orphan-after-close",
          "_blank",
          "popup,width=300,height=300,noopener",
        );
        window.close();
      });
      await closed;
    });
    await expect
      .poll(() => {
        return b.tab(`${origin}/orphan-after-close`);
      })
      .toBeTruthy();
    const orphan = await b.tab(`${origin}/orphan-after-close`);
    expect(orphan.windowId).not.toBe(sibling.windowId);
    await b.restart();
    const replacement = await b.root("replacement-A");
    expect(replacement.windowId).not.toBe(a.windowId);
    expect((await b.tab(`${origin}/orphan-after-close`)).windowId).toBe(
      orphan.windowId,
    );
    await b.worker.evaluate((id) => {
      return chrome.tabs.remove(id);
    }, orphan.id);
    await expect
      .poll(() => {
        return b.tab(`${origin}/orphan-after-close`);
      })
      .toBeUndefined();
  } finally {
    await b.close();
  }
});

test("keeps raw sourceless CDP creation available and prunes destroyed targets", async () => {
  const b = await browser();
  try {
    const a = await b.root("A");
    const cdp = await b.context.newCDPSession(a.page);
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank#sourceless",
      newWindow: true,
    });
    expect(targetId).toBeTruthy();
    expect(await cdp.send("Browser.getVersion")).toHaveProperty("product");
    await cdp.send("Target.closeTarget", { targetId });
    await a.page.evaluate(() => {
      const child = window.open(
        "about:blank#destroy-immediately",
        "_blank",
        "popup,width=300,height=300",
      );
      child.close();
    });
    await expect
      .poll(() => {
        return b.tab("about:blank#destroy-immediately");
      })
      .toBeUndefined();
    await a.page.evaluate(() => {
      return window.open(
        "/child-after-destruction",
        "_blank",
        "popup,width=300,height=300",
      );
    });
    await b.settled(`${origin}/child-after-destruction`, a.windowId);
    await cdp.detach();
  } finally {
    await b.close();
  }
});

test("consolidates website creation with the driver disconnected, then reconnects", async () => {
  const parent = resolve("test-results/profiles");
  await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(resolve(parent, "disconnected-"));
  const extensions = await installExtensions(profile);
  const owner = spawn(
    process.env.CHROMIUM_EXECUTABLE ?? chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-popup-blocking",
      "--enable-unsafe-extension-debugging",
      "--disable-component-extensions-with-background-pages",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${extensions}`,
      `--load-extension=${extensions}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let driver;
  const lines = createInterface({
    input: owner.stderr,
    signal: AbortSignal.timeout(10000),
  });
  try {
    let endpoint;
    for await (const line of lines) {
      const match = line.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        endpoint = match[1];
        break;
      }
    }
    if (!endpoint)
      throw new Error("Owned Chromium did not expose its debugger endpoint");
    driver = await chromium.connectOverCDP(endpoint);
    let context = driver.contexts()[0];
    const cdp = await driver.newBrowserCDPSession();
    let background;
    await expect
      .poll(async () => {
        background = (await cdp.send("Target.getTargets")).targetInfos.find(
          (entry) => {
            return (
              entry.type === "service_worker" &&
              entry.url.endsWith("/observer.js")
            );
          },
        );
        return !!background;
      })
      .toBe(true);
    let control = await context.newPage();
    const controlUrl = new URL("probe.html", background.url).href;
    await control.goto(controlUrl);
    const created = await control.evaluate((url) => {
      return chrome.windows.create({ url, type: "normal" });
    }, `${origin}/source?detached`);
    await expect
      .poll(() => {
        return context.pages().some((page) => {
          return page.url() === `${origin}/source?detached`;
        });
      })
      .toBe(true);
    const source = context.pages().find((page) => {
      return page.url() === `${origin}/source?detached`;
    });
    await source.waitForLoadState();
    reconnectGate = Promise.withResolvers();
    disconnectedCreation = Promise.withResolvers();
    await source.evaluate(() => {
      return window.open(
        "/reconnect-gate",
        "_blank",
        "popup,width=300,height=300",
      );
    });
    const response = await reconnectGate.promise;
    await driver.close();
    driver = undefined;
    expect(owner.exitCode).toBeNull();
    // Only the owned HTTP fixture and Chromium remain connected here. Creation
    // is causally observed at the server before any driver reconnects.
    response.end(
      "<!doctype html><script>window.open('/after-driver-disconnect','_blank','popup,width=300,height=300')</script>",
    );
    await disconnectedCreation.promise;
    driver = await chromium.connectOverCDP(endpoint);
    context = driver.contexts()[0];
    control = context.pages().find((page) => {
      return page.url() === controlUrl;
    });
    await expect
      .poll(() => {
        return control.evaluate(async (url) => {
          return (await chrome.tabs.query({})).find((tab) => {
            return tab.url === url;
          })?.windowId;
        }, `${origin}/after-driver-disconnect`);
      })
      .toBe(created.id);
  } finally {
    lines.close();
    await driver?.close();
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, "exit");
      owner.kill("SIGTERM");
      await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});
