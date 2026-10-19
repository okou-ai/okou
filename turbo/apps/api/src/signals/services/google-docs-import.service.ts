import { escapeUTF8 } from "entities";
import { strToU8, unzipSync, zipSync } from "fflate";
import { SaxesParser, type SaxesAttributeNS } from "saxes";

const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const FONT_SLOTS = ["ascii", "hAnsi", "eastAsia", "cs"] as const;
type FontSlot = (typeof FONT_SLOTS)[number];
type Fonts = Partial<Record<FontSlot, string | undefined>>;

// These names were verified against Drive's DOCX importer and PDF output.
const FONT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "Noto Serif CJK SC": "Noto Serif SC",
  "Noto Sans CJK SC": "Noto Sans SC",
  "Liberation Serif": "Times New Roman",
  "Liberation Sans": "Arial",
});
const CHINESE_FONTS = Object.freeze(["Noto Serif SC", "Noto Sans SC"]);
const CHINESE_TEXT = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;
const TEXT_PARTS =
  /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]+|[^\p{Script=Han}\u3000-\u303f\uff00-\uffef]+/gu;

interface XmlNode {
  readonly name: string;
  readonly local: string;
  readonly uri: string;
  attributes: SaxesAttributeNS[];
  children: (XmlNode | string)[];
}

function isWord<Local extends string>(
  node: XmlNode | string,
  local: Local,
): node is XmlNode & { readonly local: Local; readonly uri: typeof WORD } {
  return typeof node !== "string" && node.uri === WORD && node.local === local;
}

function child(node: XmlNode | undefined, local: string): XmlNode | undefined {
  return node?.children.find((item): item is XmlNode => {
    return isWord(item, local);
  });
}

function attribute(
  node: XmlNode | undefined,
  local: string,
): string | undefined {
  return node?.attributes.find((item) => {
    return item.uri === WORD && item.local === local;
  })?.value;
}

function readXml(bytes: Uint8Array): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let count = 0;
  parser.on("doctype", () => {
    throw new Error("Document XML must not contain a DTD");
  });
  parser.on("opentag", (tag) => {
    count += 1;
    if (count > 100_000 || stack.length > 100) {
      throw new Error("Document XML exceeds the import limit");
    }
    const node: XmlNode = {
      name: tag.name,
      local: tag.local,
      uri: tag.uri,
      attributes: Object.values(tag.attributes),
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
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf8";
  parser
    .write(new TextDecoder(encoding, { fatal: true }).decode(bytes))
    .close();
  if (!root) {
    throw new Error("Document XML is empty");
  }
  return root;
}

function xml(node: XmlNode): string {
  const attributes = node.attributes
    .map((item) => {
      const value = escapeUTF8(item.value).replace(
        /[\r\n\t]/gu,
        (character) => {
          return `&#${String(character.charCodeAt(0))};`;
        },
      );
      return ` ${item.name}="${value}"`;
    })
    .join("");
  return `<${node.name}${attributes}>${node.children
    .map((item) => {
      return typeof item === "string"
        ? escapeUTF8(item).replaceAll("\r", "&#13;")
        : xml(item);
    })
    .join("")}</${node.name}>`;
}

function readFonts(properties: XmlNode | undefined): Fonts {
  const node = child(properties, "rFonts");
  const fonts: Fonts = {};
  for (const slot of FONT_SLOTS) {
    // A theme reference at this level overrides an inherited explicit face.
    // Leave unresolved theme fonts to the importer instead of guessing a face.
    const theme = slot === "cs" ? "cstheme" : `${slot}Theme`;
    if (attribute(node, theme) !== undefined) {
      fonts[slot] = undefined;
    } else if (attribute(node, slot) !== undefined) {
      fonts[slot] = attribute(node, slot);
    }
  }
  return fonts;
}

function fontStyles(root: XmlNode | undefined) {
  const styles = new Map<string, XmlNode>();
  const defaults = new Map<string, string>();
  for (const node of root?.children ?? []) {
    if (!isWord(node, "style")) {
      continue;
    }
    const id = attribute(node, "styleId");
    if (id) {
      styles.set(id, node);
      if (["1", "true"].includes(attribute(node, "default") ?? "")) {
        defaults.set(attribute(node, "type") ?? "", id);
      }
    }
  }
  const resolved = new Map<string, Fonts>();
  const resolve = (id: string | undefined, seen = new Set<string>()): Fonts => {
    if (!id || !styles.has(id)) {
      return {};
    }
    const cached = resolved.get(id);
    if (cached) {
      return cached;
    }
    if (seen.has(id) || seen.size >= 100) {
      throw new Error(
        "Document font style inheritance exceeds the import limit",
      );
    }
    seen.add(id);
    const style = styles.get(id)!;
    const fonts = {
      ...resolve(attribute(child(style, "basedOn"), "val"), seen),
      ...readFonts(child(style, "rPr")),
    };
    // Conditional table formatting needs Word's layout rules. Do not replace
    // those faces with document defaults when their effective value is unknown.
    for (const condition of style.children) {
      if (isWord(condition, "tblStylePr")) {
        for (const slot of FONT_SLOTS) {
          if (slot in readFonts(child(condition, "rPr"))) {
            fonts[slot] = undefined;
          }
        }
      }
    }
    resolved.set(id, fonts);
    return fonts;
  };
  return {
    defaults: readFonts(
      child(child(child(root, "docDefaults"), "rPrDefault"), "rPr"),
    ),
    resolve: (type: string, id: string | undefined) => {
      return resolve(id ?? defaults.get(type));
    },
  };
}

function wordChild(parent: XmlNode, local: string): XmlNode {
  return {
    name: parent.name.slice(0, -parent.local.length) + local,
    local,
    uri: WORD,
    attributes: [],
    children: [],
  };
}

function setFont(node: XmlNode, slot: FontSlot, value: string): void {
  const theme = slot === "cs" ? "cstheme" : `${slot}Theme`;
  node.attributes = node.attributes.filter((item) => {
    return item.uri !== WORD || (item.local !== slot && item.local !== theme);
  });
  let prefix = node.name.includes(":")
    ? node.name.split(":")[0]!
    : (node.attributes.find((item) => {
        return item.uri === WORD && item.prefix;
      })?.prefix ?? "");
  if (!prefix) {
    prefix = "font";
    while (
      node.attributes.some((item) => {
        return item.prefix === prefix || item.name === `xmlns:${prefix}`;
      })
    ) {
      prefix += "_";
    }
    node.attributes.push({
      name: `xmlns:${prefix}`,
      prefix: "xmlns",
      local: prefix,
      uri: XMLNS,
      value: WORD,
    });
  }
  node.attributes.push({
    name: `${prefix}:${slot}`,
    prefix,
    local: slot,
    uri: WORD,
    value,
  });
}

function withFonts(
  run: XmlNode,
  content: XmlNode | string,
  fonts: Fonts,
): XmlNode {
  const original = child(run, "rPr") ?? wordChild(run, "rPr");
  const originalFonts =
    child(original, "rFonts") ?? wordChild(original, "rFonts");
  const preparedFonts = {
    ...originalFonts,
    attributes: [...originalFonts.attributes],
  };
  for (const slot of FONT_SLOTS) {
    const face = fonts[slot];
    if (face !== undefined) {
      setFont(preparedFonts, slot, face);
    }
  }
  const children = original.children.map((item) => {
    return isWord(item, "rFonts") ? preparedFonts : item;
  });
  if (!child(original, "rFonts")) {
    const style = children.findIndex((item) => {
      return isWord(item, "rStyle");
    });
    children.splice(style + 1, 0, preparedFonts);
  }
  const properties = { ...original, children };
  return { ...run, children: [properties, content] };
}

function googleFontAlias(face: string): string | undefined {
  return Object.hasOwn(FONT_ALIASES, face) ? FONT_ALIASES[face] : undefined;
}

function googleFontAliases(fonts: Fonts): Fonts {
  const aliases: Fonts = {};
  for (const slot of FONT_SLOTS) {
    const mapped = googleFontAlias(fonts[slot] ?? "");
    if (mapped) {
      aliases[slot] = mapped;
    }
  }
  return aliases;
}

function prepareRun(
  run: XmlNode,
  inherited: Fonts,
  budget: { runs: number; bytes: number },
): XmlNode[] {
  const fonts = { ...inherited, ...readFonts(child(run, "rPr")) };
  const aliases = googleFontAliases(fonts);
  const eastAsia =
    "eastAsia" in fonts ? fonts.eastAsia : (fonts.ascii ?? fonts.hAnsi);
  const chinese = googleFontAlias(eastAsia ?? "") ?? eastAsia;
  const chineseFont =
    chinese && CHINESE_FONTS.includes(chinese) ? chinese : undefined;
  if (!chineseFont && Object.keys(aliases).length === 0) {
    return [run];
  }
  const result: XmlNode[] = [];
  const append = (content: XmlNode | string, selected: Fonts) => {
    const prepared = withFonts(run, content, selected);
    budget.runs += 1;
    budget.bytes += Buffer.byteLength(xml(prepared));
    if (budget.runs > 100_000 || budget.bytes > 100 * 1024 * 1024) {
      throw new Error("Document font preparation exceeds the import limit");
    }
    result.push(prepared);
  };
  for (const item of run.children) {
    if (isWord(item, "rPr") || typeof item === "string") {
      // Whitespace between run children is XML formatting, not document text.
      continue;
    }
    if (!isWord(item, "t")) {
      append(item, aliases);
      continue;
    }
    const text = item.children
      .map((value) => {
        if (typeof value !== "string") {
          throw new Error("Document text contains an unexpected element");
        }
        return value;
      })
      .join("");
    for (const [part] of text.matchAll(TEXT_PARTS)) {
      const selected = { ...aliases };
      if (chineseFont && CHINESE_TEXT.test(part)) {
        // Google imports one font per text run; w:eastAsia alone is lost.
        for (const slot of FONT_SLOTS) {
          selected[slot] = chineseFont;
        }
      }
      append(
        {
          ...item,
          attributes: [
            ...item.attributes.filter((value) => {
              return value.uri !== XML || value.local !== "space";
            }),
            {
              name: "xml:space",
              prefix: "xml",
              local: "space",
              uri: XML,
              value: "preserve",
            },
          ],
          children: [part],
        },
        selected,
      );
    }
  }
  return result.length ? result : [run];
}

/** Called only after the archive's expanded size and entry count are validated. */
export function prepareGoogleDocsFonts(file: Buffer): Buffer {
  const archive = unzipSync(file);
  const styles = fontStyles(
    archive["word/styles.xml"]
      ? readXml(archive["word/styles.xml"])
      : undefined,
  );
  const budget = { runs: 0, bytes: 0 };
  let expandedBytes = Object.values(archive).reduce((size, bytes) => {
    return size + bytes.length;
  }, 0);
  let changed = false;
  const visit = (node: XmlNode, inherited: Fonts, tableFonts: Fonts): void => {
    if (isWord(node, "tbl")) {
      tableFonts = styles.resolve(
        "table",
        attribute(child(child(node, "tblPr"), "tblStyle"), "val"),
      );
    }
    let fonts = inherited;
    if (isWord(node, "p")) {
      fonts = {
        ...styles.defaults,
        ...tableFonts,
        ...styles.resolve(
          "paragraph",
          attribute(child(child(node, "pPr"), "pStyle"), "val"),
        ),
      };
    }
    node.children = node.children.flatMap<XmlNode | string>((item) => {
      if (typeof item === "string") {
        return [item];
      }
      if (isWord(item, "r")) {
        visit(item, fonts, tableFonts);
        return prepareRun(
          item,
          {
            ...fonts,
            ...styles.resolve(
              "character",
              attribute(child(child(item, "rPr"), "rStyle"), "val"),
            ),
          },
          budget,
        );
      }
      visit(item, fonts, tableFonts);
      return [item];
    });
  };
  for (const [name, bytes] of Object.entries(archive)) {
    // Includes headers, footers, footnotes, comments and text boxes in each part.
    if (!/^word\/[^/]+\.xml$/u.test(name) || name === "word/styles.xml") {
      continue;
    }
    const root = readXml(bytes);
    const before = xml(root);
    visit(root, styles.defaults, {});
    const after = xml(root);
    if (after !== before) {
      const prepared = strToU8(after);
      expandedBytes += prepared.length - bytes.length;
      if (expandedBytes > 100 * 1024 * 1024) {
        throw new Error("Document font preparation exceeds the import limit");
      }
      archive[name] = prepared;
      changed = true;
    }
  }
  return changed ? Buffer.from(zipSync(archive)) : file;
}
