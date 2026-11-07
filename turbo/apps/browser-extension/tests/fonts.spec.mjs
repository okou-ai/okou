import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const defaultFamily = '-webkit-body, "Okou Browser Default"';
const greek = "Αλφάβητο ABC 123";
const styles = `
  @font-face { font-family: 'Site A'; src: local('Liberation Sans'), local('Arial'); }
  @font-face { font-family: 'Site B'; src: local('Liberation Mono'), local('Courier New'); }
  /* Controlled supply, not a claim that the host has Arial Unicode MS.
     Full-Chromium CI installs CJK faces with Playwright's native dependencies. */
  @font-face {
    font-family: 'Okou Browser Default';
    src: local('Noto Sans CJK SC'), local('Unifont'), local('WenQuanYi Zen Hei'), local('IPAGothic');
    unicode-range: U+4E00-9FFF;
  }
  body { font-size: 24px; }
  span { display: inline-block; }
  #native-latin, #native-han { font-family: -webkit-body; }
  #reference-a, #hover, #checked, #scheme { font-family: 'Site A'; }
  #reference-b { font-family: 'Site B'; }
  #hover:hover, #toggle:checked ~ #checked { font-family: 'Site B'; }
  @media (prefers-color-scheme: dark) { #scheme { font-family: 'Site B'; } }
  #variable { font-family: var(--family, 'Site A'); }
  #system { --system: caption; font: var(--system); }
  #wide-parent { font-family: 'Site B'; }
  #wide { font-family: var(--missing, initial); }
`;

let server;
let origin;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/site.css") {
      response.setHeader("Content-Type", "text/css");
      response.end('.external { font-family: "Site A"; }');
      return;
    }
    if (request.url === "/csp")
      response.setHeader("Content-Security-Policy", "style-src 'none'");
    const rootStyle =
      request.url === "/normal"
        ? ":root { font-family: 'Site A'; }"
        : request.url === "/layer"
          ? "@layer site { :where(:root) { font-family: 'Site B'; } }"
          : "";
    const inline =
      request.url === "/inline"
        ? ' style="font-family: &quot;Site B&quot;"'
        : "";
    response.end(`<!doctype html><html lang="en"${inline}><head>
      <style>${styles}${rootStyle}</style><link id="site-css" rel="stylesheet" href="/site.css">
      </head><body>
      <span id="default-latin">ABC 123 iiiWW</span><span id="native-latin">ABC 123 iiiWW</span>
      <p><span id="default-han">中文測試</span><span id="native-han">中文測試</span></p>
      <p><span id="reference-a">${greek}</span><span id="reference-b">${greek}</span></p>
      <input id="toggle" type="checkbox"><span id="checked">${greek}</span>
      <p><span id="hover">${greek}</span><span id="scheme">${greek}</span></p>
      <p><span id="variable">${greek}</span><span id="external" class="external">${greek}</span></p>
      <p><span id="system">${greek}</span><span id="caption-reference" style="font:caption">${greek}</span></p>
      <p id="wide-parent"><span id="wide">${greek}</span><span id="initial-reference" style="font-family:initial">${greek}</span></p>
      <code id="code">const count = 123;</code><input id="text-control" placeholder="Search">
      <div id="shadow-host"></div>
      ${request.url === "/" ? '<iframe name="http" src="/frame"></iframe><iframe name="blank" src="about:blank"></iframe>' : ""}
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

async function fixture(path = "/") {
  const parent = resolve("test-results/profiles");
  await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(resolve(parent, "default-fonts-"));
  let context;
  try {
    const extension = resolve("dist");
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      executablePath: process.env.CHROMIUM_EXECUTABLE,
      headless: true,
      viewport: { width: 1280, height: 1000 },
      args: [
        "--headless=new",
        "--no-sandbox",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    const page = await context.newPage();
    const stylesheetRequests = [];
    page.on("request", (request) => {
      if (request.url() === origin + "/site.css")
        stylesheetRequests.push(request);
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(origin + path);
    await page.evaluate(() => {
      return document.fonts.ready;
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    async function fonts(id) {
      // Platform-font records describe shaped layout, not pending style changes.
      await page.locator("#" + id).evaluate((node) => {
        return node.getBoundingClientRect().width;
      });
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
        ]) {
          const found = find(child);
          if (found) return found;
        }
      }
      const nodeId = find(root);
      expect(nodeId).toBeTruthy();
      return (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts
        .map(({ familyName, postScriptName, isCustomFont, glyphCount }) => {
          return {
            familyName,
            postScriptName,
            isCustomFont,
            glyphCount,
          };
        })
        .sort((a, b) => {
          return a.postScriptName.localeCompare(b.postScriptName);
        });
    }
    return {
      page,
      cdp,
      fonts,
      stylesheetRequests,
      close: async () => {
        try {
          await context.close();
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await context?.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
    throw error;
  }
}
async function withFixture(run, path) {
  const f = await fixture(path);
  try {
    await run(f);
  } finally {
    await f.close();
  }
}

test("default text keeps native Latin and actually consumes an available glyph supplement", async () => {
  await withFixture(async ({ page, fonts }) => {
    await expect(page.locator("#default-latin")).toHaveCSS(
      "font-family",
      defaultFamily,
    );
    expect(await fonts("default-latin")).toEqual(await fonts("native-latin"));
    const supplied = await fonts("default-han");
    // A local() FontFace is reported as a platform font, not isCustomFont.
    // Before adding an explicit reference, only the document default requests it.
    expect(
      await page.evaluate(() => {
        return [...document.fonts].some((face) => {
          return (
            face.family.includes("Okou Browser Default") &&
            face.status === "loaded"
          );
        });
      }),
    ).toBe(true);
    await page.evaluate(() => {
      const reference = document.createElement("span");
      reference.id = "supplement-reference";
      reference.style.fontFamily = '"Okou Browser Default"';
      reference.textContent = "中文測試";
      document.body.append(reference);
    });
    expect(supplied).toEqual(await fonts("supplement-reference"));
    expect(
      await page.evaluate(() => {
        return performance.getEntriesByType("resource").filter((entry) => {
          return entry.initiatorType === "css";
        }).length;
      }),
    ).toBe(0);
  });
});

test("standard preference remains distinct from serif", async () => {
  await withFixture(async ({ page, cdp, fonts }) => {
    const fontFamilies = {
      standard: "Liberation Mono",
      serif: "Liberation Serif",
    };
    await cdp.send("Page.setFontFamilies", {
      fontFamilies,
      forScripts: ["Latn", "Hans", "Zyyy"].map((script) => {
        return {
          script,
          fontFamilies,
        };
      }),
    });
    expect(await fonts("default-latin")).toEqual(await fonts("native-latin"));
    expect(
      (await fonts("default-latin")).map((font) => {
        return font.familyName;
      }),
    ).toContain("Liberation Mono");
    await expect(page.locator("#default-latin")).toHaveCSS(
      "font-family",
      defaultFamily,
    );
  });
});

for (const [path, family] of [
  ["/normal", '"Site A"'],
  ["/layer", '"Site B"'],
  ["/inline", '"Site B"'],
]) {
  test(`authored root font wins at ${path}`, async () => {
    await withFixture(async ({ page, fonts }) => {
      await expect(page.locator("#default-latin")).toHaveCSS(
        "font-family",
        family,
      );
      expect(await fonts("default-latin")).toEqual(
        (
          await fonts(family === '"Site A"' ? "reference-a" : "reference-b")
        ).map((font) => {
          return { ...font, glyphCount: 13 };
        }),
      );
    }, path);
  });
}

test("authored hover, checked and color-scheme fonts retain live selection", async () => {
  await withFixture(async ({ page, fonts }) => {
    for (const id of ["hover", "checked", "scheme"])
      expect(await fonts(id)).toEqual(await fonts("reference-a"));
    await page.locator("#hover").hover();
    expect(await fonts("hover")).toEqual(await fonts("reference-b"));
    await page.locator("#toggle").check();
    expect(await fonts("checked")).toEqual(await fonts("reference-b"));
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await fonts("scheme")).toEqual(await fonts("reference-b"));
  });
});

test("variables, CSS-wide values and opaque system shorthands stay authored", async () => {
  await withFixture(async ({ page, fonts }) => {
    expect(await fonts("variable")).toEqual(await fonts("reference-a"));
    await page.locator("#variable").evaluate((node) => {
      return node.style.setProperty("--family", '"Site B"');
    });
    expect(await fonts("variable")).toEqual(await fonts("reference-b"));
    expect(await fonts("wide")).toEqual(await fonts("initial-reference"));
    expect(await fonts("system")).toEqual(await fonts("caption-reference"));
  });
});

test("site CSSOM edits and removal remain effective without reloading links", async () => {
  await withFixture(async ({ page, fonts, stylesheetRequests }) => {
    const requests = stylesheetRequests.length;
    expect(await fonts("external")).toEqual(await fonts("reference-a"));
    await page.evaluate(() => {
      const sheet = document.getElementById("site-css").sheet;
      sheet.cssRules[0].style.fontFamily = '"Site B"';
    });
    expect(await fonts("external")).toEqual(await fonts("reference-b"));
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.id = "author-root";
      style.textContent = ':root { font-family: "Site A" }';
      document.head.append(style);
    });
    await expect(page.locator("#default-latin")).toHaveCSS(
      "font-family",
      '"Site A"',
    );
    await page.locator("#author-root").evaluate((node) => {
      return node.remove();
    });
    await expect(page.locator("#default-latin")).toHaveCSS(
      "font-family",
      defaultFamily,
    );
    expect(stylesheetRequests.length).toBe(requests);
  });
});

test("native code and control font categories retain their own choices", async () => {
  await withFixture(async ({ page }) => {
    await expect(page.locator("#code")).toHaveCSS("font-family", "monospace");
    expect(
      await page.locator("#text-control").evaluate((node) => {
        return getComputedStyle(node).fontFamily;
      }),
    ).not.toContain("Okou Browser Default");
  });
});

test("default inheritance reaches matching frames, reload and later shadow content", async () => {
  await withFixture(async ({ page }) => {
    await expect(
      page.frameLocator('iframe[name="http"]').locator("#default-latin"),
    ).toHaveCSS("font-family", defaultFamily);
    const blank = page.frame({ name: "blank" });
    await blank.evaluate(() => {
      document.body.innerHTML = '<span id="blank-text">Default text</span>';
    });
    await expect(
      page.frameLocator('iframe[name="blank"]').locator("#blank-text"),
    ).toHaveCSS("font-family", defaultFamily);
    await page.locator("#shadow-host").evaluate((node) => {
      node.attachShadow({ mode: "open" }).innerHTML =
        '<span id="shadow-default">Default text</span><span id="shadow-authored" style="font-family:monospace">Code</span>';
    });
    await expect(page.locator("#shadow-default")).toHaveCSS(
      "font-family",
      defaultFamily,
    );
    await expect(page.locator("#shadow-authored")).toHaveCSS(
      "font-family",
      "monospace",
    );
    await page.reload();
    await expect(page.locator("#default-latin")).toHaveCSS(
      "font-family",
      defaultFamily,
    );
  });
});

test("manifest CSS supplies defaults when page inline styles are forbidden", async () => {
  await withFixture(async ({ page }) => {
    await expect(page.locator("#default-latin")).toHaveCSS(
      "font-family",
      defaultFamily,
    );
    expect(await page.locator("html").getAttribute("style")).toBeNull();
  }, "/csp");
});
