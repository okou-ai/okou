/**
 * Tests for okou presentation convert.
 *
 * Mocks only the external binaries (agent-browser and the npm/tar fetch of the
 * renderer bundle). The fake browser answers the real page scripts and hands
 * back a real .pptx, so slide detection, the capability guard, post-processing,
 * the archive round-trip, and coverage grading all run unchanged.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { crc32, inflateRawSync } from "zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { presentationCommand } from "../index";

/** Slide XML shaped like the renderer's output, including what post-processing rewrites. */
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
    `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0"><a:spAutoFit/></a:bodyPr>` +
    `${runs}</p:txBody></p:sp>` +
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
  fontStack: 'Lexend, "PingFang SC", sans-serif',
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
    ["ppt/slides/slide1.xml", slideXml(texts.slice(0, 1))],
    ["ppt/slides/slide2.xml", slideXml(texts.slice(1))],
  ];
  return storedZip(entries).toString("base64");
}

/** Answers the page scripts the command evaluates, in the order it evaluates them. */
function fakeEval(expression: string): string {
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
    state.fontStack = 'Lexend, "PingFang SC", sans-serif';
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
