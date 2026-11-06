import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

let server;
let origin;
const styles = `<style>
  @font-face { font-family: 'Owned Latin'; src: local('Liberation Sans'), local('Arial'); unicode-range: U+0000-007F; }
  @font-face { font-family: 'Arial Unicode MS'; src: local('Liberation Serif'), local('Times New Roman'); }
  @font-face { font-family: 'Owned Site Face'; src: local('Liberation Mono'), local('Courier New'); }
  body { font: 24px var(--page-font, 'Owned Latin'); }
  #opaque-container { --opaque-font: italic 700 24px 'Owned Latin'; }
  #sample, #variable-sample, #linked-sample { font-weight: 700; font-style: italic; }
  .alternate { font-family: 'Owned Site Face' !important; }
  [data-site-font=alternate] #container { font-family: 'Owned Site Face' !important; }
  #site-control { font-family: 'Owned Site Face'; font-weight: 700; font-style: italic; }
  #caption-control { font: caption; font-weight: 700; font-style: italic; }
  code { font-family: monospace; }
</style>`;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/theme.css") {
      response.setHeader("Content-Type", "text/css; charset=utf-8");
      response.end('#linked-sample { font-family: "Owned Site Face"; }');
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/frame") {
      response.end(
        `<!doctype html>${styles}<p id="frame-text">Αλφάβητο</p><div id="churn"></div>`,
      );
      return;
    }
    response.end(`<!doctype html><html lang="en"><head>${styles}<link id="theme-link" rel="stylesheet" href="/theme.css"></head><body>
      <div id="container"><span id="sample">Αλφάβητο ABC</span></div>
      <p id="linked-sample">Αλφάβητο ABC</p>
      <p id="site-control">Αλφάβητο ABC</p>
      <p id="caption-control">Αλφάβητο ABC</p>
      <p id="variable-sample" style="--text-font: 'Owned Latin'; font-family: var(--text-font)">Αλφάβητο ABC</p>
      <p id="shorthand-sample" style="--inline-font: italic 700 24px 'Owned Site Face'; font: var(--inline-font); font-weight: 700">Αλφάβητο ABC</p>
      <p id="inline-caption" style="font: caption; font-weight: 700; font-style: italic">Αλφάβητο ABC</p>
      <div id="opaque-container" style="font: var(--opaque-font); font-weight: 700; font-style: italic"><span id="opaque-child">Αλφάβητο ABC</span></div>
      <span id="latin">Latin ABC 123</span><span id="latin-reference">Latin ABC 123</span>
      <p id="symbols">★ 😀</p><code id="code">const value = 123;</code>
      <label>Search<input id="search" placeholder="Αναζήτηση"></label>
      <button id="add">Add text</button><button id="theme">Change site font</button>
      <button id="system">Use system font</button>
      <button id="inline">Change inline font</button><button id="clear">Use Latin text</button>
      <button id="variable">Change inherited font variable</button>
      <button id="own-variable">Change local font variable</button>
      <button id="nested-style">Toggle nested stylesheet</button>
      <button id="link-role">Toggle stylesheet link role</button>
      <button id="attribute-theme">Change attribute theme</button>
      <button id="shorthand-variable">Change shorthand variable</button>
      <button id="caption-class">Update caption class</button>
      <button id="opaque-theme">Change ancestor shorthand</button>
      <button id="opaque-clear">Clear ancestor shorthand</button>
      <div id="dynamic"></div><div id="shadow-host"></div>
      <iframe title="Languages" src="/frame"></iframe>
      <script>
        document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<p id="shadow-text" style="font-family: &quot;Owned Latin&quot;">Αλφάβητο</p>';
        document.querySelector('#add').onclick=()=>{document.querySelector('#dynamic').innerHTML='<p id="added" style="font-family: &quot;Owned Latin&quot; !important">Αλφάβητο</p>';};
        document.querySelector('#theme').onclick=()=>{document.querySelector('#container').classList.toggle('alternate');};
        document.querySelector('#system').onclick=()=>{document.querySelector('#container').style.font='caption';};
        document.querySelector('#inline').onclick=()=>{document.querySelector('#sample').style.setProperty('font-family','"Owned Latin"','important');};
        document.querySelector('#clear').onclick=()=>{document.querySelector('#sample').textContent='Latin ABC 123';};
        document.querySelector('#variable').onclick=()=>{document.documentElement.style.setProperty('--page-font', '"Owned Site Face"');};
        document.querySelector('#own-variable').onclick=()=>{document.querySelector('#variable-sample').style.setProperty('--text-font', '"Owned Site Face"');};
        document.querySelector('#nested-style').onclick=()=>{const current=document.querySelector('#nested-styles');if(current){current.remove();return;}const wrapper=document.createElement('div');wrapper.id='nested-styles';wrapper.innerHTML='<style>#container { font-family: "Owned Site Face" !important; }</style>';document.body.append(wrapper);};
        document.querySelector('#link-role').onclick=()=>{const link=document.querySelector('#theme-link');link.rel=link.rel==='stylesheet'?'alternate':'stylesheet';};
        document.querySelector('#attribute-theme').onclick=()=>{document.documentElement.dataset.siteFont='alternate';};
        document.querySelector('#shorthand-variable').onclick=()=>{document.querySelector('#shorthand-sample').style.setProperty('--inline-font', 'italic 700 28px "Owned Site Face"');};
        document.querySelector('#caption-class').onclick=()=>{document.querySelector('#inline-caption').classList.toggle('updated-caption');};
        document.querySelector('#opaque-theme').onclick=()=>{document.querySelector('#opaque-container').style.cssText='font: caption; font-weight: 700; font-style: italic';};
        document.querySelector('#opaque-clear').onclick=()=>{document.querySelector('#opaque-container').style.cssText='';};
      </script>
    </body></html>`);
  });
  await new Promise((ready) => {
    return server.listen(0, "127.0.0.1", ready);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((ready, reject) => {
    return server.close((error) => {
      return error ? reject(error) : ready();
    });
  });
});

async function fixture() {
  const parent = resolve("test-results/profiles");
  await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(resolve(parent, "fonts-"));
  const extension = resolve("dist");
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      executablePath: process.env.CHROMIUM_EXECUTABLE,
      headless: true,
      args: [
        "--headless=new",
        "--no-sandbox",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
      ignoreDefaultArgs: [
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    });
    const page = await context.newPage();
    await page.goto(origin);
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    async function fonts(id, session = cdp) {
      const { root } = await session.send("DOM.getDocument", {
        depth: -1,
        pierce: true,
      });
      function find(node) {
        if (
          node.attributes?.some((value, index) => {
            return (
              index % 2 === 0 &&
              value === "id" &&
              node.attributes[index + 1] === id
            );
          })
        )
          return node.nodeId;
        for (const child of [
          ...(node.children ?? []),
          ...(node.shadowRoots ?? []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ]) {
          const found = find(child);
          if (found) return found;
        }
        return undefined;
      }
      const nodeId = find(root);
      return nodeId
        ? (await session.send("CSS.getPlatformFontsForNode", { nodeId })).fonts
        : [];
    }
    return {
      page,
      fonts,
      async close() {
        await context.close();
        await rm(profile, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  } catch (error) {
    await context?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

function suppliedGreek(fonts) {
  return fonts.some((font) => {
    return (
      /LiberationSerif|TimesNewRoman/.test(font.postScriptName) &&
      font.glyphCount >= 8
    );
  });
}

test("supplements non-Latin glyphs while preserving named fonts, formatting and page interaction", async () => {
  const f = await fixture();
  try {
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("sample"));
      })
      .toBe(true);
    await expect(f.page.locator("#sample")).toHaveCSS("font-weight", "700");
    await expect(f.page.locator("#sample")).toHaveCSS("font-style", "italic");
    expect(await f.fonts("latin")).toEqual(await f.fonts("latin-reference"));
    expect(
      await f.page.locator("#latin").evaluate((element) => {
        return element.getBoundingClientRect().width;
      }),
    ).toBe(
      await f.page.locator("#latin-reference").evaluate((element) => {
        return element.getBoundingClientRect().width;
      }),
    );
    await expect(f.page.locator("code")).toHaveCSS("font-family", "monospace");
    await expect(f.page.locator("#symbols")).toHaveCSS(
      "font-family",
      '"Owned Latin"',
    );
    await f.page.getByRole("textbox", { name: "Search" }).fill("Αλφάβητο");
    await expect(f.page.getByRole("textbox", { name: "Search" })).toHaveValue(
      "Αλφάβητο",
    );
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("frame-text"));
      })
      .toBe(true);
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("shadow-text"));
      })
      .toBe(true);
  } finally {
    await f.close();
  }
});

test("follows dynamic text and authored class/inline changes without retaining stale typography", async () => {
  const f = await fixture();
  try {
    await f.page.getByRole("button", { name: "Add text" }).click();
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("added"));
      })
      .toBe(true);
    await f.page.getByRole("button", { name: "Use system font" }).click();
    await expect
      .poll(async () => {
        return await f.fonts("sample");
      })
      .toEqual(await f.fonts("caption-control"));
    await f.page.getByRole("button", { name: "Change site font" }).click();
    await expect
      .poll(async () => {
        return await f.fonts("sample");
      })
      .toEqual(await f.fonts("site-control"));
    await f.page.getByRole("button", { name: "Change inline font" }).click();
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("sample"));
      })
      .toBe(true);
    await f.page.getByRole("button", { name: "Use Latin text" }).click();
    await expect
      .poll(async () => {
        return await f.fonts("sample");
      })
      .toEqual(await f.fonts("latin-reference"));
  } finally {
    await f.close();
  }
});

test("follows inherited and local font variables after supplementing text", async () => {
  const f = await fixture();
  try {
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("variable-sample"));
      })
      .toBe(true);
    await f.page
      .getByRole("button", { name: "Change inherited font variable" })
      .click();
    await expect
      .poll(async () => {
        return await f.fonts("sample");
      })
      .toEqual(await f.fonts("site-control"));
    await f.page
      .getByRole("button", { name: "Change local font variable" })
      .click();
    await expect
      .poll(async () => {
        return await f.fonts("variable-sample");
      })
      .toEqual(await f.fonts("site-control"));
  } finally {
    await f.close();
  }
});

test("follows nested stylesheets added to and removed from another subtree", async () => {
  const f = await fixture();
  try {
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("sample"));
      })
      .toBe(true);
    await f.page
      .getByRole("button", { name: "Toggle nested stylesheet" })
      .click();
    await expect
      .poll(async () => {
        return await f.fonts("sample");
      })
      .toEqual(await f.fonts("site-control"));
    await f.page
      .getByRole("button", { name: "Toggle nested stylesheet" })
      .click();
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("sample"));
      })
      .toBe(true);
  } finally {
    await f.close();
  }
});

test("follows stylesheet links losing and regaining their stylesheet role", async () => {
  const f = await fixture();
  try {
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("sample"));
      })
      .toBe(true);
    await expect
      .poll(async () => {
        return await f.fonts("linked-sample");
      })
      .toEqual(await f.fonts("site-control"));
    await f.page
      .getByRole("button", { name: "Toggle stylesheet link role" })
      .click();
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("linked-sample"));
      })
      .toBe(true);
    await f.page
      .getByRole("button", { name: "Toggle stylesheet link role" })
      .click();
    await expect
      .poll(async () => {
        return await f.fonts("linked-sample");
      })
      .toEqual(await f.fonts("site-control"));
  } finally {
    await f.close();
  }
});

test("follows site typography selected by ancestor attributes", async () => {
  const f = await fixture();
  try {
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("sample"));
      })
      .toBe(true);
    await f.page
      .getByRole("button", { name: "Change attribute theme" })
      .click();
    await expect
      .poll(async () => {
        return await f.fonts("sample");
      })
      .toEqual(await f.fonts("site-control"));
  } finally {
    await f.close();
  }
});

test("preserves inline font shorthands through site typography updates", async () => {
  const f = await fixture();
  try {
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("sample"));
      })
      .toBe(true);
    await f.page
      .getByRole("button", { name: "Change shorthand variable" })
      .click();
    await expect
      .poll(async () => {
        return await f.fonts("shorthand-sample");
      })
      .toEqual(await f.fonts("site-control"));
    await expect(f.page.locator("#shorthand-sample")).toHaveCSS(
      "font-size",
      "28px",
    );
    await expect(f.page.locator("#shorthand-sample")).toHaveCSS(
      "font-weight",
      "700",
    );
    await expect(f.page.locator("#shorthand-sample")).toHaveCSS(
      "font-style",
      "italic",
    );
    await f.page.getByRole("button", { name: "Update caption class" }).click();
    await expect
      .poll(async () => {
        return await f.fonts("inline-caption");
      })
      .toEqual(await f.fonts("caption-control"));
  } finally {
    await f.close();
  }
});

test("follows effective ancestor fonts when inline shorthand values are opaque", async () => {
  const f = await fixture();
  try {
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("opaque-child"));
      })
      .toBe(true);
    await f.page
      .getByRole("button", { name: "Change ancestor shorthand" })
      .click();
    await expect
      .poll(async () => {
        return await f.fonts("opaque-child");
      })
      .toEqual(await f.fonts("caption-control"));
    await f.page
      .getByRole("button", { name: "Clear ancestor shorthand" })
      .click();
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("opaque-child"));
      })
      .toBe(true);
    await expect(f.page.locator("#opaque-child")).toHaveCSS(
      "font-size",
      "24px",
    );
    await expect(f.page.locator("#opaque-child")).toHaveCSS(
      "font-weight",
      "400",
    );
    await expect(f.page.locator("#opaque-child")).toHaveCSS(
      "font-style",
      "normal",
    );
  } finally {
    await f.close();
  }
});

test("releases removed nodes while a cross-site frame is hidden and resumes font repair", async () => {
  const f = await fixture();
  let session;
  try {
    const navigation = f.page.waitForEvent("framenavigated", {
      predicate(candidate) {
        return new URL(candidate.url()).hostname === "localhost";
      },
    });
    await f.page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "background-frame";
      frame.title = "Background languages";
      const url = new URL("/frame", location.href);
      url.hostname = "localhost";
      frame.src = url.href;
      document.body.append(frame);
    });
    const frame = await navigation;
    await expect(frame.locator("#frame-text")).toHaveCSS(
      "font-family",
      /Arial Unicode MS/,
    );
    session = await f.page.context().newCDPSession(frame);
    async function nodes() {
      await session.send("HeapProfiler.collectGarbage");
      return (await session.send("Memory.getDOMCounters")).nodes;
    }
    await f.page.locator("#background-frame").evaluate((element) => {
      element.style.display = "none";
    });
    await frame.evaluate(() => {
      document.documentElement.dataset.framePending = "true";
      requestAnimationFrame(() => {
        delete document.documentElement.dataset.framePending;
      });
    });
    await f.page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    });
    await expect(frame.locator("html")).toHaveAttribute(
      "data-frame-pending",
      "true",
    );
    const before = await nodes();
    await frame.evaluate(async () => {
      const nextTask = () => {
        return new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
          };
          channel.port2.postMessage(null);
        });
      };
      const container = document.querySelector("#churn");
      for (let batch = 0; batch < 25; batch++) {
        for (let i = 0; i < 200; i++) {
          const element = document.createElement("span");
          element.textContent = "Αλφάβητο";
          container.append(element);
        }
        await nextTask();
        container.replaceChildren();
        await nextTask();
      }
    });
    await expect(frame.locator("html")).toHaveAttribute(
      "data-frame-pending",
      "true",
    );
    expect(await nodes()).toBe(before);
    await frame.evaluate(() => {
      const element = document.createElement("p");
      element.id = "resumed-text";
      element.textContent = "Αλφάβητο";
      document.body.append(element);
    });
    await f.page.locator("#background-frame").evaluate((element) => {
      element.style.display = "";
    });
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    await expect
      .poll(async () => {
        return suppliedGreek(await f.fonts("resumed-text", session));
      })
      .toBe(true);
  } finally {
    try {
      await session?.detach();
    } finally {
      await f.close();
    }
  }
});
