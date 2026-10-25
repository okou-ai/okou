import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { http, HttpResponse } from "msw";
import { SaxesParser } from "saxes";
import * as z from "zod";
import { server } from "../../../../mocks/server";

const font = readFileSync(
  new URL("../fixtures/slides-import-font.ttf", import.meta.url),
);

export function mockSlidesImportFonts(status = 200): void {
  server.use(
    http.get("https://fonts.googleapis.com/css2", ({ request }) => {
      const family = new URL(request.url).searchParams.get("family");
      return new HttpResponse(
        "@font-face { src: url(https://fonts.gstatic.com/s/import-test/font.ttf) format('truetype'); }",
        { status: family?.startsWith("Import Test:") ? status : 400 },
      );
    }),
    http.get("https://fonts.gstatic.com/s/import-test/font.ttf", () => {
      return new HttpResponse(Uint8Array.from(font).buffer);
    }),
  );
}

export function slidesImportFixture({
  topicNumber = "05",
  splitTopicNumber = false,
} = {}): Buffer {
  const shape = (
    id: number,
    text: string,
    {
      x,
      y,
      width,
      size,
      color = "242121",
      family = "Import Test",
      split = false,
    }: {
      x: number;
      y: number;
      width: number;
      size: number;
      color?: string;
      family?: string;
      split?: boolean;
    },
  ) => {
    const runs = (split ? [...text] : [text])
      .map((content, index) => {
        return `<a:r><a:rPr sz="${String(Math.round(size * 100))}" spc="-100"><a:solidFill><a:srgbClr val="${index ? "00FF00" : color}"/></a:solidFill><a:latin typeface="${family}"/></a:rPr><a:t xml:space="preserve">${content}</a:t></a:r>`;
      })
      .join("");
    return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="text-${String(id)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(x * 12_700)}" y="${String(y * 12_700)}"/><a:ext cx="${String(width * 12_700)}" cy="${String(Math.round(size * 1.4 * 12_700))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" rIns="0" tIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr/>${runs}</a:p></p:txBody></p:sp>`;
  };
  const shapes = [
    shape(2, topicNumber, {
      x: 10,
      y: 20,
      width: 251,
      size: 192,
      split: splitTopicNumber,
    }),
    shape(3, "guardrails", { x: 300, y: 100, width: 235, size: 49.92 }),
    shape(4, "White ", { x: 50, y: 310, width: 70, size: 20, color: "FFFFFF" }),
    shape(5, "Green", { x: 115, y: 310, width: 70, size: 20, color: "00FF00" }),
    // Deliberately overlap the frames without making their text continuous.
    shape(6, "Column A", { x: 50, y: 350, width: 200, size: 20 }),
    shape(7, "Column B", { x: 170, y: 350, width: 200, size: 20 }),
    shape(8, "05", { x: 50, y: 420, width: 251, size: 192 }),
    shape(9, "Neighbor", { x: 302, y: 420, width: 100, size: 20 }),
    shape(10, "guardrails", { x: 720, y: 460, width: 235, size: 49.92 }),
    shape(11, "Unknown font", {
      x: 600,
      y: 310,
      width: 100,
      size: 20,
      family: "Unlisted Font",
    }),
    // The untracked text fits exactly, but there is less than one point of
    // clearance before the neighbor and the slide edge, respectively.
    shape(12, "05", { x: 700, y: 20, width: 27, size: 20 }),
    shape(13, "Neighbor", { x: 727.5, y: 20, width: 100, size: 20 }),
    shape(14, "05", { x: 932.5, y: 250, width: 27, size: 20 }),
  ].join("");
  const archive = new AdmZip();
  archive.addFile(
    "[Content_Types].xml",
    Buffer.from(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ),
  );
  archive.addFile(
    "_rels/.rels",
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    ),
  );
  archive.addFile(
    "ppt/presentation.xml",
    Buffer.from(
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
    ),
  );
  archive.addFile(
    "ppt/_rels/presentation.xml.rels",
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ),
  );
  archive.addFile(
    "ppt/slides/slide1.xml",
    Buffer.from(
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`,
    ),
  );
  return archive.toBuffer();
}

const presentationNamespace =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const drawingNamespace =
  "http://schemas.openxmlformats.org/drawingml/2006/main";
const relationshipNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function cropPicture(
  id: number,
  name: string,
  frame: readonly [x: number, y: number, cx: number, cy: number],
  crop = "",
): string {
  const [x, y, cx, cy] = frame;
  // The blip's drawing prefix is deliberately NOT in scope for a new sibling.
  return `<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><image:blip xmlns:image="${drawingNamespace}" r:embed="rIdImage"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${String(x)}" y="${String(y)}"/><a:ext cx="${String(cx)}" cy="${String(cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function pictureSlide(pictures: string, properties = ""): string {
  return `<p:sld xmlns:p="${presentationNamespace}" xmlns:a="${drawingNamespace}" xmlns:r="${relationshipNamespace}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${pictures}</p:spTree></p:cSld>${properties}</p:sld>`;
}

function pictureDeck(slides: readonly string[]): Buffer {
  const archive = new AdmZip(slidesImportFixture());
  for (const [index, slide] of slides.entries()) {
    const number = String(index + 1);
    archive.addFile(`ppt/slides/slide${number}.xml`, Buffer.from(slide));
    archive.addFile(
      `ppt/slides/_rels/slide${number}.xml.rels`,
      Buffer.from(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="${relationshipNamespace}/image" Target="../media/picture-crop.png"/></Relationships>`,
      ),
    );
  }
  archive.addFile(
    "ppt/presentation.xml",
    Buffer.from(
      archive.readAsText("ppt/presentation.xml").replace(
        '<p:sldId id="256" r:id="rId1"/>',
        slides
          .map((_slide, index) => {
            return `<p:sldId id="${String(256 + index)}" r:id="rId${String(index + 1)}"/>`;
          })
          .join(""),
      ),
    ),
  );
  archive.addFile(
    "ppt/_rels/presentation.xml.rels",
    Buffer.from(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
        .map((_slide, index) => {
          const number = String(index + 1);
          return `<Relationship Id="rId${number}" Type="${relationshipNamespace}/slide" Target="slides/slide${number}.xml"/>`;
        })
        .join("")}</Relationships>`,
    ),
  );
  archive.addFile(
    "[Content_Types].xml",
    Buffer.from(
      archive.readAsText("[Content_Types].xml").replace(
        "</Types>",
        `<Default Extension="png" ContentType="image/png"/>${slides
          .slice(1)
          .map((_slide, index) => {
            return `<Override PartName="/ppt/slides/slide${String(index + 2)}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
          })
          .join("")}</Types>`,
      ),
    ),
  );
  archive.addFile(
    "ppt/media/picture-crop.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNBgAAEnICff5q7YNAAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  return archive.toBuffer();
}

/** Native pictures only: image edits must be saved without any text rewrite. */
export function slidesPictureCropFixture(): Buffer {
  const pictures = [
    cropPicture(
      2,
      "reported-arc-yellow",
      [6_339_840, 757_637, 7_559_040, 7_674_445],
    ),
    cropPicture(3, "left-top", [-1_219_200, -685_800, 12_192_000, 6_858_000]),
    cropPicture(
      4,
      "already-cropped-all-edges",
      [-1_524_000, -857_250, 15_240_000, 8_572_500],
      `<crop:srcRect xmlns:crop="${drawingNamespace}" l="10000" t="20000" r="30000" b="10000"/>`,
    ),
    cropPicture(
      5,
      "in-bounds-control",
      [1_219_200, 685_800, 2_438_400, 1_371_600],
    ),
    // A group disqualifies text preparation, not unrelated direct pictures.
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="unrelated-group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/><a:chOff x="0" y="0"/><a:chExt cx="12192000" cy="6858000"/></a:xfrm></p:grpSpPr>${cropPicture(7, "nested-off-page", [-1_219_200, 0, 2_438_400, 1_371_600])}</p:grpSp>`,
  ].join("");
  return pictureDeck([pictureSlide(pictures)]);
}

/** Keep unsupported pictures and slide-wide animation/transform cases intact. */
export function slidesPictureCropNoopFixture(): Buffer {
  const offPage = (id: number, name: string, crop = "") => {
    return cropPicture(
      id,
      name,
      [-100_000, -200_000, 1_000_000, 1_000_000],
      crop,
    );
  };
  const unsupported = [
    cropPicture(2, "fully-outside", [12_192_000, 0, 1_000_000, 1_000_000]),
    offPage(3, "rotated").replace("<a:xfrm>", '<a:xfrm rot="5400000">'),
    offPage(4, "flip-attribute").replace("<a:xfrm>", '<a:xfrm flipH="0">'),
    offPage(5, "ellipse").replace('prst="rect"', 'prst="ellipse"'),
    offPage(6, "tiled").replace(
      "<a:stretch><a:fillRect/></a:stretch>",
      "<a:tile/>",
    ),
    offPage(7, "partial-fill").replace(
      "<a:fillRect/>",
      '<a:fillRect l="1000"/>',
    ),
    offPage(8, "effect").replace(
      "</p:spPr>",
      '<a:effectLst><a:glow rad="1000"><a:srgbClr val="FFFFFF"/></a:glow></a:effectLst></p:spPr>',
    ),
    offPage(9, "inherited-style").replace(
      "</p:pic>",
      '<p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style></p:pic>',
    ),
    offPage(10, "visible-stroke").replace(
      "</p:spPr>",
      '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>',
    ),
    offPage(11, "negative-crop", '<a:srcRect l="-1"/>'),
    offPage(12, "fractional-crop", '<a:srcRect t="0.5"/>'),
    offPage(13, "empty-source", '<a:srcRect l="60000" r="40000"/>'),
    cropPicture(14, "zero-width", [-100_000, -200_000, 0, 1_000_000]),
  ].join("");
  return pictureDeck([
    pictureSlide(unsupported),
    pictureSlide(
      offPage(2, "timed"),
      '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>',
    ),
    pictureSlide(
      offPage(2, "transition"),
      "<p:transition><p:fade/></p:transition>",
    ),
    pictureSlide(offPage(2, "root-transform")).replace(
      "<p:grpSpPr/>",
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/><a:chOff x="0" y="0"/><a:chExt cx="12192000" cy="6858000"/></a:xfrm></p:grpSpPr>',
    ),
  ]);
}

/** Inspect native picture geometry using expanded names, not XML prefixes. */
export function uploadedSlidesPictures(bytes: Uint8Array) {
  const archive = new AdmZip(Buffer.from(bytes));
  const result: {
    slide: string;
    grouped: boolean;
    id: string;
    name: string;
    embed: string;
    preset: string;
    frame: { x: number; y: number; cx: number; cy: number };
    crop: { l: number; t: number; r: number; b: number } | null;
  }[] = [];
  const p = (local: string) => {
    return `{${presentationNamespace}}${local}`;
  };
  const a = (local: string) => {
    return `{${drawingNamespace}}${local}`;
  };
  const isPicturePath = (path: readonly string[]) => {
    return (
      path.at(-1) === p("pic") &&
      path[0] === p("sld") &&
      path[1] === p("cSld") &&
      path[2] === p("spTree") &&
      path.slice(3, -1).every((ancestor) => {
        return ancestor === p("grpSp");
      })
    );
  };
  for (const entry of archive.getEntries()) {
    if (!/^ppt\/slides\/slide\d+\.xml$/u.test(entry.entryName)) {
      continue;
    }
    const parser = new SaxesParser({ xmlns: true });
    const path: string[] = [];
    let current: (typeof result)[number] | undefined;
    let pictureDepth = 0;
    parser.on("opentag", (tag) => {
      const element = `{${tag.uri}}${tag.local}`;
      path.push(element);
      const attr = (local: string, uri = "") => {
        return Object.values(tag.attributes).find((attribute) => {
          return attribute.local === local && attribute.uri === uri;
        })?.value;
      };
      if (!current && isPicturePath(path)) {
        pictureDepth = path.length;
        current = {
          slide: entry.entryName,
          grouped: pictureDepth !== 4,
          id: "",
          name: "",
          embed: "",
          preset: "",
          frame: {
            x: Number.NaN,
            y: Number.NaN,
            cx: Number.NaN,
            cy: Number.NaN,
          },
          crop: null,
        };
      }
      if (!current) {
        return;
      }
      const at = (...tail: string[]) => {
        return (
          path.length === pictureDepth + tail.length &&
          tail.every((part, index) => {
            return path[pictureDepth + index] === part;
          })
        );
      };
      if (at(p("nvPicPr"), p("cNvPr"))) {
        current.id = attr("id") ?? "";
        current.name = attr("name") ?? "";
      } else if (at(p("blipFill"), a("blip"))) {
        current.embed = attr("embed", relationshipNamespace) ?? "";
      } else if (at(p("spPr"), a("xfrm"), a("off"))) {
        current.frame.x = Number(attr("x"));
        current.frame.y = Number(attr("y"));
      } else if (at(p("spPr"), a("xfrm"), a("ext"))) {
        current.frame.cx = Number(attr("cx"));
        current.frame.cy = Number(attr("cy"));
      } else if (at(p("spPr"), a("prstGeom"))) {
        current.preset = attr("prst") ?? "";
      } else if (at(p("blipFill"), a("srcRect"))) {
        current.crop = {
          l: Number(attr("l") ?? 0),
          t: Number(attr("t") ?? 0),
          r: Number(attr("r") ?? 0),
          b: Number(attr("b") ?? 0),
        };
      }
    });
    parser.on("closetag", () => {
      if (current && path.length === pictureDepth) {
        result.push(current);
        current = undefined;
      }
      path.pop();
    });
    parser.write(entry.getData().toString()).close();
  }
  return result;
}

/** Inspect the Office document sent across the real Drive upload boundary. */
export function uploadedSlidesText(bytes: Uint8Array) {
  const archive = new AdmZip(Buffer.from(bytes));
  const parser = new SaxesParser({ xmlns: true });
  const result: {
    id: string;
    text: string;
    width: number;
    sizes: number[];
    colors: string[];
  }[] = [];
  let current: (typeof result)[number] | undefined;
  let inText = false;
  parser.on("opentag", (tag) => {
    const attrs = Object.fromEntries(
      Object.values(tag.attributes).map((attribute) => {
        return [attribute.local, attribute.value];
      }),
    );
    if (tag.local === "sp") {
      current = { id: "", text: "", width: 0, sizes: [], colors: [] };
    }
    if (!current) {
      return;
    }
    if (tag.local === "cNvPr") {
      current.id = attrs.id!;
    }
    if (tag.uri === drawingNamespace && tag.local === "ext") {
      current.width = Number(attrs.cx) / 12_700;
    }
    if (tag.local === "rPr") {
      current.sizes.push(Number(attrs.sz) / 100);
    }
    if (tag.local === "srgbClr") {
      current.colors.push(attrs.val!);
    }
    if (tag.local === "t") {
      inText = true;
    }
  });
  parser.on("text", (text) => {
    if (inText && current) {
      current.text += text;
    }
  });
  parser.on("closetag", (tag) => {
    if (tag.local === "t") {
      inText = false;
    }
    if (tag.local === "sp" && current) {
      result.push(current);
      current = undefined;
    }
  });
  parser.write(archive.readAsText("ppt/slides/slide1.xml")).close();
  return result;
}

/** A real CLI export: do not reconstruct this deck from expected XML. */
export function slidesTextProvenanceFixture(): Buffer {
  return readFileSync(
    new URL("../fixtures/slides-text-provenance.pptx", import.meta.url),
  );
}

interface ImportedText {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
function importedText(file: Uint8Array): ImportedText[] {
  const archive = new AdmZip(Buffer.from(file));
  const result: ImportedText[] = [];
  let item = { id: "", text: "", x: 0, y: 0, width: 0, height: 0 };
  let inside = false,
    reading = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    const attrs = Object.fromEntries(
      Object.values(tag.attributes).map((attr) => {
        return [attr.local, attr.value];
      }),
    );
    if (tag.uri === presentationNamespace && tag.local === "sp") {
      inside = true;
      item = { id: "", text: "", x: 0, y: 0, width: 0, height: 0 };
    }
    if (!inside) {
      return;
    }
    if (tag.uri === presentationNamespace && tag.local === "cNvPr") {
      item.id = "google-" + attrs.id;
    }
    if (tag.uri === drawingNamespace && tag.local === "off") {
      item.x = Number(attrs.x);
      item.y = Number(attrs.y);
    }
    if (tag.uri === drawingNamespace && tag.local === "ext") {
      item.width = Number(attrs.cx);
      item.height = Number(attrs.cy);
    }
    if (tag.uri === drawingNamespace && tag.local === "t") {
      reading = true;
    }
  });
  parser.on("text", (text) => {
    if (reading) {
      item.text += text;
    }
  });
  parser.on("closetag", (tag) => {
    if (tag.uri === drawingNamespace && tag.local === "t") {
      reading = false;
    }
    if (tag.uri === presentationNamespace && tag.local === "sp") {
      if (item.text) {
        result.push(item);
      }
      inside = false;
    }
  });
  parser.write(archive.readAsText("ppt/slides/slide1.xml")).close();
  return result;
}

const styleRequestSchema = z.object({
  requests: z.array(
    z.object({
      updateTextStyle: z.object({
        objectId: z.string(),
        textRange: z.object({ startIndex: z.number(), endIndex: z.number() }),
        style: z.object({
          weightedFontFamily: z.object({
            fontFamily: z.string(),
            weight: z.number(),
          }),
          bold: z.boolean(),
          italic: z.boolean(),
        }),
      }),
    }),
  ),
  writeControl: z.object({ requiredRevisionId: z.literal("import-revision") }),
});

export function mockSlidesFontRestoration(
  uploaded: { readonly bodies: readonly Uint8Array[] },
  failure?: "write" | "ambiguous" | "readback" | "complete",
) {
  const writes: z.infer<typeof styleRequestSchema>["requests"] = [];
  const completions: unknown[] = [];
  server.use(
    http.get("https://slides.googleapis.com/v1/presentations/:id", () => {
      const items = importedText(uploaded.bodies[0]!);
      const pageElements = items.map((item) => {
        const updates = writes.filter((write) => {
          return write.updateTextStyle.objectId === item.id;
        });
        const textElements = updates.length
          ? updates.map(({ updateTextStyle: write }) => {
              return {
                startIndex: write.textRange.startIndex,
                endIndex: write.textRange.endIndex,
                textRun: {
                  content: item.text.slice(
                    write.textRange.startIndex,
                    write.textRange.endIndex,
                  ),
                  style:
                    failure === "readback"
                      ? {
                          weightedFontFamily: {
                            fontFamily: "Wrong Font",
                            weight: 400,
                          },
                        }
                      : write.style,
                },
              };
            })
          : [
              {
                startIndex: 0,
                endIndex: item.text.length,
                textRun: {
                  content: item.text,
                  style: {
                    weightedFontFamily: {
                      fontFamily: "Import Test",
                      weight: 400,
                    },
                  },
                },
              },
            ];
        return {
          objectId: item.id,
          size: {
            width: { magnitude: item.width, unit: "EMU" },
            height: { magnitude: item.height, unit: "EMU" },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: item.x,
            translateY: item.y,
            unit: "EMU",
          },
          shape: { text: { textElements } },
        };
      });
      if (failure === "ambiguous" && pageElements[0]) {
        pageElements.push({ ...pageElements[0], objectId: "duplicate" });
      }
      return HttpResponse.json({
        revisionId: "import-revision",
        slides: [{ pageElements }],
      });
    }),
    http.post(
      "https://slides.googleapis.com/v1/presentations/:id",
      async ({ request }) => {
        const body = styleRequestSchema.parse(await request.json());
        if (failure === "write") {
          return new HttpResponse(null, { status: 409 });
        }
        writes.push(...body.requests);
        return HttpResponse.json({
          replies: body.requests.map(() => {
            return {};
          }),
        });
      },
    ),
    http.patch(
      "https://www.googleapis.com/drive/v3/files/:id",
      async ({ request }) => {
        completions.push(await request.json());
        return HttpResponse.json(
          {},
          { status: failure === "complete" ? 503 : 200 },
        );
      },
    ),
  );
  return { writes, completions };
}
