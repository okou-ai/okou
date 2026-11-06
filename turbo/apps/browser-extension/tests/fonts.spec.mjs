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
  #sample, #variable-sample { font-weight: 700; font-style: italic; }
  .alternate { font-family: 'Owned Site Face' !important; }
  [data-site-font=alternate] #container { font-family: 'Owned Site Face' !important; }
  #site-control { font-family: 'Owned Site Face'; font-weight: 700; font-style: italic; }
  #caption-control { font: caption; font-weight: 700; font-style: italic; }
  code { font-family: monospace; }
</style>`;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/frame") {
      response.end(`<!doctype html>${styles}<p id="frame-text">Αλφάβητο</p>`);
      return;
    }
    response.end(`<!doctype html><html lang="en"><head>${styles}</head><body>
      <div id="container"><span id="sample">Αλφάβητο ABC</span></div>
      <p id="site-control">Αλφάβητο ABC</p>
      <p id="caption-control">Αλφάβητο ABC</p>
      <p id="variable-sample" style="--text-font: 'Owned Latin'; font-family: var(--text-font)">Αλφάβητο ABC</p>
      <span id="latin">Latin ABC 123</span><span id="latin-reference">Latin ABC 123</span>
      <p id="symbols">★ 😀</p><code id="code">const value = 123;</code>
      <label>Search<input id="search" placeholder="Αναζήτηση"></label>
      <button id="add">Add text</button><button id="theme">Change site font</button>
      <button id="system">Use system font</button>
      <button id="inline">Change inline font</button><button id="clear">Use Latin text</button>
      <button id="variable">Change inherited font variable</button>
      <button id="own-variable">Change local font variable</button>
      <button id="nested-style">Toggle nested stylesheet</button>
      <button id="attribute-theme">Change attribute theme</button>
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
        document.querySelector('#attribute-theme').onclick=()=>{document.documentElement.dataset.siteFont='alternate';};
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
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    const page = await context.newPage();
    await page.goto(origin);
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    async function fonts(id) {
      const { root } = await cdp.send("DOM.getDocument", {
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
        ? (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts
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
