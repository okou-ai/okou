import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { http, HttpResponse } from "msw";
import { SaxesParser } from "saxes";
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

export function slidesImportFixture(): Buffer {
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
    }: {
      x: number;
      y: number;
      width: number;
      size: number;
      color?: string;
      family?: string;
    },
  ) => {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="text-${String(id)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(x * 12_700)}" y="${String(y * 12_700)}"/><a:ext cx="${String(width * 12_700)}" cy="${String(Math.round(size * 1.4 * 12_700))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" rIns="0" tIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr/><a:r><a:rPr sz="${String(Math.round(size * 100))}" spc="-100"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${family}"/></a:rPr><a:t xml:space="preserve">${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  };
  const shapes = [
    shape(2, "05", { x: 10, y: 20, width: 251, size: 192 }),
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
    if (tag.local === "ext") {
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
