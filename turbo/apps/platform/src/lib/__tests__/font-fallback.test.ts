import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import {
  createTestRuntime,
  testContext,
} from "../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../signals/utils.ts";
import { installFontFallback } from "../font-fallback.ts";

const context = testContext();
const nativeCjk = "NotoSansCJKsc-Regular";
const nativeDevanagari = "NotoSansDevanagari-Regular";

function metadata(families: readonly string[], range = "U+0-10FFFF") {
  return families
    .map((family) => {
      return `/* provider subset */ @font-face {
        font-family: '${family}'; font-style: normal; font-weight: 400 700;
        src: url(https://fonts.gstatic.com/test.woff2) format('woff2');
        unicode-range: ${range};
      }`;
    })
    .join("\n");
}

test("native script supply keeps the font registry and prefix unchanged without metadata", async () => {
  const fonts = context.mocks.browser.fonts([nativeCjk, nativeDevanagari]);
  let requests = 0;
  context.mocks.http.get("https://fonts.googleapis.com/css2", () => {
    requests++;
    return new HttpResponse(null, { status: 500 });
  });
  await installFontFallback(context.signal);
  expect(requests).toBe(0);
  expect(fonts.size).toBe(0);
  expect(
    document.documentElement.style.getPropertyValue("--font-fallback-prefix"),
  ).toBe("");
});

test("partial native coverage requests only Devanagari, without claiming Latin or native Han", async () => {
  const fonts = context.mocks.browser.fonts([nativeCjk]);
  context.mocks.http.get("https://fonts.googleapis.com/css2", ({ request }) => {
    expect(new URL(request.url).searchParams.getAll("family")).toStrictEqual([
      "Noto Sans Devanagari:wght@400..700",
    ]);
    expect(request.credentials).toBe("omit");
    return HttpResponse.text(metadata(["Noto Sans Devanagari"]));
  });
  await installFontFallback(context.signal);
  expect([...fonts]).toMatchObject([
    {
      family: "Okou Fallback Devanagari Noto Sans Devanagari",
      unicodeRange: "U+900-97f,U+a8e0-a8ff,U+11b00-11b5f",
      weight: "400 700",
      style: "normal",
      display: "swap",
    },
  ]);
  expect(
    document.documentElement.style.getPropertyValue("--font-fallback-prefix"),
  ).toBe('"Okou Fallback Devanagari Noto Sans Devanagari",');
});

test("missing CJK preserves native Devanagari and registers independently scoped Han/Kana/Hangul", async () => {
  const fonts = context.mocks.browser.fonts([nativeDevanagari]);
  const runtime = createTestRuntime(context);
  const existing = new FontFace("Page owned face", 'local("unrelated")');
  // Another page owner must survive cleanup of the supplemental supply.
  document.fonts.add(existing);
  context.mocks.http.get("https://fonts.googleapis.com/css2", ({ request }) => {
    const families = new URL(request.url).searchParams.getAll("family");
    expect(families).toStrictEqual([
      "Noto Sans JP:wght@400..700",
      "Noto Sans KR:wght@400..700",
      "Noto Sans SC:wght@400..700",
      "Noto Sans TC:wght@400..700",
    ]);
    return HttpResponse.text(
      metadata([
        "Noto Sans JP",
        "Noto Sans KR",
        "Noto Sans SC",
        "Noto Sans TC",
      ]),
    );
  });
  await installFontFallback(runtime.signal);
  expect(fonts.size).toBe(7);
  expect(
    [...fonts].find((face) => {
      return face.family.includes("Kana");
    })?.unicodeRange,
  ).toBe("U+3040-30ff,U+31f0-31ff,U+ff61-ff9f,U+1aff0-1afff,U+1b000-1b16f");
  expect(
    [...fonts].find((face) => {
      return face.family.includes("Hangul");
    })?.unicodeRange,
  ).toBe("U+1100-11ff,U+3130-318f,U+a960-a97f,U+ac00-d7ff");
  expect(
    document.documentElement.style.getPropertyValue("--font-fallback-prefix"),
  ).toContain("var(--font-fallback-han)");
  runtime.dispose();
  expect(
    [...fonts].map((face) => {
      return face.family;
    }),
  ).toStrictEqual(["Page owned face"]);
  expect(
    document.documentElement.style.getPropertyValue("--font-fallback-prefix"),
  ).toBe("");
});

test("provider wildcard subsets are intersected; Latin-only rules cannot shadow native fonts", async () => {
  const fonts = context.mocks.browser.fonts([nativeCjk]);
  context.mocks.http.get("https://fonts.googleapis.com/css2", () => {
    return HttpResponse.text(
      metadata(["Noto Sans Devanagari"], "U+0-FF") +
        metadata(["Noto Sans Devanagari"], "U+09??, U+A8E0-A8F0"),
    );
  });
  await installFontFallback(context.signal);
  expect(
    [...fonts].map((face) => {
      return face.unicodeRange;
    }),
  ).toStrictEqual(["U+900-97f,U+a8e0-a8f0"]);
});

test("standard utilities wrap the upstream CSSOM values and release their overrides on abort", async () => {
  context.mocks.browser.fonts([nativeCjk]);
  const runtime = createTestRuntime(context);
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const tokens = new Map([
    ["--font-sans", "system-ui,sans-serif"],
    ["--font-serif", 'Georgia,"Times New Roman",serif'],
    ["--font-mono", "ui-monospace,monospace"],
  ]);
  vi.spyOn(computed, "getPropertyValue").mockImplementation((property) => {
    return tokens.get(property) ?? "";
  });
  vi.spyOn(window, "getComputedStyle").mockReturnValue(computed);
  context.mocks.http.get("https://fonts.googleapis.com/css2", () => {
    return HttpResponse.text(metadata(["Noto Sans Devanagari"]));
  });
  await installFontFallback(runtime.signal);
  for (const [property, value] of tokens) {
    expect(root.style.getPropertyValue(property)).toBe(
      `var(--font-fallback-prefix,) ${value}`,
    );
  }
  runtime.dispose();
  for (const property of tokens.keys()) {
    expect(root.style.getPropertyValue(property)).toBe("");
  }
});

test.each([
  { name: "HTTP error", body: "", status: 503, error: /request failed: 503/u },
  { name: "malformed CSS", body: "@font-face {", status: 200, error: /\}/u },
  {
    name: "missing script descriptors",
    body: metadata(["Noto Sans Devanagari"], "U+0-FF"),
    status: 200,
    error: /Missing font descriptors/u,
  },
])(
  "$name leaves no partial font registration or prefix",
  async ({ body, status, error }) => {
    const fonts = context.mocks.browser.fonts([nativeCjk]);
    context.mocks.http.get("https://fonts.googleapis.com/css2", () => {
      return new HttpResponse(body, { status });
    });
    await expect(installFontFallback(context.signal)).rejects.toThrow(error);
    expect(fonts.size).toBe(0);
    expect(
      document.documentElement.style.getPropertyValue("--font-fallback-prefix"),
    ).toBe("");
  },
);

test("root abort cancels metadata and prevents late font registration", async () => {
  const fonts = context.mocks.browser.fonts([nativeCjk]);
  const runtime = createTestRuntime(context);
  const requested = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  const responded = createDeferredPromise<void>(context.signal);
  context.mocks.http.get("https://fonts.googleapis.com/css2", async () => {
    requested.resolve();
    await release.promise;
    responded.resolve();
    return HttpResponse.text(metadata(["Noto Sans Devanagari"]));
  });
  const result = Promise.allSettled([installFontFallback(runtime.signal)]);
  await requested.promise;
  runtime.dispose();
  await expect(result).resolves.toMatchObject([
    { status: "rejected", reason: { name: "AbortError" } },
  ]);
  release.resolve();
  await responded.promise;
  expect(fonts.size).toBe(0);
  expect(
    document.documentElement.style.getPropertyValue("--font-fallback-prefix"),
  ).toBe("");
});

test("unexpected local probe errors propagate without turning into a web-font decision", async () => {
  const fonts = context.mocks.browser.fonts([]);
  vi.spyOn(FontFace.prototype, "load").mockRejectedValue(
    new DOMException("Invalid font source", "SyntaxError"),
  );
  await expect(installFontFallback(context.signal)).rejects.toMatchObject({
    name: "SyntaxError",
  });
  expect(fonts.size).toBe(0);
});

test("abort during local capability probing prevents a metadata request", async () => {
  const fonts = context.mocks.browser.fonts([]);
  const runtime = createTestRuntime(context);
  const result = installFontFallback(runtime.signal);
  runtime.dispose();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(fonts.size).toBe(0);
});

test("no native script faces registers all seven scoped families without eager font loading", async () => {
  const fonts = context.mocks.browser.fonts([]);
  context.mocks.http.get("https://fonts.googleapis.com/css2", ({ request }) => {
    const families = new URL(request.url).searchParams.getAll("family");
    expect(families).toHaveLength(5);
    return HttpResponse.text(
      metadata(
        families.map((family) => {
          return family.split(":")[0];
        }),
      ),
    );
  });
  await installFontFallback(context.signal);
  expect(fonts.size).toBe(7);
  expect(
    [...fonts].every((face) => {
      return face.unicodeRange !== "U+0-10FFFF";
    }),
  ).toBeTruthy();
});
