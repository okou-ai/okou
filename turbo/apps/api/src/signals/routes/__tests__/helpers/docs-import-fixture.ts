import AdmZip from "adm-zip";
import { SaxesParser } from "saxes";

const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Synthetic Word content with separate Latin and East Asian font declarations. */
export function docsImportFixture(): Buffer {
  const archive = new AdmZip();
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="header" Type="${REL}/header" Target="header1.xml"/><Relationship Id="footer" Type="${REL}/footer" Target="footer1.xml"/><Relationship Id="link" Type="${REL}/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`,
    "word/styles.xml": `<w:styles xmlns:w="${WORD}">
      <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:eastAsia="Noto Serif CJK SC"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:default="1" w:styleId="Normal"/>
      <w:style w:type="paragraph" w:styleId="HeadingBase"><w:rPr><w:rFonts w:ascii="Liberation Sans" w:hAnsi="Liberation Sans" w:eastAsia="Noto Sans CJK SC"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="Heading"><w:basedOn w:val="HeadingBase"/></w:style>
      <w:style w:type="character" w:styleId="Emphasis"><w:rPr><w:rFonts w:eastAsia="Noto Sans SC"/></w:rPr></w:style>
      <w:style w:type="table" w:styleId="SansTable"><w:rPr><w:rFonts w:eastAsia="Noto Sans CJK SC"/></w:rPr></w:style>
      <w:style w:type="table" w:styleId="Conditional"><w:tblStylePr w:type="firstRow"><w:rPr><w:rFonts w:eastAsia="Unlisted CJK"/></w:rPr></w:tblStylePr></w:style>
    </w:styles>`,
    "word/document.xml": `<w:document xmlns:w="${WORD}" xmlns:r="${REL}"><w:body>
      <w:p><w:pPr><w:spacing w:after="120" w:line="276"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:eastAsia="Noto Serif CJK SC"/><w:b/><w:color w:val="123456"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">Hello 合同（中文），&amp; 2026 </w:t><w:tab/><w:br/><w:t>尾款</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>Title 标题</w:t></w:r></w:p>
      <w:p><w:r><w:t>Inherited 正文</w:t></w:r><w:hyperlink r:id="link" w:tooltip="First&#10;second"><w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:i/></w:rPr><w:t>链接</w:t></w:r></w:hyperlink></w:p>
      <w:tbl><w:tblPr><w:tblStyle w:val="SansTable"/><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>Table 表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:tbl><w:tblPr><w:tblStyle w:val="Conditional"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>条件字体</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Unlisted CJK"/></w:rPr><w:t>Custom 自定义</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/></w:rPr><w:t>Theme 主题</w:t></w:r></w:p>
      <w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>
      <w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
    </w:body></w:document>`,
    "word/header1.xml": `<q:hdr xmlns:q="${WORD}"><q:p><q:r><q:t>Header 页眉</q:t></q:r></q:p></q:hdr>`,
    "word/footer1.xml": `<ftr xmlns="${WORD}" xmlns:w="${WORD}"><p><r><t>Footer 页脚</t></r><r><fldChar w:fldCharType="begin"/></r><r><instrText xml:space="preserve"> PAGE </instrText></r><r><fldChar w:fldCharType="end"/></r></p></ftr>`,
  };
  for (const [name, content] of Object.entries(parts)) {
    archive.addFile(name, Buffer.from(content));
  }
  return archive.toBuffer();
}

/** Observe text and direct run formatting at the Drive upload boundary. */
export function uploadedDocsText(bytes: Uint8Array) {
  const result: {
    part: string;
    text: string;
    fonts: Record<string, string>;
    size?: string;
    color?: string;
    bold?: boolean;
    italic?: boolean;
  }[] = [];
  const archive = new AdmZip(Buffer.from(bytes));
  for (const name of [
    "word/document.xml",
    "word/header1.xml",
    "word/footer1.xml",
  ]) {
    const parser = new SaxesParser({ xmlns: true });
    const runs: (typeof result)[number][] = [];
    let inText = false;
    parser.on("opentag", (tag) => {
      if (tag.uri !== WORD) {
        return;
      }
      if (tag.local === "r") {
        runs.push({ part: name, text: "", fonts: {} });
      }
      const current = runs.at(-1);
      if (!current) {
        return;
      }
      const attrs = Object.fromEntries(
        Object.values(tag.attributes)
          .filter((item) => {
            return item.uri === WORD;
          })
          .map((item) => {
            return [item.local, item.value];
          }),
      );
      switch (tag.local) {
        case "rFonts": {
          current.fonts = attrs;
          break;
        }
        case "sz": {
          current.size = attrs.val;
          break;
        }
        case "color": {
          current.color = attrs.val;
          break;
        }
        case "b": {
          current.bold = true;
          break;
        }
        case "i": {
          current.italic = true;
          break;
        }
        case "t": {
          inText = true;
          break;
        }
        case "tab": {
          current.text += "\t";
          break;
        }
        case "br": {
          current.text += "\n";
          break;
        }
      }
    });
    parser.on("text", (text) => {
      const current = runs.at(-1);
      if (inText && current) {
        current.text += text;
      }
    });
    parser.on("closetag", (tag) => {
      if (tag.uri === WORD && tag.local === "t") {
        inText = false;
      }
      if (tag.uri === WORD && tag.local === "r") {
        const run = runs.pop();
        if (run?.text) {
          result.push(run);
        }
      }
    });
    parser.write(archive.readAsText(name)).close();
  }
  return result;
}
