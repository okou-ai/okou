import { vi } from "vitest";

/** Models font availability/registration only. Actual glyphs need Chromium. */
export function mockFonts(localFaces: readonly string[], signal: AbortSignal) {
  class BrowserFontFace {
    readonly unicodeRange: string;
    readonly style: string;
    readonly weight: string;
    readonly display: string;

    constructor(
      readonly family: string,
      readonly source: string,
      descriptors: FontFaceDescriptors = {},
    ) {
      this.unicodeRange = descriptors.unicodeRange ?? "U+0-10FFFF";
      this.style = descriptors.style ?? "normal";
      this.weight = descriptors.weight ?? "normal";
      this.display = descriptors.display ?? "auto";
    }

    load() {
      if (
        !localFaces.some((name) => {
          return this.source.includes(`local("${name}")`);
        })
      ) {
        return Promise.reject(
          new DOMException("No matching local font", "NetworkError"),
        );
      }
      return Promise.resolve(this);
    }
  }

  vi.stubGlobal("FontFace", BrowserFontFace);
  class BrowserFontFaceSet extends EventTarget {
    private readonly faces = new Set<BrowserFontFace>();

    get size() {
      return this.faces.size;
    }

    get ready() {
      return Promise.resolve(this);
    }

    add(face: BrowserFontFace) {
      this.faces.add(face);
      return this;
    }

    delete(face: BrowserFontFace) {
      return this.faces.delete(face);
    }

    [Symbol.iterator]() {
      return this.faces.values();
    }
  }
  const fonts = new BrowserFontFaceSet();
  const descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fonts,
  });
  signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(document, "fonts", descriptor);
      } else {
        Reflect.deleteProperty(document, "fonts");
      }
    },
    { once: true },
  );
  return fonts;
}
