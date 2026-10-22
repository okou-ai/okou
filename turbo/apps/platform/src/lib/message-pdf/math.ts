import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler as registerHtmlHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";

import type { PdfMathRenderer } from "./types.ts";

/** Create one isolated MathJax document per export worker, never in the UI. */
export function createPdfMathRenderer(): PdfMathRenderer {
  const adaptor = liteAdaptor();
  registerHtmlHandler(adaptor);
  const input = new TeX({
    // Do not enable TeX's HTML/URL extensions or error-to-source fallbacks.
    packages: AllPackages.filter((name) => {
      return ![
        "html",
        "noerrors",
        "noundefined",
        "require",
        "autoload",
      ].includes(name);
    }),
    maxMacros: 1000,
    maxBuffer: 10_000,
    formatError(_jax: unknown, error: Error) {
      throw error;
    },
  });
  const output = new SVG({ fontCache: "none" });
  const mathDocument = mathjax.document("", {
    InputJax: input,
    OutputJax: output,
  });
  return (source, display) => {
    const container = mathDocument.convert(source, {
      display,
      em: 10,
      ex: 5,
      containerWidth: 499,
    });
    const svg = adaptor.tags(container, "svg")[0];
    if (!svg || adaptor.outerHTML(svg).includes('data-mml-node="merror"')) {
      throw new Error("PDF formula could not be rendered");
    }
    const box = adaptor
      .getAttribute(svg, "viewBox")
      .trim()
      .split(/\s+/u)
      .map(Number);
    const width = box[2];
    const height = box[3];
    if (!(width && height && width > 0 && height > 0)) {
      throw new Error("PDF formula has invalid dimensions");
    }
    // MathJax's viewBox uses 1000 units per em. Explicit points avoid SVG ex
    // units being resolved against pdfmake's unrelated default font size.
    const widthPt = width / 100;
    const heightPt = height / 100;
    adaptor.setAttribute(svg, "width", `${widthPt}pt`);
    adaptor.setAttribute(svg, "height", `${heightPt}pt`);
    return { svg: adaptor.outerHTML(svg), width: widthPt, height: heightPt };
  };
}
