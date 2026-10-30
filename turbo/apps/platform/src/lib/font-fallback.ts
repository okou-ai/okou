import { parse } from "@adobe/css-tools";
import { fetchResource } from "./resource-fetch.ts";
import { fontScripts, type FontScript } from "./font-scripts.ts";

function scriptRanges(value: string, script: FontScript): string {
  return value
    .split(",")
    .flatMap((part) => {
      const match = /^U\+([\da-f?]{1,6})(?:-([\da-f]{1,6}))?$/iu.exec(
        part.trim(),
      );
      if (!match || (match[1].includes("?") && match[2])) {
        throw new Error("Invalid font Unicode range");
      }
      const start = Number.parseInt(match[1].replaceAll("?", "0"), 16);
      const end = Number.parseInt(
        match[2] ?? match[1].replaceAll("?", "f"),
        16,
      );
      if (start > end || end > 0x10_ff_ff) {
        throw new Error("Invalid font Unicode range bounds");
      }
      return script.ranges.flatMap(([first, last]) => {
        const low = Math.max(first, start);
        const high = Math.min(last, end);
        return low <= high
          ? [`U+${low.toString(16)}-${high.toString(16)}`]
          : [];
      });
    })
    .join(",");
}

async function supplementalFaces(css: string, missing: readonly FontScript[]) {
  const faces: FontFace[] = [];
  const supplied = new Set<string>();
  // Parse data only. Never construct, adopt or inject Google's stylesheet.
  for (const rule of parse(css).stylesheet.rules) {
    if (rule.type !== "font-face") {
      continue;
    }
    const descriptors = new Map(
      rule.declarations
        .filter((node) => {
          return node.type === "declaration";
        })
        .map((node) => {
          return [node.property, node.value];
        }),
    );
    const family = descriptors
      .get("font-family")
      ?.replace(/^(['"])(.*)\1$/u, "$2");
    const source = descriptors.get("src");
    if (!family || !source) {
      continue;
    }
    for (const script of missing) {
      if (!script.families.includes(family)) {
        continue;
      }
      const unicodeRange = scriptRanges(
        descriptors.get("unicode-range") ?? "U+0-10FFFF",
        script,
      );
      if (!unicodeRange) {
        continue;
      }
      const face = new FontFace(
        `Okou Fallback ${script.name} ${family}`,
        source,
        {
          unicodeRange,
          style: descriptors.get("font-style") ?? "normal",
          weight: descriptors.get("font-weight") ?? "normal",
          display: "swap",
        },
      );
      if (face.status === "error") {
        // Constructor descriptor errors reject loaded instead of throwing.
        // Observe that rejection without loading valid remote font sources.
        await face.loaded;
      }
      faces.push(face);
      supplied.add(`${script.name}:${family}`);
    }
  }
  for (const script of missing) {
    for (const family of script.families) {
      if (!supplied.has(`${script.name}:${family}`)) {
        throw new Error(
          `Missing font descriptors for ${script.name}:${family}`,
        );
      }
    }
  }
  return faces;
}

/** Supplement known missing writing systems without replacing native stacks.
 * Local face presence is not proof of arbitrary custom/partial glyph coverage.
 */
export async function installFontFallback(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const results = await Promise.allSettled(
    fontScripts.map((script) => {
      // Unattached faces: probing never changes matching or loads a URL.
      return new FontFace(
        `Okou Probe ${script.name}`,
        script.localFaces
          .map((name) => {
            return `local("${name}")`;
          })
          .join(","),
      ).load();
    }),
  );
  signal.throwIfAborted();
  const missing = fontScripts.filter((_script, index) => {
    const result = results[index];
    if (result.status === "fulfilled") {
      return false;
    }
    if (
      result.reason instanceof DOMException &&
      result.reason.name === "NetworkError"
    ) {
      return true;
    }
    throw result.reason;
  });
  if (missing.length === 0) {
    return;
  }
  const url = new URL("https://fonts.googleapis.com/css2");
  const families = new Set(
    missing.flatMap((script) => {
      return script.families;
    }),
  );
  // Google requires sorted families; no user or conversation text is sent.
  for (const family of [...families].sort()) {
    url.searchParams.append("family", `${family}:wght@400..700`);
  }
  url.searchParams.set("display", "swap");
  const response = await fetchResource(url, {}, signal);
  signal.throwIfAborted();
  if (!response.ok) {
    throw new Error(`Font metadata request failed: ${response.status}`);
  }
  const css = await response.text();
  signal.throwIfAborted();
  // Finish parsing and constructing every face before changing page state.
  const faces = await supplementalFaces(css, missing);
  signal.throwIfAborted();
  const root = document.documentElement;
  const fonts = document.fonts;
  const computed = getComputedStyle(root);
  // Read the actual upstream defaults rather than copying Tailwind's stacks.
  // Only missing-script installs wrap these; native-only pages change nothing.
  const overrides = [
    {
      property: "--font-fallback-prefix",
      value: `${missing
        .map((script) => {
          return script.prefix;
        })
        .join(",")},`,
    },
    ...["--font-sans", "--font-serif", "--font-mono"].flatMap((property) => {
      const native = computed.getPropertyValue(property).trim();
      return native
        ? [{ property, value: `var(--font-fallback-prefix,) ${native}` }]
        : [];
    }),
  ].map((override) => {
    return {
      ...override,
      previous: root.style.getPropertyValue(override.property),
      priority: root.style.getPropertyPriority(override.property),
    };
  });
  signal.addEventListener(
    "abort",
    () => {
      for (const face of faces) {
        fonts.delete(face);
      }
      for (const override of overrides) {
        root.style.setProperty(
          override.property,
          override.previous,
          override.priority,
        );
      }
    },
    { once: true },
  );
  for (const face of faces) {
    fonts.add(face);
  }
  for (const override of overrides) {
    root.style.setProperty(override.property, override.value);
  }
}
