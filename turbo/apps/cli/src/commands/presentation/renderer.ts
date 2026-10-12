/**
 * dom-to-pptx 2.1.2 has no native-only export policy. Adapt its pinned bundle at
 * the render queue boundary, before image jobs run. Reject an unfamiliar bundle
 * instead of silently enabling its image fallbacks. Keep this function standalone
 * so remote browser sessions apply exactly the same policy as local exports.
 */
export function nativeRenderer(source: string): string {
  const replacements = [
    [
      "      if (result) {\n        if (result.items) {",
      `      result = window.__okouNativeRender(node, result, layoutConfig, pptx, {...globalOptions,_inheritedOpacity:parentOpacity});
      if (result) {
        const media = node.nodeType === 1 && ['img','svg','canvas'].includes(node.localName);
        const omitted = (result.items || []).filter(item => item.type === 'image' && !media && !item.sourceImage);
        if (omitted.length) {
          globalOptions.onUnsupported?.({page:globalOptions._slideIndex+1,tag:node.nodeName,images:omitted.length});
          result.items = result.items.filter(item => !omitted.includes(item));
          if (!result.items.some(item => item.type === 'image')) result.job = null;
          if (!result.items.length) result.stopRecursion = false;
        }
        if (result.items) {`,
    ],
    ["items.push(bgItem);", "bgItem.sourceImage = true; items.push(bgItem);"],
    // A source background image can share a job with a synthetic pseudo image.
    // Disable both DOM capture helpers even when that source-image job survives.
    [
      "async function elementToCanvasImage(node, widthPx, heightPx) {",
      "async function elementToCanvasImage(node, widthPx, heightPx) { return null;",
    ],
    [
      "async function capturePseudoElementCanvas(node, pseudoType, widthPx, heightPx) {",
      "async function capturePseudoElementCanvas(node, pseudoType, widthPx, heightPx) { return null;",
    ],
  ] as const;
  let result = source.replaceAll("\r\n", "\n");
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) {
      throw new Error("Unsupported dom-to-pptx bundle for native export");
    }
    result = result.replace(before, after);
  }
  const nativeReplacements = [
    [
      "const elements = Array.isArray(target) ? target : [target];",
      `const elements = Array.isArray(target) ? target : [target];
    options.fonts = await window.__okouNative.prepareFonts(elements, getAutoDetectedFonts, async buffer => {
      const magic=String.fromCharCode(...new Uint8Array(buffer,0,4));
      if(magic==='wOF2'){await main_esmExports.woff2.init(woff2WasmBase64);return main_esmExports.woff2tottf(buffer);}
      if(magic==='wOFF')return main_esmExports.woff2ttf(buffer,{inflate:pako.inflate});
      return buffer;
    }, buffer=>main_esmExports.ttf2eot(buffer));
    options.autoEmbedFonts = false;`,
    ],
    [
      "async function fontToEot(typeOrSubsets, fontBufferOrWasmUrl, wasmUrl) {",
      `async function fontToEot(typeOrSubsets, fontBufferOrWasmUrl, wasmUrl) {
    if(Array.isArray(typeOrSubsets)&&typeOrSubsets.length===1){const buffer=typeOrSubsets[0].buffer;if(buffer.byteLength>36&&new DataView(buffer).getUint16(34,true)===0x504c)return buffer;}`,
    ],
    [
      "fontFace: style.fontFamily.split(',')[0].replace(/['\"]/g, ''),",
      "fontFace: window.__okouNative.fontStyle(style).fontFace,",
    ],
    [
      "bold: parseInt(style.fontWeight) >= 600,",
      "bold: window.__okouNative.fontStyle(style).bold,",
    ],
    [
      "italic: style.fontStyle === 'italic',",
      "italic: window.__okouNative.fontStyle(style).italic,",
    ],
    [
      "console.warn(`Failed to embed font family: ${fontCfg.name}`, e);",
      "throw new Error('Cannot embed native presentation font: ' + fontCfg.name, {cause:e});",
    ],
    [
      "const result = prepareRenderItem(node,",
      "let result = prepareRenderItem(node,",
    ],
    [
      "if (node.nodeType === 1) {\n      const beforeStyle",
      "if (node.nodeType === 1 && !window.__okouNative) {\n      const beforeStyle",
    ],
    [
      "if (node.nodeType === 1) {\n      const afterStyle",
      "if (node.nodeType === 1 && !window.__okouNative) {\n      const afterStyle",
    ],
    [
      "if ((nodeTag === 'ul' || nodeTag === 'ol') && !isComplexHierarchy(node))",
      "if ((nodeTag === 'ul' || nodeTag === 'ol') && !window.__okouNative && !isComplexHierarchy(node))",
    ],
    [
      "return compareKeys(a.zIndex, b.zIndex);",
      "return compareKeys(a._paintKey,b._paintKey) || (a._paintPhase-b._paintPhase) || (a.domOrder-b.domOrder);",
    ],
    [
      "item.options.objectName = transportVal;",
      `item.options.objectName = transportVal;
      if (item._nativePaint) {
        const page = globalOptions._slideIndex + 1;
        window.__okouNative.paints[page] ||= {};
        window.__okouNative.paints[page]['okou-object-' + i] = item._nativePaint;
      }`,
    ],
    [
      "cNvPr.setAttribute('name', shapeName);",
      "cNvPr.setAttribute('name', 'okou-object-' + zVal);",
    ],
    [
      "collect(root, []);",
      "collect(root, []); window.__okouNative.queue = renderQueue;",
    ],
    ["${intTableNum * slide._slideNum + 1}", "${idx + 2}"],
    [
      "strSlideXml += ' </a:outerShdw>';",
      "strSlideXml += ` </a:${slideItemObj.options.shadow.type}Shdw>`;",
    ],
    [
      "console.warn(`[pptx-normalizer] ${relativePath} has parser errors, skipping.`);\n          continue;",
      "throw new Error(`Invalid native presentation XML: ${relativePath}`);",
    ],
    [
      "else if (opts.hyperlink) {\n          runProps += ' u=\"sng\"';",
      "else if (opts.underline === false) {\n          runProps += ' u=\"none\"';\n      }\n      else if (opts.hyperlink) {\n          runProps += ' u=\"sng\"';",
    ],
  ] as const;
  for (const [before, after] of nativeReplacements) {
    if (result.split(before).length !== 2)
      throw new Error("Unsupported dom-to-pptx native layout adapter");
    result = result.replace(before, after);
  }
  for (const [property, defaultValue] of [
    ["blur", "8"],
    ["offset", "4"],
    ["angle", "270"],
    ["opacity", "0.75"],
  ]) {
    const before = `slideItemObj.options.shadow.${property} || ${defaultValue}`;
    if (result.split(before).length !== 3)
      throw new Error("Unsupported dom-to-pptx shadow serializer");
    result = result.replaceAll(before, before.replace(" || ", " ?? "));
  }
  return result;
}
