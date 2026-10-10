/**
 * Tests for okou presentation convert.
 *
 * Mocks only the external binaries (agent-browser and the npm/tar fetch of the
 * renderer bundle). Command parsing, the capability guard, artifact transfer,
 * and coverage grading run unchanged. Browser layout and renderer fidelity need
 * real-browser comparisons using the focused HTML fixtures beside this test.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { crc32, inflateRawSync } from "zlib";

import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { presentationCommand } from "../index";

/** Named here rather than imported, so the published address stays pinned. */
const RENDERER_BUNDLE = "dom-to-pptx.bundle.js";
const RENDERER_CDN = `https://cdn.jsdelivr.net/npm/dom-to-pptx@2.1.2/dist/${RENDERER_BUNDLE}`;

/** Slide XML representing the renderer's artifact, including its text policy. */
function slideXml(texts: readonly string[]): string {
  const runs = texts
    .map((text) => {
      return (
        `<a:p><a:r><a:rPr lang="en-US" sz="7680" dirty="0">` +
        `<a:latin typeface="Lexend"/><a:ea typeface="Lexend"/>` +
        `</a:rPr><a:t>${text}</a:t></a:r></a:p>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>` +
    `<p:sp><p:spPr><a:xfrm><a:off x="0" y="86"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0"><a:spAutoFit/></a:bodyPr>` +
    `${runs}</p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:sld>`
  );
}

/**
 * A renderer artifact constructed independently of the command. Include a
 * directory entry and stored contents to verify unrelated package parts survive
 * geometry corrections, not just the slide strings the verifier reads.
 */
function storedZip(entries: readonly (readonly [string, string])[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const rawName = Buffer.from(name, "utf8");
    const content = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(rawName.length, 26);
    locals.push(local, rawName, content);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc32(content), 16);
    entry.writeUInt32LE(content.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(rawName.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, rawName);
    offset += local.length + rawName.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads a produced deck the way a consumer would, without the command's writer. */
function readZip(archive: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    const start =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const raw = archive.subarray(start, start + compressedSize);
    out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const state = {
  /** Text the fake page reports, which the produced deck must account for. */
  pageTexts: ["Hello deck", "Second line"] as string[],
  /** Text the fake renderer writes into the deck; differs to force a shortfall. */
  deckTexts: undefined as string[] | undefined,
  sourcePages: undefined as string[][] | undefined,
  measuredPages: undefined as string[][] | undefined,
  paintRegions: [] as {
    id: number;
    mode: "background" | "content";
    features: string[];
    tag: string;
    textStrings: number;
    x: number;
    y: number;
    w: number;
    h: number;
    padding: number;
  }[],
  badScreenshot: false,
  deckPages: undefined as string[][] | undefined,
  slideXml: undefined as string[] | undefined,
  textBoxes: [] as {
    x: number;
    y: number;
    w: number;
    h: number;
    eastAsianFont: string;
    complexFont: string;
    strike: boolean;
    underlineColor: string;
    underlineWidth: number;
  }[],
  tables: [] as {
    x: number;
    y: number;
    w: number;
    h: number;
    rows: number[];
    fills: string[][];
  }[],
  orderedLists: [] as {
    x: number;
    y: number;
    w: number;
    h: number;
    numbers: number[];
    markers: {
      color: string;
      font: string;
      size: number;
      gap: number;
      offset: number;
      leading: number;
    }[];
  }[],
  /** Every expression the command evaluated in the page, in order. */
  evaluated: [] as string[],
  openedUrls: [] as string[],
  slideCount: 2,
  /** Base64 the fake page holds for the chunked transfer. */
  transferable: "",
};

function deckBase64(): string {
  const texts = state.deckTexts ?? state.pageTexts;
  const entries: (readonly [string, string])[] = [
    ["[Content_Types].xml", "<Types/>"],
    ["ppt/media/", ""],
    [
      "ppt/presentation.xml",
      '<p:presentation><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
    ],
    [
      "ppt/slides/slide1.xml",
      state.slideXml?.[0] ??
        slideXml(state.deckPages?.[0] ?? texts.slice(0, 1)),
    ],
    [
      "ppt/slides/slide2.xml",
      state.slideXml?.[1] ?? slideXml(state.deckPages?.[1] ?? texts.slice(1)),
    ],
  ];
  return storedZip(entries).toString("base64");
}

/** Answers the page scripts the command evaluates, in the order it evaluates them. */
function fakeEval(expression: string): string {
  state.evaluated.push(expression);
  // agent-browser prints the evaluated value JSON-encoded, and the page scripts
  // already stringify their result, so a string answer is encoded twice.
  const encoded = (value: unknown): string => {
    return JSON.stringify(JSON.stringify(value));
  };

  // Ordered most specific first: the selector probe also queries and reads
  // `.length`, so a looser branch above it would answer for both.
  if (expression.includes("scored.sort")) return encoded(".stage");
  if (expression.includes("No visible slide supplies")) return "0";
  if (expression.includes("window.__okouPaintTargets=targets")) {
    return encoded({
      pages: (
        state.sourcePages ?? [
          state.pageTexts.slice(0, 1),
          state.pageTexts.slice(1),
        ]
      ).map((texts, index) => {
        return {
          width: 1600,
          height: 900,
          texts,
          regions: index === 0 ? state.paintRegions : [],
        };
      }),
    });
  }
  if (expression.includes("viewportWidth:window.innerWidth")) {
    return encoded({ x: 0, y: 0, viewportWidth: 1600, viewportHeight: 900 });
  }
  if (expression.includes("window.__okouRestoreLayout =")) {
    return encoded({
      pages: (
        state.measuredPages ??
        state.sourcePages ?? [
          state.pageTexts.slice(0, 1),
          state.pageTexts.slice(1),
        ]
      ).map((texts, index) => {
        return {
          width: 1600,
          height: 900,
          texts,
          tables: state.tables,
          orderedLists: index === 0 ? state.orderedLists : [],
          textBoxes: state.textBoxes,
        };
      }),
      activated: 0,
      fragmented: 0,
    });
  }
  if (expression.includes("exportToPptx")) {
    state.transferable = deckBase64();
    return encoded({
      slides: state.slideCount,
      length: state.transferable.length,
    });
  }
  const slice = /__okouPptx\.slice\((\d+),(\d+)\)/u.exec(expression);
  if (slice) {
    return encoded(
      state.transferable.slice(Number(slice[1]), Number(slice[2])),
    );
  }
  // awaitSlides reads a count, and the remaining scripts return a plain 1.
  if (
    expression.includes("querySelectorAll(") &&
    expression.includes(".length")
  ) {
    return String(state.slideCount);
  }
  return "1";
}

vi.mock("child_process", () => {
  return {
    execFileSync: vi.fn(
      (
        command: string,
        args: readonly string[],
        options?: { cwd?: string },
      ) => {
        if (command === "agent-browser") {
          const verb = args[args.indexOf("--allow-file-access") + 1];
          if (verb === "eval") {
            return fakeEval(args[args.length - 1] ?? "");
          }
          if (verb === "open") {
            state.openedUrls.push(args[args.length - 1] ?? "");
          }
          if (verb === "screenshot") {
            const image = new PNG({ width: 1600, height: 900 });
            image.data.fill(255);
            writeFileSync(
              args[args.length - 1] ?? "",
              state.badScreenshot ? "invalid PNG" : PNG.sync.write(image),
            );
          }
          return "";
        }
        if (command === "npm") {
          // `npm pack` writes a tarball the command then unpacks.
          writeFileSync(join(options?.cwd ?? ".", "renderer.tgz"), "tarball");
          return "";
        }
        if (command === "tar") {
          const target = args[args.indexOf("-C") + 1] ?? ".";
          writeFileSync(join(target, "dom-to-pptx.bundle.js"), "bundle");
          return "";
        }
        throw new Error(`unexpected command: ${command}`);
      },
    ),
  };
});

function okouToken(capabilities: readonly string[]): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId: "u",
      runId: "r",
      orgId: "o",
      scope: "okou",
      capabilities,
      iat: 0,
      exp: 0,
    }),
  ).toString("base64url");
  return `vm0_sandbox_header.${payload}.signature`;
}

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

function stderr(): string {
  return errorSpy.mock.calls
    .map((call) => {
      return String(call[0]);
    })
    .join("\n");
}

let workDir = "";
let cacheHome = "";
let deckPath = "";
let outPath = "";

async function convert(args: readonly string[]): Promise<void> {
  await presentationCommand.parseAsync(
    ["convert", "--input", deckPath, "--out", outPath, ...args],
    { from: "user" },
  );
}

describe("okou presentation convert", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "okou-convert-"));
    cacheHome = mkdtempSync(join(tmpdir(), "okou-convert-cache-"));
    deckPath = join(workDir, "deck.html");
    outPath = join(workDir, "out.pptx");
    writeFileSync(deckPath, "<html></html>");
    vi.stubEnv("OKOU_TOKEN", okouToken(["presentation-convert:write"]));
    vi.stubEnv("XDG_CACHE_HOME", cacheHome);
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy.mockClear();
    state.pageTexts = ["Hello deck", "Second line"];
    state.deckTexts = undefined;
    state.sourcePages = undefined;
    state.measuredPages = undefined;
    state.paintRegions = [];
    state.badScreenshot = false;
    state.deckPages = undefined;
    state.slideXml = undefined;
    state.textBoxes = [];
    state.tables = [];
    state.orderedLists = [];
    state.evaluated = [];
    state.openedUrls = [];
    state.slideCount = 2;
    state.transferable = "";
  });

  afterEach(() => {
    rmSync(workDir, { force: true, recursive: true });
    rmSync(cacheHome, { force: true, recursive: true });
    vi.unstubAllEnvs();
    errorSpy.mockClear();
  });

  it("refuses a run whose token lacks the conversion capability", async () => {
    vi.stubEnv("OKOU_TOKEN", okouToken(["artifact:read"]));
    await expect(convert([])).rejects.toThrow(/process\.exit/u);
    expect(stderr()).toContain("not enabled for this agent run");
  });

  it("rejects a slide width that is not a positive number", async () => {
    await expect(convert(["--width", "0"])).rejects.toThrow(
      /positive number|process\.exit/u,
    );
  });

  it("holds measured geometry fixed without shrinking text or changing unrelated parts", async () => {
    await convert([]);
    const parts = readZip(readFileSync(outPath));
    expect(parts.get("[Content_Types].xml")).toBe("<Types/>");
    expect(parts.get("ppt/media/")).toBe("");
    expect(parts.get("ppt/slides/slide1.xml")).toBe(
      slideXml(["Hello deck"]).replace("<a:spAutoFit/>", "<a:noAutofit/>"),
    );
    expect(parts.get("ppt/slides/slide2.xml")).toBe(
      slideXml(["Second line"]).replace("<a:spAutoFit/>", "<a:noAutofit/>"),
    );
  });

  it("preserves ordered-list start and explicit item values", async () => {
    state.slideXml = [
      slideXml(["Eight", "Twelve", "Thirteen"])
        .replaceAll(
          "<a:p>",
          '<a:p><a:pPr><a:buAutoNum type="arabicPeriod" startAt="1"/></a:pPr>',
        )
        .replace(
          '<a:bodyPr wrap="square">',
          '<a:bodyPr wrap="square" lIns="0">',
        ),
      slideXml(["Second line"]),
    ];
    state.orderedLists = [
      {
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        numbers: [8, 12, 13],
        markers: [8, 12, 13].map(() => {
          return {
            color: "2563EB",
            font: "Liberation Sans",
            size: 32,
            gap: 30,
            offset: 0,
            leading: 0,
          };
        }),
      },
    ];
    await convert([]);
    const xml = readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml");
    expect(xml).toContain('startAt="8"');
    expect(xml).toContain('startAt="12"');
    expect(xml).toContain('startAt="13"');
    expect(xml).toContain('<a:buClr><a:srgbClr val="2563EB"/></a:buClr>');
    expect(xml).toContain('<a:buFont typeface="Liberation Sans"/>');
    expect(xml).toContain('marL="228594" indent="-228594"');
  });

  it("rejects ordered-list geometry with a mismatched paragraph count", async () => {
    state.slideXml = [
      slideXml(["Eight"]).replace(
        "<a:p>",
        '<a:p><a:pPr><a:buAutoNum type="arabicPeriod" startAt="1"/></a:pPr>',
      ),
      slideXml(["Second line"]),
    ];
    state.orderedLists = [
      {
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        numbers: [8, 9],
        markers: [8, 9].map(() => {
          return {
            color: "2563EB",
            font: "Liberation Sans",
            size: 32,
            gap: 30,
            offset: 0,
            leading: 0,
          };
        }),
      },
    ];
    await expect(convert([])).rejects.toThrow(/process\.exit/u);
    expect(stderr()).toContain("paragraphs disagree with browser items");
  });

  it("reads the cached renderer into a local deck", async () => {
    await convert([]);

    expect(state.evaluated.join("")).toContain(
      `file://${join(cacheHome, "okou", "presentation-convert", "v1", RENDERER_BUNDLE)}`,
    );
  });

  it("serves the renderer over the network to a hosted deck", async () => {
    await presentationCommand.parseAsync(
      ["convert", "--input", "https://example.com/deck", "--out", outPath],
      { from: "user" },
    );

    // A browser refuses a file:// script from a network origin, so a hosted
    // deck has to be handed the published artifact instead of this cache.
    const evaluated = state.evaluated.join("");
    expect(evaluated).toContain(RENDERER_CDN);
    expect(evaluated).not.toContain("file://");
    // Nothing on this machine is needed, so nothing is fetched into the cache.
    expect(
      existsSync(
        join(cacheHome, "okou", "presentation-convert", "v1", RENDERER_BUNDLE),
      ),
    ).toBe(false);
  });

  it("passes verification when every source string reaches the deck", async () => {
    await expect(convert(["--verify"])).resolves.toBeUndefined();
  });

  it("reports browser-painted regions without dropping the original text denominator", async () => {
    state.paintRegions = [
      {
        id: 0,
        mode: "content",
        features: ["text-paint"],
        tag: "P",
        textStrings: 1,
        x: 80,
        y: 120,
        w: 400,
        h: 100,
        padding: 0,
      },
    ];
    state.measuredPages = [[], ["Second line"]];
    state.deckPages = [[], ["Second line"]];
    await expect(convert(["--verify", "--json"])).rejects.toThrow(
      /process\.exit/u,
    );
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      verify: { sourceStrings: 2, matchedStrings: 1, scope: "native-text" },
      paint: {
        regions: [
          {
            page: 1,
            mode: "content",
            features: ["text-paint"],
            textStrings: 1,
          },
        ],
      },
    });
    expect(existsSync(outPath)).toBe(true);
  });

  it("fails without a deck when the browser returns an invalid screenshot", async () => {
    state.paintRegions = [
      {
        id: 0,
        mode: "background",
        features: ["background-image"],
        tag: "DIV",
        textStrings: 0,
        x: 10,
        y: 10,
        w: 100,
        h: 100,
        padding: 0,
      },
    ];
    state.badScreenshot = true;
    await expect(convert([])).rejects.toThrow(/process\.exit/u);
    expect(existsSync(outPath)).toBe(false);
    expect(stderr()).toContain("Browser did not return a PNG screenshot");
  });

  it("requires separate native characters for a title and its repeated single-character label", async () => {
    state.sourcePages = [["Heading includes Q", "Q"], []];
    state.deckPages = [["Heading includes Q"], []];
    await expect(convert(["--verify", "--json"])).rejects.toThrow(
      /process\.exit/u,
    );
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      verify: { missing: ["Page 1: Q"], matchedStrings: 1, sourceStrings: 2 },
    });
  });

  it("matches whole entries before their prefixes when native drawing order differs", async () => {
    state.sourcePages = [["A", "AB"], []];
    state.deckPages = [["AB", "A"], []];
    await expect(convert(["--verify"])).resolves.toBeUndefined();
  });

  it("treats discretionary break markers as layout rather than missing letters", async () => {
    state.sourcePages = [["inter\u00adnational and zero\u200bwidth"], []];
    state.deckPages = [["international and zerowidth"], []];
    await expect(convert(["--verify"])).resolves.toBeUndefined();
  });

  it("passes verification when a string is split across runs", async () => {
    state.pageTexts = ["一个完整的句子"];
    state.deckPages = [["一个完整的", "句子"], []];
    state.slideCount = 2;
    await expect(convert(["--verify"])).resolves.toBeUndefined();
  });

  it("fails verification when the deck loses a source string", async () => {
    state.pageTexts = ["Kept heading", "Lost heading"];
    state.deckTexts = ["Kept heading", ""];
    await expect(convert(["--verify"])).rejects.toThrow(/process\.exit/u);
    expect(stderr()).toContain("coverage");
    expect(
      readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml"),
    ).toContain("Kept heading");
  });

  it("does not let a matching title on another page conceal a blank page", async () => {
    state.sourcePages = [["Repeated title"], ["Repeated title"]];
    state.deckPages = [["Repeated title"], []];
    await expect(convert(["--verify", "--json"])).rejects.toThrow(
      /process\.exit/u,
    );
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain(
      "Page 2: Repeated title",
    );
  });

  it("requires repeated occurrences on the same page", async () => {
    state.sourcePages = [["Repeated", "Repeated"], []];
    state.deckPages = [["Repeated"], []];
    await expect(convert(["--verify", "--json"])).rejects.toThrow(
      /process\.exit/u,
    );
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain(
      "Page 1: Repeated",
    );
  });

  it("verifies visible single-character labels", async () => {
    state.sourcePages = [["Q"], []];
    state.deckPages = [[], []];
    await expect(convert(["--verify", "--json"])).rejects.toThrow(
      /process\.exit/u,
    );
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain(
      "Page 1: Q",
    );
  });

  it("does not count fully transparent glyph fills as preserved native text", async () => {
    state.sourcePages = [["INVISIBLE"], []];
    state.slideXml = [
      slideXml(["INVISIBLE"]).replace(
        "<a:latin",
        '<a:solidFill><a:srgbClr val="000000"><a:alpha val="0"/></a:srgbClr></a:solidFill><a:latin',
      ),
      slideXml([]),
    ];
    await expect(convert(["--verify", "--json"])).rejects.toThrow(
      /process\.exit/u,
    );
    const output = String(vi.mocked(console.log).mock.calls.at(-1)?.[0]);
    expect(output).toContain("Page 1: INVISIBLE");
    expect(output).toContain('"scope":"native-text"');
    expect(output).toContain('"visualComparison":"not-performed"');
  });

  it("keeps per-frame script fonts and decorations without changing Latin typefaces", async () => {
    state.textBoxes = [
      {
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        eastAsianFont: "Noto Sans CJK JP",
        complexFont: "",
        strike: true,
        underlineColor: "FF0000",
        underlineWidth: 2,
      },
    ];
    await convert([]);
    const slide =
      readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml") ?? "";
    expect(slide).toContain('<a:latin typeface="Lexend"/>');
    expect(slide).toContain('<a:ea typeface="Noto Sans CJK JP"/>');
    expect(slide).toContain('strike="sngStrike"');
    expect(slide).toContain('wrap="none"');
    expect(slide).toContain('<a:uFill><a:solidFill><a:srgbClr val="FF0000"/>');
    expect(slide.indexOf("<a:uFill>")).toBeLessThan(slide.indexOf("<a:latin"));
    expect(slide).toContain('sz="7680"');
  });

  it("uses measured table row heights and fills without deleting border paint", async () => {
    const cell =
      '<a:tc><a:tcPr><a:lnL><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:lnL><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:tcPr></a:tc>';
    const table = `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="1"/></p:xfrm><a:tbl><a:tr h="0">${cell}</a:tr><a:tr h="0">${cell}</a:tr></a:tbl></p:graphicFrame>`;
    state.slideXml = [table, table];
    state.tables = [
      { x: 0, y: 0, w: 100, h: 60, rows: [20, 40], fills: [["ABCDEF"], [""]] },
    ];
    await convert([]);
    const slide =
      readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml") ?? "";
    expect(slide).toContain('<a:tr h="182880">');
    expect(slide).toContain('<a:tr h="365760">');
    expect(slide).toContain('cy="548640"');
    expect(slide).toContain('<a:lnL><a:solidFill><a:srgbClr val="123456"/>');
    expect(slide).toContain('<a:solidFill><a:srgbClr val="ABCDEF"/>');
  });

  it("restores the borrowed page even when measured geometry disagrees", async () => {
    state.tables = [{ x: 0, y: 0, w: 100, h: 60, rows: [20, 40], fills: [] }];
    await expect(convert([])).rejects.toThrow(/process\.exit/u);
    expect(stderr()).toContain("Measured table was omitted");
    expect(state.evaluated.at(-1)).toBe("window.__okouRestoreLayout?.()");
  });

  it("waits for an explicit selector instead of the built-in candidates", async () => {
    await convert(["--selector", ".audit-page"]);

    expect(state.evaluated).toContain(
      'document.querySelectorAll(".audit-page").length',
    );
    expect(
      state.evaluated.some((script) => {
        return script.includes("scored.sort");
      }),
    ).toBe(false);
  });

  it("encodes spaces and hash characters in local file URLs", async () => {
    deckPath = join(workDir, "deck #tag.html");
    writeFileSync(deckPath, "<html></html>");
    await convert([]);

    expect(state.openedUrls.at(-1)).toContain("deck%20%23tag.html");
    expect(state.openedUrls.at(-1)).not.toContain("#");
  });
});
