export type ComposerGenerationIntent =
  "website" | "image" | "presentation" | "document";

const ALIASES = [
  [
    "website",
    /\b(?:websites?|web\s*pages?|landing\s+pages?)\b|网站|網站|网页|網頁|落地页|落地頁|着陆页|著陸頁/u,
  ],
  [
    "image",
    /\b(?:images?|illustrations?)\b|图片|圖片|图像|圖像|插画|插畫|配图|配圖|海报|海報/u,
  ],
  [
    "presentation",
    /\b(?:presentations?|slides?|decks?|pptx?)\b|演示文稿|幻灯片|幻燈片|演示|简报|簡報/u,
  ],
  ["document", /\b(?:docs?|documents?|word|docx)\b|文档|文檔/u],
] as const;

/** Keywords offer templates; they do not classify or apply a generation task. */
export function detectComposerGenerationIntents(
  text: string,
): readonly ComposerGenerationIntent[] {
  const source = text.normalize("NFKC").toLowerCase();
  return ALIASES.flatMap(([intent, pattern]) => {
    const match = pattern.exec(source);
    return match ? [{ intent, index: match.index }] : [];
  })
    .sort((left, right) => {
      return left.index - right.index;
    })
    .map(({ intent }) => {
      return intent;
    });
}
