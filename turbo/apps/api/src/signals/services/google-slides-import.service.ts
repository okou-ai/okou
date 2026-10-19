import { escapeUTF8 } from "entities";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Font } from "fontkit";
import { SaxesParser } from "saxes";
import { settle, safeSync } from "../utils";
import {
  loadSlidesFont,
  slidesFontFace,
  type SlidesFontFace,
} from "./google-slides-font.service";

const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PRESENTATION =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const EMU_PER_POINT = 12_700;

interface XmlNode {
  readonly name: string;
  readonly local: string;
  readonly uri: string;
  readonly attributes: Record<string, string>;
  children: (XmlNode | string)[];
}

function nodes(node: XmlNode): XmlNode[] {
  return node.children.filter((item): item is XmlNode => {
    return typeof item !== "string";
  });
}

function child(node: XmlNode, uri: string, local: string): XmlNode | undefined {
  return nodes(node).find((item) => {
    return item.uri === uri && item.local === local;
  });
}

function readXml(bytes: Uint8Array): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let count = 0;
  parser.on("doctype", () => {
    throw new Error("Presentation XML must not contain a DTD");
  });
  parser.on("opentag", (tag) => {
    count += 1;
    if (count > 100_000 || stack.length > 100) {
      throw new Error("Presentation XML exceeds the import limit");
    }
    const node: XmlNode = {
      name: tag.name,
      local: tag.local,
      uri: tag.uri,
      attributes: Object.fromEntries(
        Object.values(tag.attributes).map((attribute) => {
          return [attribute.name, attribute.value];
        }),
      ),
      children: [],
    };
    if (stack.length) {
      stack.at(-1)!.children.push(node);
    } else {
      root = node;
    }
    stack.push(node);
  });
  const text = (value: string) => {
    stack.at(-1)?.children.push(value);
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(strFromU8(bytes)).close();
  if (!root) {
    throw new Error("Presentation XML is empty");
  }
  return root;
}

function xml(node: XmlNode): string {
  const attrs = Object.entries(node.attributes)
    .map(([name, value]) => {
      return ` ${name}="${escapeUTF8(value)}"`;
    })
    .join("");
  return `<${node.name}${attrs}>${node.children
    .map((item) => {
      return typeof item === "string" ? escapeUTF8(item) : xml(item);
    })
    .join("")}</${node.name}>`;
}

function number(
  node: XmlNode | undefined,
  name: string,
  defaultValue?: number,
): number {
  const value = node?.attributes[name];
  return value === undefined ? (defaultValue ?? Number.NaN) : Number(value);
}

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
function bounds(shape: XmlNode): Bounds | undefined {
  const props = child(shape, PRESENTATION, "spPr");
  const transform = props && child(props, DRAWING, "xfrm");
  if (!transform || Object.keys(transform.attributes).length) {
    return undefined;
  }
  const offset = child(transform, DRAWING, "off");
  const extent = child(transform, DRAWING, "ext");
  const result = {
    x: number(offset, "x"),
    y: number(offset, "y"),
    width: number(extent, "cx"),
    height: number(extent, "cy"),
  };
  return Object.values(result).every(Number.isSafeInteger) &&
    result.width > 0 &&
    result.height > 0
    ? result
    : undefined;
}

function cropSide(node: XmlNode | undefined, side: string): number {
  const value = node?.attributes[side];
  return value === undefined
    ? 0
    : /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
}

function plainPictureRectangle(props: XmlNode): boolean {
  const geometry = child(props, DRAWING, "prstGeom");
  const line = child(props, DRAWING, "ln");
  // Resizing another mask, a visible stroke, or an effect would change its
  // appearance inside the page, not merely clip its overflow.
  return (
    geometry?.attributes.prst === "rect" &&
    nodes(props).length === (line ? 3 : 2) &&
    nodes(props).every((node) => {
      return (
        node.uri === DRAWING && ["xfrm", "prstGeom", "ln"].includes(node.local)
      );
    }) &&
    (!line || child(line, DRAWING, "noFill") !== undefined)
  );
}

function plainPictureFrame(picture: XmlNode) {
  const box = bounds(picture);
  const props = child(picture, PRESENTATION, "spPr");
  const nonvisual = child(picture, PRESENTATION, "nvPicPr");
  if (!box || !props || !nonvisual || nodes(picture).length !== 3) {
    return undefined;
  }
  const application = child(nonvisual, PRESENTATION, "nvPr");
  if (
    !plainPictureRectangle(props) ||
    (application && nodes(application).length > 0)
  ) {
    return undefined;
  }
  const transform = child(props, DRAWING, "xfrm")!;
  const offset = child(transform, DRAWING, "off")!;
  const extent = child(transform, DRAWING, "ext")!;
  if (
    [
      offset.attributes.x,
      offset.attributes.y,
      extent.attributes.cx,
      extent.attributes.cy,
    ].some((value) => {
      return value === undefined || !/^-?\d+$/u.test(value);
    }) ||
    !Number.isSafeInteger(box.x + box.width) ||
    !Number.isSafeInteger(box.y + box.height)
  ) {
    return undefined;
  }
  return { box, offset, extent };
}

function stretchedPictureFill(picture: XmlNode) {
  const fill = child(picture, PRESENTATION, "blipFill");
  if (!fill) {
    return undefined;
  }
  const blip = child(fill, DRAWING, "blip");
  const stretch = child(fill, DRAWING, "stretch");
  const destination = stretch && child(stretch, DRAWING, "fillRect");
  const crop = child(fill, DRAWING, "srcRect");
  if (
    !blip ||
    !stretch ||
    nodes(fill).length !== (crop ? 3 : 2) ||
    ["l", "t", "r", "b"].some((side) => {
      return cropSide(destination, side) !== 0;
    })
  ) {
    return undefined;
  }
  return { node: fill, blip, crop };
}

function cropPicture(picture: XmlNode, width: number, height: number): boolean {
  const frame = plainPictureFrame(picture);
  const fill = stretchedPictureFill(picture);
  if (!frame || !fill) {
    return false;
  }
  const { box, offset, extent } = frame;
  const { blip, crop } = fill;
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(width, box.x + box.width);
  const bottom = Math.min(height, box.y + box.height);
  if (
    right <= left ||
    bottom <= top ||
    (left === box.x &&
      top === box.y &&
      right === box.x + box.width &&
      bottom === box.y + box.height)
  ) {
    return false;
  }
  const source = {
    l: cropSide(crop, "l"),
    t: cropSide(crop, "t"),
    r: cropSide(crop, "r"),
    b: cropSide(crop, "b"),
  };
  if (
    !Object.values(source).every(Number.isSafeInteger) ||
    source.l + source.r >= 100_000 ||
    source.t + source.b >= 100_000
  ) {
    return false;
  }
  const horizontal = 100_000 - source.l - source.r;
  const vertical = 100_000 - source.t - source.b;
  const clipped = {
    l: Math.round(source.l + ((left - box.x) / box.width) * horizontal),
    t: Math.round(source.t + ((top - box.y) / box.height) * vertical),
    r: Math.round(
      source.r + ((box.x + box.width - right) / box.width) * horizontal,
    ),
    b: Math.round(
      source.b + ((box.y + box.height - bottom) / box.height) * vertical,
    ),
  };
  if (clipped.l + clipped.r >= 100_000 || clipped.t + clipped.b >= 100_000) {
    return false;
  }
  // A prefix declared on blip alone is not in scope for its new sibling.
  const prefix = blip.name.slice(0, -blip.local.length);
  const prepared: XmlNode = crop ?? {
    name: `${prefix}srcRect`,
    local: "srcRect",
    uri: DRAWING,
    attributes: {
      [prefix ? `xmlns:${prefix.slice(0, -1)}` : "xmlns"]: DRAWING,
    },
    children: [],
  };
  for (const [side, value] of Object.entries(clipped)) {
    prepared.attributes[side] = String(value);
  }
  if (!crop) {
    fill.node.children.splice(
      fill.node.children.indexOf(blip) + 1,
      0,
      prepared,
    );
  }
  offset.attributes.x = String(left);
  offset.attributes.y = String(top);
  extent.attributes.cx = String(right - left);
  extent.attributes.cy = String(bottom - top);
  return true;
}

function cropSlidePictures(
  root: XmlNode,
  width: number,
  height: number,
): boolean {
  const content = child(root, PRESENTATION, "cSld");
  const tree = content && child(content, PRESENTATION, "spTree");
  const groupProps = tree && child(tree, PRESENTATION, "grpSpPr");
  // Animation can bring the clipped source area back onto the page. Group
  // coordinates and inherited geometry also remain owned by Google's importer.
  if (
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !tree ||
    (groupProps && nodes(groupProps).length > 0) ||
    child(root, PRESENTATION, "timing") ||
    child(root, PRESENTATION, "transition")
  ) {
    return false;
  }
  let changed = false;
  for (const picture of nodes(tree)) {
    if (
      picture.uri === PRESENTATION &&
      picture.local === "pic" &&
      cropPicture(picture, width, height)
    ) {
      changed = true;
    }
  }
  return changed;
}

interface TextRun {
  readonly node: XmlNode;
  readonly text: string;
  readonly size: number;
  readonly spacing: number;
  readonly face: SlidesFontFace;
}
interface TextFrame {
  readonly node: XmlNode;
  readonly paragraph: XmlNode;
  readonly paragraphStyle: string;
  readonly bodyStyle: string;
  readonly extent: XmlNode;
  readonly bounds: Bounds;
  readonly insets: number;
  readonly runs: readonly TextRun[];
}

function plainTextBox(shape: XmlNode) {
  if (shape.uri !== PRESENTATION || shape.local !== "sp") {
    return undefined;
  }
  const box = bounds(shape);
  const props = child(shape, PRESENTATION, "spPr");
  const nonvisual = child(shape, PRESENTATION, "nvSpPr");
  const body = child(shape, PRESENTATION, "txBody");
  if (!box || !props || !nonvisual || !body) {
    return undefined;
  }
  const identity = child(nonvisual, PRESENTATION, "cNvPr");
  const application = child(nonvisual, PRESENTATION, "nvPr");
  const boxProperty = child(nonvisual, PRESENTATION, "cNvSpPr");
  if (
    !identity ||
    nodes(identity).length > 0 ||
    (application && nodes(application).length > 0) ||
    boxProperty?.attributes.txBox !== "1"
  ) {
    return undefined;
  }
  if (
    nodes(shape).some((node) => {
      return !["nvSpPr", "spPr", "txBody"].includes(node.local);
    })
  ) {
    return undefined;
  }
  if (
    !child(props, DRAWING, "noFill") ||
    nodes(props).some((node) => {
      return !["xfrm", "prstGeom", "noFill", "ln"].includes(node.local);
    })
  ) {
    return undefined;
  }
  const line = child(props, DRAWING, "ln");
  if (line && !child(line, DRAWING, "noFill")) {
    return undefined;
  }
  return { box, props, body };
}

function singleLineParagraph(body: XmlNode) {
  const bodyProps = child(body, DRAWING, "bodyPr");
  if (
    !bodyProps ||
    bodyProps.attributes.wrap !== "none" ||
    (bodyProps.attributes.anchor ?? "t") !== "t" ||
    nodes(bodyProps).some((node) => {
      return node.local !== "noAutofit";
    })
  ) {
    return undefined;
  }
  if (
    Object.keys(bodyProps.attributes).some((name) => {
      return !["wrap", "lIns", "rIns", "tIns", "bIns", "anchor"].includes(name);
    })
  ) {
    return undefined;
  }
  const listStyle = child(body, DRAWING, "lstStyle");
  if (listStyle && nodes(listStyle).length > 0) {
    return undefined;
  }
  const paragraphs = nodes(body).filter((node) => {
    return node.uri === DRAWING && node.local === "p";
  });
  if (paragraphs.length !== 1) {
    return undefined;
  }
  const paragraph = paragraphs[0]!;
  const ppr = child(paragraph, DRAWING, "pPr");
  if (
    ppr &&
    (Object.entries(ppr.attributes).some(([name, value]) => {
      return name !== "algn" || value !== "l";
    }) ||
      nodes(ppr).some((node) => {
        return !["lnSpc", "spcBef", "spcAft"].includes(node.local);
      }))
  ) {
    return undefined;
  }
  if (
    nodes(paragraph).some((node) => {
      return !["pPr", "r", "endParaRPr"].includes(node.local);
    })
  ) {
    return undefined;
  }
  return { bodyProps, paragraph, ppr };
}

function supportsAdvances(text: string, properties: XmlNode): boolean {
  // Contextual/combining scripts need shaping-aware layout, not a sum of
  // advances. Preserve those frames rather than guessing font fallback.
  if (
    [...text].some((character) => {
      return (
        /[\p{Control}\p{Mark}\p{Format}]/u.test(character) ||
        (/\p{Letter}/u.test(character) && !/\p{Script=Latin}/u.test(character))
      );
    })
  ) {
    return false;
  }
  return (
    number(properties, "baseline", 0) === 0 &&
    [undefined, "none"].includes(properties.attributes.cap) &&
    !["1", "true"].includes(properties.attributes.normalizeH ?? "") &&
    !child(properties, DRAWING, "hlinkClick") &&
    !child(properties, DRAWING, "hlinkMouseOver")
  );
}

function textRun(run: XmlNode): TextRun | undefined {
  const properties = child(run, DRAWING, "rPr");
  const content = child(run, DRAWING, "t");
  if (!properties || !content) {
    return undefined;
  }
  const latin = child(properties, DRAWING, "latin");
  if (!latin) {
    return undefined;
  }
  const text = content.children
    .filter((item): item is string => {
      return typeof item === "string";
    })
    .join("");
  const size = number(properties, "sz");
  const spacing = number(properties, "spc", 0);
  const face = slidesFontFace(
    latin.attributes.typeface ?? "",
    ["1", "true"].includes(properties.attributes.b ?? ""),
    ["1", "true"].includes(properties.attributes.i ?? ""),
  );
  if (
    !text ||
    !face ||
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(spacing) ||
    size <= 0 ||
    !supportsAdvances(text, properties)
  ) {
    return undefined;
  }
  return { node: run, text, size: size / 100, spacing: spacing / 100, face };
}

function frame(shape: XmlNode): TextFrame | undefined {
  const parts = plainTextBox(shape);
  if (!parts) {
    return undefined;
  }
  const { box, props, body } = parts;
  const line = singleLineParagraph(body);
  if (!line) {
    return undefined;
  }
  const { bodyProps, paragraph, ppr } = line;
  // A moved run must retain the namespace bindings it had in its source box.
  // Keep locally rebound text containers intact instead of rewriting prefixes.
  if (
    [shape, body, paragraph].some((node) => {
      return Object.keys(node.attributes).some((name) => {
        return name === "xmlns" || name.startsWith("xmlns:");
      });
    })
  ) {
    return undefined;
  }
  const runs: TextRun[] = [];
  for (const node of nodes(paragraph).filter((node) => {
    return node.local === "r";
  })) {
    const run = textRun(node);
    if (!run) {
      return undefined;
    }
    runs.push(run);
  }
  const leftInset = number(bodyProps, "lIns", 91_440);
  const rightInset = number(bodyProps, "rIns", 91_440);
  const insets = leftInset + rightInset;
  if (
    !runs.length ||
    !Number.isSafeInteger(insets) ||
    leftInset < 0 ||
    rightInset < 0
  ) {
    return undefined;
  }
  return {
    node: shape,
    paragraph,
    paragraphStyle: ppr ? xml(ppr) : "",
    bodyStyle: xml(bodyProps),
    extent: child(child(props, DRAWING, "xfrm")!, DRAWING, "ext")!,
    bounds: box,
    insets,
    runs,
  };
}

function inline(left: TextFrame, right: TextFrame): boolean {
  const a = left.bounds,
    b = right.bounds;
  const style = left.runs[0]!;
  return (
    left.insets === 0 &&
    right.insets === 0 &&
    a.y === b.y &&
    a.height === b.height &&
    b.x > a.x &&
    b.x < a.x + a.width &&
    [...left.runs, ...right.runs].every((run) => {
      return (
        run.size === style.size &&
        run.face.family === style.face.family &&
        run.face.italic === style.face.italic
      );
    }) &&
    left.paragraphStyle === right.paragraphStyle &&
    left.bodyStyle === right.bodyStyle
  );
}

function intersects(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function readPresentation(file: Buffer) {
  let bytes = 0,
    entries = 0;
  const archive = unzipSync(file, {
    filter(entry) {
      bytes += entry.originalSize;
      entries += 1;
      if (bytes > 100 * 1024 * 1024 || entries > 10_000) {
        throw new Error("Presentation exceeds the import limit");
      }
      return true;
    },
  });
  const presentation = archive["ppt/presentation.xml"];
  const size =
    presentation && child(readXml(presentation), PRESENTATION, "sldSz");
  const slideWidth = number(size, "cx");
  const slides = Object.entries(archive)
    .filter(([name]) => {
      return /^ppt\/slides\/slide\d+\.xml$/u.test(name);
    })
    .map(([name, data]) => {
      return { name, root: readXml(data) };
    });
  return { archive, slides, slideWidth, slideHeight: number(size, "cy") };
}

function inlineGroups(elements: readonly XmlNode[]): TextFrame[][] {
  const clusters: TextFrame[][] = [];
  let cluster: TextFrame[] = [];
  for (const element of elements) {
    const current = frame(element);
    if (!current || (cluster.length && !inline(cluster.at(-1)!, current))) {
      if (cluster.length) {
        clusters.push(cluster);
      }
      cluster = [];
    }
    if (current) {
      cluster.push(current);
    }
  }
  if (cluster.length) {
    clusters.push(cluster);
  }
  return clusters;
}

async function measureGroup(
  group: readonly TextFrame[],
  fonts: Map<string, Font | undefined>,
  signal: AbortSignal,
): Promise<number | undefined> {
  let requiredWidth = group[0]!.insets;
  const layouts: {
    font: Font;
    size: number;
    text: string;
    advance: number;
  }[] = [];
  let previousSourceEnd: number | undefined;
  for (const item of group) {
    // Overlapping frames alone do not establish a shared line. Require
    // contiguous source text as well, allowing half an em for kerning and
    // exporter rounding. Separate columns with spare capacity stay intact.
    if (
      previousSourceEnd !== undefined &&
      Math.abs(item.bounds.x - previousSourceEnd) >
        (item.runs[0]!.size * EMU_PER_POINT) / 2
    ) {
      return undefined;
    }
    let sourceWidth = 0;
    for (const run of item.runs) {
      const key = JSON.stringify(run.face);
      if (!fonts.has(key)) {
        fonts.set(key, await loadSlidesFont(run.face, signal));
        signal.throwIfAborted();
      }
      const font = fonts.get(key);
      if (
        !font ||
        [...run.text].some((character) => {
          return !font.hasGlyphForCodePoint(character.codePointAt(0)!);
        })
      ) {
        return undefined;
      }
      const advance = [...run.text].reduce((total, character) => {
        return (
          total + font.glyphForCodePoint(character.codePointAt(0)!).advanceWidth
        );
      }, 0);
      const previous = layouts.at(-1);
      // Paint-only run boundaries must not hide a kerning pair. Measure
      // adjacent text together whenever its font and size are unchanged.
      if (previous?.font === font && previous.size === run.size) {
        previous.text += run.text;
        previous.advance += advance;
      } else {
        layouts.push({ font, size: run.size, text: run.text, advance });
      }
      sourceWidth +=
        ((advance * run.size) / font.unitsPerEm +
          [...run.text].length * run.spacing) *
        EMU_PER_POINT;
    }
    previousSourceEnd = item.bounds.x + sourceWidth;
  }
  for (const { font, size, text, advance } of layouts) {
    // Kerning can widen a pair (for example, Geist's "06"). Retain the
    // unkerned reservation too, for renderers that omit negative kerning.
    requiredWidth +=
      ((Math.max(advance, font.layout(text).advanceWidth) * size) /
        font.unitsPerEm) *
      EMU_PER_POINT;
  }
  // An exact-fit frame can still wrap in the editor while Google's server
  // renderer keeps the line intact. Reserve one point of layout tolerance
  // (more than one CSS pixel at 96dpi), without changing the glyph sizes.
  // applyGroup includes this capacity in its collision and page-edge checks.
  return requiredWidth + EMU_PER_POINT;
}

interface SlideContext {
  readonly tree: XmlNode;
  readonly elements: readonly XmlNode[];
  readonly width: number;
}

function applyGroup(
  group: readonly TextFrame[],
  requiredWidth: number,
  slide: SlideContext,
): boolean {
  const first = group[0]!;
  const original: Bounds = {
    ...first.bounds,
    width:
      Math.max(
        ...group.map((item) => {
          return item.bounds.x + item.bounds.width;
        }),
      ) - first.bounds.x,
  };
  const expanded: Bounds = {
    ...original,
    width: Math.max(original.width, Math.ceil(requiredWidth)),
  };
  if (expanded.x + expanded.width > slide.width) {
    return false;
  }
  const members = new Set(
    group.map((item) => {
      return item.node;
    }),
  );
  if (
    slide.elements.some((element) => {
      if (members.has(element)) {
        return false;
      }
      // Images painted below the text may be transparent artwork or
      // intentional backgrounds. Their rectangular bounds do not define
      // text-flow obstacles; retain the source's image-under-text layering.
      if (
        element.local === "pic" &&
        slide.elements.indexOf(element) < slide.elements.indexOf(first.node)
      ) {
        return false;
      }
      const other = bounds(element);
      return (
        other && intersects(expanded, other) && !intersects(original, other)
      );
    })
  ) {
    return false;
  }
  if (group.length === 1 && expanded.width === original.width) {
    return false;
  }
  first.extent.attributes.cx = String(expanded.width);
  // endParaRPr must remain the last child of the combined paragraph.
  const end = child(first.paragraph, DRAWING, "endParaRPr");
  first.paragraph.children = first.paragraph.children.filter((item) => {
    return item !== end;
  });
  for (const following of group.slice(1)) {
    first.paragraph.children.push(
      ...following.runs.map((run) => {
        return run.node;
      }),
    );
    slide.tree.children = slide.tree.children.filter((item) => {
      return item !== following.node;
    });
  }
  if (end) {
    first.paragraph.children.push(end);
  }
  return true;
}

async function prepareSlide(
  root: XmlNode,
  width: number,
  fonts: Map<string, Font | undefined>,
  signal: AbortSignal,
): Promise<boolean> {
  // Removing a styled fragment would invalidate animation/shape references.
  if (child(root, PRESENTATION, "timing")) {
    return false;
  }
  const content = child(root, PRESENTATION, "cSld");
  const tree = content && child(content, PRESENTATION, "spTree");
  if (
    !tree ||
    nodes(tree).some((node) => {
      return (
        ["cxnSp", "grpSp", "graphicFrame", "AlternateContent"].includes(
          node.local,
        ) ||
        (["sp", "pic"].includes(node.local) && !bounds(node))
      );
    })
  ) {
    return false;
  }
  const elements = nodes(tree);
  let changed = false;
  for (const group of inlineGroups(elements)) {
    const measured = await measureGroup(group, fonts, signal);
    if (
      measured !== undefined &&
      applyGroup(group, measured, { tree, elements, width })
    ) {
      changed = true;
    }
  }
  return changed;
}

/** Prepare supported editable text and static picture crops for import. Other
 * shapes/archives stay owned by Google's importer; never invent a font. */
export async function prepareGoogleSlidesImport(
  source: { readonly filename: string; readonly file: Buffer },
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly file: Buffer }
  | { readonly ok: false; readonly message: string }
> {
  if (
    !/\.pptx$/iu.test(source.filename) ||
    source.file.length < 2 ||
    source.file.readUInt16LE(0) !== 0x4b_50
  ) {
    return { ok: true, file: source.file };
  }
  const parsed = safeSync(() => {
    return readPresentation(source.file);
  });
  if ("error" in parsed) {
    return {
      ok: false,
      message:
        "This presentation is damaged or too large to prepare for Google Slides",
    };
  }
  const { archive, slides, slideWidth, slideHeight } = parsed.ok;
  if (!Number.isSafeInteger(slideWidth) || slideWidth <= 0) {
    return { ok: true, file: source.file };
  }
  const fonts = new Map<string, Font | undefined>();
  let changed = false;
  for (const slide of slides) {
    signal.throwIfAborted();
    const prepared = await settle(
      prepareSlide(slide.root, slideWidth, fonts, signal),
    );
    signal.throwIfAborted();
    if (!prepared.ok) {
      return {
        ok: false,
        message:
          "Could not load the fonts needed for Google Slides conversion. Please try again.",
      };
    }
    const picturesCropped = cropSlidePictures(
      slide.root,
      slideWidth,
      slideHeight,
    );
    if (prepared.value || picturesCropped) {
      archive[slide.name] = strToU8(xml(slide.root));
      changed = true;
    }
  }
  return {
    ok: true,
    file: changed ? Buffer.from(zipSync(archive)) : source.file,
  };
}
