import { chromium, expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const defaultFamily = (region = "SC") => {
  const regions = [
    region,
    ...["SC", "TC", "JP", "KR"].filter((r) => {
      return r !== region;
    }),
  ];
  return [
    "-webkit-body",
    '"Okou Browser Noto Sans"',
    ...regions.map((r) => {
      return `"Okou Browser Noto ${r}"`;
    }),
  ].join(", ");
};
const greek = "Αλφάβητο ABC 123";
// Controlled supply keeps native CI independent of Google's availability.
// Real Google download/selection and regional faces are verified in Browser Use.
const supply =
  Object.entries({
    SC: "U+3040-30FF, U+4E00-9FFF",
    TC: "U+3040-30FF, U+4E00-7B7F, U+7B81-9FFF",
    JP: "U+3040-30FF, U+4E00-7B7F, U+7B81-9FFF",
    KR: "U+3040-30FF, U+4E00-7B7F, U+7B81-9FFF, U+AC00-D7AF",
  })
    .map(([region, range]) => {
      return `@font-face {
      font-family: 'Okou Browser Noto ${region}';
      font-weight: 400;
      src: local('Noto Sans CJK ${region}'), local('Unifont'), local('WenQuanYi Zen Hei'), local('IPAGothic');
      unicode-range: ${range};
    }`;
    })
    .join("\n") +
  `@font-face {
    font-family: 'Okou Browser Noto Sans';
    font-weight: 400;
    src: local('NotoSansDevanagari-Regular'), local('Unifont');
    unicode-range: U+0900-097F;
  }`;
const styles = `
  @font-face { font-family: 'Site A'; src: local('Liberation Sans'), local('Arial'); }
  @font-face { font-family: 'Site B'; src: local('Liberation Mono'), local('Courier New'); }
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
    if (request.url === "/mixed") {
      response.end(
        `<!doctype html><html lang="en"><head><style>${styles}${supply}</style></head><body></body></html>`,
      );
      return;
    }
    if (request.url === "/site.css") {
      response.setHeader("Content-Type", "text/css");
      response.end('.external { font-family: "Site A"; }');
      return;
    }
    if (request.url === "/csp") {
      response.setHeader("Content-Security-Policy", "style-src 'none'");
      response.end(
        '<!doctype html><html><body><span id="default-latin">ABC 123 iiiWW</span></body></html>',
      );
      return;
    }
    if (request.url === "/font-csp")
      response.setHeader("Content-Security-Policy", "font-src 'none'");
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
      <style>${styles}${request.url === "/font-csp" ? "" : supply}${rootStyle}</style><link id="site-css" rel="stylesheet" href="/site.css">
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
    if (path !== "/font-csp") {
      // Controlled local supply must not depend on Google's live availability.
      // Leave the policy fixture un-intercepted to exercise actual CSP denial.
      await context.route("https://fonts.gstatic.com/**", (route) => {
        return route.abort();
      });
    }
    const stylesheetRequests = [];
    const fontRequests = [];
    const fontResponses = [];
    page.on("request", (request) => {
      if (request.resourceType() === "font") fontRequests.push(request);
      if (request.url() === origin + "/site.css")
        stylesheetRequests.push(request);
    });
    page.on("response", (response) => {
      if (response.request().resourceType() === "font")
        fontResponses.push(response.status());
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
      fontRequests,
      fontResponses,
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
      defaultFamily(),
    );
    expect(await fonts("default-latin")).toEqual(await fonts("native-latin"));
    const supplied = await fonts("default-han");
    // A local() FontFace is reported as a platform font, not isCustomFont.
    // Before adding an explicit reference, only the document default requests it.
    expect(
      await page.evaluate(() => {
        return [...document.fonts].some((face) => {
          return (
            face.family.includes("Okou Browser Noto SC") &&
            face.status === "loaded"
          );
        });
      }),
    ).toBe(true);
    await page.evaluate(() => {
      const reference = document.createElement("span");
      reference.id = "supplement-reference";
      reference.style.fontFamily = '"Okou Browser Noto SC"';
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
      defaultFamily(),
    );
  });
});

test("root language changes select regional default glyph supply", async () => {
  await withFixture(async ({ page, fonts }) => {
    await page.evaluate(() => {
      const reference = document.createElement("span");
      reference.id = "regional-reference";
      reference.textContent = "中文測試";
      document.body.append(reference);
    });
    for (const [lang, region] of [
      ["zh-Hant", "TC"],
      ["zh-TW", "TC"],
      ["ja-JP", "JP"],
      ["ko-KR", "KR"],
      ["zh-Hans", "SC"],
    ]) {
      await page.evaluate(
        ({ lang, region }) => {
          document.documentElement.lang = lang;
          document.getElementById("regional-reference").style.fontFamily =
            `"Okou Browser Noto ${region}"`;
          document.body.getBoundingClientRect();
          return document.fonts.ready;
        },
        { lang, region },
      );
      await expect(page.locator("#default-han")).toHaveCSS(
        "font-family",
        defaultFamily(region),
      );
      expect(await fonts("default-han")).toEqual(
        await fonts("regional-reference"),
      );
    }
  });
});

for (const [lang, region] of [
  ["en", "SC"],
  ["zh-Hans", "SC"],
  ["zh-Hant", "TC"],
  ["ja", "JP"],
  ["ko", "KR"],
]) {
  test(`mixed-script fallback remains reachable under ${lang} roots`, async () => {
    await withFixture(async ({ page, fonts, fontRequests }) => {
      const samples = [
        ["mixed-korean", "한국어안녕하세요", "KR"],
        ["mixed-han", "简", "SC"],
        ["mixed-kana", "こんにちは", region],
        ["mixed-hindi", "हिन्दी", "Sans"],
      ];
      await page.evaluate(
        ({ lang, samples }) => {
          document.documentElement.lang = lang;
          const container = document.createElement("div");
          // An English-language child must keep access to the inherited tail,
          // without selecting a CJK-capable native standard from the root lang.
          container.lang = "en";
          container.id = "mixed-defaults";
          for (const [id, text] of samples) {
            const span = document.createElement("span");
            span.id = id;
            span.textContent = text;
            container.append(span);
          }
          document.body.append(container);
          container.getBoundingClientRect();
          return document.fonts.ready;
        },
        { lang, samples: samples.slice(0, 1) },
      );
      // Hangul must skip the unrelated remote faces before the KR supply.
      expect(fontRequests).toHaveLength(0);
      await page.evaluate((samples) => {
        const container = document.getElementById("mixed-defaults");
        for (const [id, text] of samples) {
          const span = document.createElement("span");
          span.id = id;
          span.textContent = text;
          container.append(span);
        }
        container.getBoundingClientRect();
        return document.fonts.ready;
      }, samples.slice(1));
      // Check before direct reference faces can trigger their own loading.
      const loaded = await page.evaluate(() => {
        return [...document.fonts]
          .filter((face) => {
            return face.status === "loaded";
          })
          .map((face) => {
            return face.family.replaceAll('"', "");
          });
      });
      for (const [id, text, region] of samples) {
        const family = `Okou Browser Noto ${region}`;
        expect(loaded).toContain(family);
        const selected = await fonts(id);
        expect(selected.length).toBeGreaterThan(0);
        await page.evaluate(
          ({ id, text, family }) => {
            const reference = document.createElement("span");
            reference.id = `${id}-reference`;
            reference.lang = "en";
            reference.style.fontFamily = `"${family}"`;
            reference.textContent = text;
            document.body.append(reference);
            reference.getBoundingClientRect();
            return document.fonts.ready;
          },
          { id, text, family },
        );
        expect(selected).toEqual(await fonts(`${id}-reference`));
      }
    }, "/mixed");
  });
}

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
      defaultFamily(),
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
    ).not.toContain("Okou Browser Noto");
  });
});

test("default inheritance reaches matching frames, reload and later shadow content", async () => {
  await withFixture(async ({ page }) => {
    await expect(
      page.frameLocator('iframe[name="http"]').locator("#default-latin"),
    ).toHaveCSS("font-family", defaultFamily());
    const blank = page.frame({ name: "blank" });
    await blank.evaluate(() => {
      document.body.innerHTML = '<span id="blank-text">Default text</span>';
    });
    await expect(
      page.frameLocator('iframe[name="blank"]').locator("#blank-text"),
    ).toHaveCSS("font-family", defaultFamily());
    await page.locator("#shadow-host").evaluate((node) => {
      node.attachShadow({ mode: "open" }).innerHTML =
        '<span id="shadow-default">Default text</span><span id="shadow-authored" style="font-family:monospace">Code</span>';
    });
    await expect(page.locator("#shadow-default")).toHaveCSS(
      "font-family",
      defaultFamily(),
    );
    await expect(page.locator("#shadow-authored")).toHaveCSS(
      "font-family",
      "monospace",
    );
    await page.reload();
    await expect(page.locator("#default-latin")).toHaveCSS(
      "font-family",
      defaultFamily(),
    );
  });
});

test("manifest CSS supplies defaults when page inline styles are forbidden", async () => {
  await withFixture(async ({ page }) => {
    await expect(page.locator("#default-latin")).toHaveCSS(
      "font-family",
      defaultFamily(),
    );
    expect(await page.locator("html").getAttribute("style")).toBeNull();
  }, "/csp");
});

test("font-src denial preserves native glyphs with bounded policy noise", async () => {
  await withFixture(async ({ page, fonts, fontRequests, fontResponses }) => {
    await expect(page.locator("#default-han")).toHaveCSS(
      "font-family",
      defaultFamily(),
    );
    expect(await fonts("default-han")).toEqual(await fonts("native-han"));
    expect(
      await page.evaluate(() => {
        return [...document.fonts].some((face) => {
          return (
            face.family.includes("Okou Browser Noto") && face.status === "error"
          );
        });
      }),
    ).toBe(true);
    expect(fontResponses).toHaveLength(0);
    // A large split-face set reports even unused denied sources on strict pages.
    // Keep this actual browser request boundary small, independent of glyphs.
    expect(fontRequests.length).toBeGreaterThan(0);
    expect(fontRequests.length).toBeLessThanOrEqual(6);
  }, "/font-csp");
});
