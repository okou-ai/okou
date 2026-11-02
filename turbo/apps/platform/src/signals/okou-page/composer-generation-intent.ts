export type ComposerGenerationIntent =
  "presentation" | "image" | "document" | "report";

const ALIASES = [
  [
    "presentation",
    /\b(?:presentations?|slides?|decks?|pptx?)\b|演示文稿|幻灯片|演示/u,
  ],
  ["image", /\b(?:images?|illustrations?)\b|图片|插画|配图|海报/u],
  ["document", /\b(?:docs?|documents?|word|docx)\b|文档/u],
  ["report", /\breports?\b|调研报告|财报|报告/u],
] as const;

const ENGLISH_REQUEST =
  /^(?:(?:please|kindly)[,\s]+)?(?:(?:can|could|would|will)\s+you\s+|i(?:['’]d|\s+would)\s+like\s+(?:you\s+)?to\s+|i\s+(?:want|need)\s+(?:you\s+)?to\s+)?(?:please\s+)?(?:help\s+me\s+(?:to\s+)?)?(?:create|generate|make|design|draw|write|draft|produce|prepare|build)\b\s+(?:me\s+)?/u;
const CHINESE_REQUEST =
  /^(?:请|麻烦)?你?(?:(?:能不能|能否|可以|能)你?)?(?:我(?:想要?|需要|要)你?(?:帮我)?|(?:帮|给)(?:我|我们)|帮忙)?(?:生成|制作|创建|创作|做|画|绘制|设计|写|撰写|起草)(?:出|成)?\s*/u;

// English topics/formats follow the output. Chinese topics can precede it
// ("关于图片的报告"), so only stop at a Chinese qualifier after an output noun.
const ENGLISH_TOPIC =
  /\b(?:about|on|of|for|in|as|with|from|using|to|that|which|without|regarding|based|covering|showing|depicting|called|named|titled)\b|[;；.!?。！？\n]/u;
const CHINESE_TOPIC =
  /^\s*[,，:：]?\s*(?:关于|有关|介绍|讲述|讲解|主题|内容|用于|用来|描绘|描述|(?:并)?(?:格式为|格式是|保存为|导出为))/u;
const OUTPUT_END =
  /^\s*(?:$|[,，、+&/]|\b(?:and|or|plus|then|also|please)\b|以及|并且|并|和|与|及)/u;
const NEGATED_OUTPUT =
  /\b(?:no|not|never|don't|don’t|avoid)\b|不要|别(?=生成|制作|创建|画|写)|不用|无需|不必|不需要|禁止|避免/u;
const REQUEST_SEPARATOR =
  /[;；.!?。！？\n]|\b(?:and|then|also)\b|以及|并且|并/u;

function maskReferences(text: string): string {
  // Preserve a placeholder rather than joining words around removed content.
  return text
    .replace(
      /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*(?:`|$)/gu,
      "\u0000",
    )
    .replace(
      /"[^"]*(?:"|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)/gu,
      "\u0000",
    )
    .replace(/(?<![\p{L}\p{N}_])'[^'\n]*(?:'|$)/gu, "\u0000")
    .replace(/^(?:[ \t]*>.*|(?: {4}|\t).*)$/gmu, "\u0000")
    .replace(
      /(?:https?:\/\/|www\.)\S+|\S*[/\\]\S+|\b[\w.-]+\.[a-z\d]{1,10}\b/gu,
      "\u0000",
    );
}

function aliasIntent(text: string): ComposerGenerationIntent | null {
  for (const [intent, pattern] of ALIASES) {
    if (pattern.exec(text)?.[0] === text) {
      return intent;
    }
  }
  return null;
}

function requestOutput(text: string): string | null {
  const prefix = ENGLISH_REQUEST.exec(text) ?? CHINESE_REQUEST.exec(text);
  return prefix ? text.slice(prefix[0].length) : null;
}

function outputIntent(text: string): ComposerGenerationIntent | null {
  const output = text.split(ENGLISH_TOPIC, 1)[0] ?? "";
  if (
    /\b(?:(?:docker|container|disk)\s+images?|bug\s+reports?)\b/u.test(
      output,
    ) ||
    NEGATED_OUTPUT.test(output)
  ) {
    return null;
  }

  const outputAlias = new RegExp(
    ALIASES.map(([, pattern]) => {
      return pattern.source;
    }).join("|"),
    "gu",
  );
  let intent: ComposerGenerationIntent | null = null;
  for (const match of output.matchAll(outputAlias)) {
    const suffix = output.slice(match.index + match[0].length);
    const hasTopic = CHINESE_TOPIC.test(suffix);
    // An alias must be the output noun, not "image recognition code" or
    // "document analysis". Coordinated output nouns are checked separately.
    if (!hasTopic && !OUTPUT_END.test(suffix)) {
      continue;
    }
    const candidate = aliasIntent(match[0]);
    if (intent && candidate !== intent) {
      return null;
    }
    intent = candidate;
    if (hasTopic) {
      break;
    }
  }
  return intent;
}

/** Conservative aliases/explicit generation requests, not a semantic classifier. */
export function detectComposerGenerationIntent(
  text: string,
): ComposerGenerationIntent | null {
  const source = maskReferences(text.normalize("NFKC").toLowerCase()).trim();
  const standalone = aliasIntent(source.replace(/[.!?。！？]+$/u, "").trim());
  if (standalone) {
    return standalone;
  }

  const output = requestOutput(source);
  if (output === null) {
    return null;
  }
  const intent = outputIntent(output);
  if (!intent) {
    return null;
  }

  // A second explicit request can follow a topic: "slides about AI and
  // generate an image". Bare aliases inside that topic are not new outputs.
  for (const clause of source.split(REQUEST_SEPARATOR)) {
    const additionalOutput = requestOutput(clause.trim());
    if (
      additionalOutput !== null &&
      outputIntent(additionalOutput) !== intent
    ) {
      return null;
    }
  }
  return intent;
}
