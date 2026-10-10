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
      `      if (result) {
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
  return result;
}
