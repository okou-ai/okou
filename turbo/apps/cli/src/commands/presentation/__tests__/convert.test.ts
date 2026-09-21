/**
 * Tests for okou presentation convert.
 *
 * Mocks only the external binaries (agent-browser and the npm/tar fetch of the
 * renderer bundle). The fake browser answers the real page scripts and hands
 * back a real .pptx, so slide detection, the capability guard, post-processing,
 * the archive round-trip, and coverage grading all run unchanged.
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { presentationCommand } from "../index";

/** Width the fake renderer gives a table frame, in EMU. */
const TABLE_FRAME_CX = 7_620_000;

/** Named here rather than imported, so the published address stays pinned. */
const RENDERER_BUNDLE = "dom-to-pptx.bundle.js";
const RENDERER_CDN = `https://cdn.jsdelivr.net/npm/dom-to-pptx@2.1.2/dist/${RENDERER_BUNDLE}`;

/**
 * A table as the renderer writes one: rows carrying the zero-height placeholder
 * and a frame claiming the one-inch default, which is what post-processing has
 * to replace with the heights the page reported.
 */
function tableXml(rows: number): string {
  const body = Array.from({ length: rows }, () => {
    return '<a:tr h="0"><a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr>';
  }).join("");
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table 1"/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="0" y="0"/><a:ext cx="${TABLE_FRAME_CX}" cy="914400"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="table"><a:tbl><a:tblPr/>` +
    `<a:tblGrid><a:gridCol w="${TABLE_FRAME_CX}"/></a:tblGrid>${body}</a:tbl>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/** Slide XML shaped like the renderer's output, including what post-processing rewrites. */
function slideXml(texts: readonly string[], tableRows = 0): string {
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
    `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0"><a:spAutoFit/></a:bodyPr>` +
    `${runs}</p:txBody></p:sp>` +
    `${tableRows > 0 ? tableXml(tableRows) : ""}` +
    `</p:spTree></p:cSld></p:sld>`
  );
}

/**
 * A ZIP written independently of the command's own writer, so a round-trip
 * failure points at the production code rather than at a shared helper. Entries
 * are stored rather than deflated, and a directory entry is included because a
 * real renderer package carries them.
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
  /** Every expression the command evaluated in the page, in order. */
  evaluated: [] as string[],
  fontStack: 'Lexend, "PingFang SC", sans-serif',
  slideCount: 2,
  /** Rows the fake renderer writes into slide 1's table, all at the placeholder. */
  tableRows: 0,
  /** What the fake page measures for those tables, per slide, in deck order. */
  tables: [[], []] as { readonly rows: number[]; readonly width: number }[][],
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
    ["ppt/slides/slide1.xml", slideXml(texts.slice(0, 1), state.tableRows)],
    ["ppt/slides/slide2.xml", slideXml(texts.slice(1))],
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
  if (expression.includes("generic.has")) {
    const cjk = state.fontStack.split(",").map((entry) => {
      return entry.trim().replace(/^["']|["']$/gu, "");
    })[1];
    return encoded(cjk ?? "");
  }
  if (expression.includes('querySelectorAll("table")')) {
    return encoded(state.tables);
  }
  if (expression.includes("seen.push")) return encoded(state.pageTexts);
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
    state.evaluated = [];
    state.fontStack = 'Lexend, "PingFang SC", sans-serif';
    state.slideCount = 2;
    state.tableRows = 0;
    state.tables = [[], []];
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

  it("writes a deck whose parts survive the archive round-trip", async () => {
    await convert([]);

    const parts = readZip(readFileSync(outPath));
    expect([...parts.keys()]).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "ppt/presentation.xml",
        "ppt/slides/slide1.xml",
        "ppt/slides/slide2.xml",
      ]),
    );
    // A part name cannot end in a slash, so directory entries must not survive.
    expect(
      [...parts.keys()].filter((name) => {
        return name.endsWith("/");
      }),
    ).toEqual([]);
    expect(parts.get("[Content_Types].xml")).toBe("<Types/>");
  });

  it("keeps the measured geometry and the browser's line breaks", async () => {
    await convert([]);

    const slide =
      readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml") ?? "";
    expect(slide).toContain("<a:normAutofit/>");
    expect(slide).not.toContain("<a:spAutoFit/>");
    expect(slide).toContain('wrap="none"');
    expect(slide).not.toContain('wrap="square"');
  });

  it("hands wrapping back to the viewer when asked", async () => {
    await convert(["--wrap"]);

    const slide =
      readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml") ?? "";
    expect(slide).toContain('wrap="square"');
    expect(slide).not.toContain('wrap="none"');
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

  it("gives table rows the heights the page painted", async () => {
    state.tableRows = 3;
    state.tables = [[{ rows: [30, 20, 20], width: 1000 }], []];
    await convert([]);

    const slide =
      readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml") ?? "";
    // The frame spans 7,620,000 EMU across a table the page painted 1000px
    // wide, so a pixel is 7,620 EMU and each row keeps its own painted height.
    expect(slide).toContain('<a:tr h="228600"');
    expect(slide).toContain('<a:tr h="152400"');
    expect(slide).not.toContain('<a:tr h="0"');
    // A viewer grows rows past the frame, so the frame has to own their sum
    // rather than the renderer's one-inch placeholder.
    expect(slide).toContain(`cx="${TABLE_FRAME_CX}" cy="533400"`);
  });

  it("leaves a table alone when the page and the deck disagree on its rows", async () => {
    state.tableRows = 3;
    state.tables = [[{ rows: [30, 20], width: 1000 }], []];
    await convert([]);

    const slide =
      readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml") ?? "";
    expect(slide).toContain('<a:tr h="0"');
    expect(slide).toContain(`cx="${TABLE_FRAME_CX}" cy="914400"`);
  });

  it("names the East Asian family the deck's own stack asks for", async () => {
    await convert([]);

    const slide =
      readZip(readFileSync(outPath)).get("ppt/slides/slide1.xml") ?? "";
    expect(slide).toContain('<a:ea typeface="PingFang SC"');
    // Only the East Asian slot moves; Latin keeps the deck's display face.
    expect(slide).toContain('<a:latin typeface="Lexend"');
  });

  it("passes verification when every source string reaches the deck", async () => {
    await expect(convert(["--verify"])).resolves.toBeUndefined();
  });

  it("passes verification when a string is split across runs", async () => {
    state.pageTexts = ["一个完整的句子"];
    state.deckTexts = ["一个完整的", "句子"];
    state.slideCount = 2;
    await expect(convert(["--verify"])).resolves.toBeUndefined();
  });

  it("fails verification when the deck loses a source string", async () => {
    state.pageTexts = ["Kept heading", "Lost heading"];
    state.deckTexts = ["Kept heading", ""];
    await expect(convert(["--verify"])).rejects.toThrow(/process\.exit/u);
    expect(stderr()).toContain("coverage");
  });
});
