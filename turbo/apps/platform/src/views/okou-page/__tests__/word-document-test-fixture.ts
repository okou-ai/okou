import { strToU8, zipSync } from "fflate";
import { renderWordDocumentPreview } from "../../../lib/word-document-renderer.ts";

/** Unit tests use the real renderer; browser QA covers asset discovery/loading. */
export function installWordPreviewRuntime(signal: AbortSignal): void {
  window.__okouWordPreview = { render: renderWordDocumentPreview };
  signal.addEventListener(
    "abort",
    () => {
      Reflect.deleteProperty(window, "__okouWordPreview");
    },
    { once: true },
  );
}

/** A real, small OOXML package exercising text and document links. */
export function wordDocumentFixture(
  htmlImport = false,
): Uint8Array<ArrayBuffer> {
  const entries = {
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Word preview keeps document gestures local.</w:t></w:r></w:p><w:p><w:hyperlink r:id="external"><w:r><w:t>Read the source</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink r:id="unsafe"><w:r><w:t>Unsafe document link</w:t></w:r></w:hyperlink></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>',
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/word-source" TargetMode="External"/><Relationship Id="unsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>',
    ),
  };
  if (htmlImport) {
    entries["word/_rels/document.xml.rels"] = strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="html" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="content.html"/></Relationships>',
    );
  }
  return zipSync(entries);
}
