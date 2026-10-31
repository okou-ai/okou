import type { OnboardingOutputFormat } from "./onboarding-output-format.ts";

const GENERATION_FORMATS = Object.freeze({
  image: "image",
  illustration: "image",
  presentation: "presentation",
  slides: "presentation",
  website: "website",
  report: "report",
} as const satisfies Record<string, OnboardingOutputFormat>);

/** Match requested deliverables, not incidental mentions of source material. */
const OUTPUT_REQUESTS: readonly {
  readonly format: OnboardingOutputFormat;
  readonly pattern: RegExp;
}[] = [
  {
    format: "presentation",
    pattern:
      /\b(?:create|make|build|generate|prepare|design|produce|deliver|return|present)\b[^.!?\n]{0,100}?\b(?:presentation|slides|slide deck|pitch deck|pptx?)\b|\b(?:as|into)\s+(?:(?:a|an|the)\s+)?(?:presentation|slide deck|pitch deck|pptx?)\b|(?:制作|製作|生成|做|创建|建立)[^。！？\n]{0,30}?(?:演示文稿|简报|簡報|幻灯片|投影片|PPT)/iu,
  },
  {
    format: "image",
    pattern:
      /\b(?:create|make|generate|draw|design|produce|present)\b[^.!?\n]{0,80}?\b(?:image|images|illustration|illustrations|poster|logo|visual|visuals|banner|infographic)\b|\b(?:as|into)\s+(?:(?:a|an|the)\s+)?(?:image|illustration|infographic)\b|(?:生成|画|畫|绘制|繪製|设计|設計|制作|製作)[^。！？\n]{0,30}?(?:图片|圖片|图像|圖像|插画|插畫|海报|海報|配图|配圖|标志|標誌)|生图|生圖/iu,
  },
  {
    format: "website",
    pattern:
      /\b(?:create|make|build|generate|design|launch|present)\b[^.!?\n]{0,80}?\b(?:website|webpage|web page|landing page|microsite|portfolio site)\b|\b(?:as|into)\s+(?:(?:a|an|the)\s+)?(?:website|webpage|web page|landing page)\b|(?:制作|製作|生成|创建|建立|搭建|设计|設計|做)[^。！？\n]{0,30}?(?:网站|網站|网页|網頁|落地页|落地頁)/iu,
  },
  {
    format: "report",
    pattern:
      /\b(?:create|make|generate|write|produce|deliver|return|present)\b[^.!?\n]{0,80}?\breport\b|\b(?:as|into)\s+(?:(?:a|an|the)\s+)?report\b|(?:制作|製作|生成|撰写|撰寫|写|寫|输出|輸出)[^。！？\n]{0,30}?报告|(?:制作|製作|生成|撰寫|寫|輸出)[^。！？\n]{0,30}?報告/iu,
  },
];

/** A one-time default; later user edits and selections own the draft. */
export function defaultOnboardingOutputFormat(
  prompt: string,
): OnboardingOutputFormat {
  const generationType = /^\s*\/gen\s+(\w+)\b/iu
    .exec(prompt)?.[1]
    ?.toLowerCase();
  const generationFormat = Object.entries(GENERATION_FORMATS).find(([type]) => {
    return type === generationType;
  })?.[1];
  if (generationFormat) {
    return generationFormat;
  }

  const requested = OUTPUT_REQUESTS.flatMap(({ format, pattern }) => {
    const match = pattern.exec(prompt);
    return match ? [{ format, end: match.index + match[0].length }] : [];
  }).sort((a, b) => {
    return a.end - b.end;
  })[0];
  if (requested) {
    return requested.format;
  }
  if (
    /\b(?:find|source|identify|shortlist|discover|research|generate|search(?: for)?|look for)\b[^.!?\n]{0,100}?\b(?:people|leads|prospects|creators|influencers|partners|candidates|contacts|founders|investors|businesses)\b|\b(?:lead generation|people search)\b|(?:找|寻找|尋找|搜寻|搜尋|筛选|篩選)[^。！？\n]{0,30}?(?:客户|客戶|达人|達人|创作者|創作者|候选人|候選人|联系人|聯絡人|合作伙伴|合作夥伴|投资人|投資人)/iu.test(
      prompt,
    )
  ) {
    return "people";
  }
  if (
    /\b(?:research|investigate|compare|market research|literature review)\b|调研|調研|研究|调查|調查|比较|比較/iu.test(
      prompt,
    )
  ) {
    return "research";
  }
  // A general business task starts with a report; the visitor can change it.
  return "report";
}
