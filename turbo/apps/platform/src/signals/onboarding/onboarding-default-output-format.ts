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
      /\b(?:create|make|build|generate|prepare|design|produce|deliver|return|present)\b[^.!?;,\n]{0,100}?\b(?:presentation|slides|slide deck|pitch deck|pptx?)\b|\b(?:as|into)\s+[^.!?;,\n]{0,60}?\b(?:presentation|slides|slide deck|pitch deck|pptx?)\b|(?:制作|製作|生成|做|创建|建立|整理|转换|轉換|转成|轉成|输出|輸出)[^。！？；，\n]{0,30}?(?:演示文稿|简报|簡報|幻灯片|投影片|PPT)/giu,
  },
  {
    format: "image",
    pattern:
      /\b(?:create|make|generate|draw|design|produce|present)\b[^.!?;,\n]{0,80}?\b(?:image|images|illustration|illustrations|poster|logo|visual|visuals|banner|infographic)\b|\b(?:as|into)\s+[^.!?;,\n]{0,60}?\b(?:image|illustration|infographic)\b|(?:生成|画|畫|绘制|繪製|设计|設計|制作|製作|转换|轉換|转成|轉成)[^。！？；，\n]{0,30}?(?:图片|圖片|图像|圖像|插画|插畫|海报|海報|配图|配圖|标志|標誌)|生图|生圖/giu,
  },
  {
    format: "website",
    pattern:
      /\b(?:create|make|build|generate|design|launch|present)\b[^.!?;,\n]{0,80}?\b(?:website|webpage|web page|landing page|microsite|portfolio site)\b|\b(?:as|into)\s+[^.!?;,\n]{0,60}?\b(?:website|webpage|web page|landing page)\b|(?:制作|製作|生成|创建|建立|搭建|设计|設計|做|整理|转换|轉換|转成|轉成)[^。！？；，\n]{0,30}?(?:网站|網站|网页|網頁|落地页|落地頁)/giu,
  },
  {
    format: "report",
    pattern:
      /\b(?:create|make|generate|write|produce|deliver|return|present)\b[^.!?;,\n]{0,80}?\breport\b|\b(?:as|into)\s+[^.!?;,\n]{0,60}?\breport\b|(?:制作|製作|生成|撰写|撰寫|写|寫|输出|輸出|整理|转换|轉換|转成|轉成)[^。！？；，\n]{0,30}?(?:报告|報告)/giu,
  },
];

const PEOPLE_REQUEST =
  /\b(?:find|source|identify|shortlist|discover|research|generate|search(?: for)?|look for)\b[^.!?;,\n]{0,100}?\b(?:people|leads|prospects|creators|influencers|partners|candidates|contacts|founders|investors|businesses|designers)\b|\b(?:lead generation|people search)\b|(?:找|寻找|尋找|搜寻|搜尋|筛选|篩選)[^。！？；，\n]{0,30}?(?:客户|客戶|达人|達人|创作者|創作者|候选人|候選人|联系人|聯絡人|合作伙伴|合作夥伴|投资人|投資人|设计师|設計師|人)/giu;

/** Negation owns its clause, not a later affirmative request. */
function isNegatedRequest(prompt: string, start: number): boolean {
  const clause = prompt
    .slice(0, start)
    .split(/[.!?;,\n。！？；，]|\b(?:but|instead|then|and)\b|而是|改为|改為/iu)
    .at(-1);
  return /\b(?:don['’]t|do not|never|not to|no need to|avoid)\b|不要|别|別|无需|無需|不用|不必/iu.test(
    clause ?? "",
  );
}

/** These explicit response contracts have no equivalent in our format choices. */
function hasExactResponseFormat(prompt: string): boolean {
  const constraints = [
    /\b(?:reply|respond|answer|return|output)\b[^.!?;\n]{0,40}\b(?:only|just|exactly|strictly)\s+(?:(?:a|an|the|one|single)\s+){0,2}(?:numbers?|digits?|word|sentence|answer|result|code|json|csv|xml)\b/giu,
    /\b(?:only|just)\s+(?:reply|respond|answer|return|output)\s+(?:(?:with|in|as|a|an|the|one|single)\s+)*(?:numbers?|digits?|word|sentence|answer|result|code|json|csv|xml)\b/giu,
    /\b(?:reply|respond|return|output)\s+(?:(?:with|in|as|valid|raw)\s+)*(?:json|csv|xml)\b/giu,
    /(?:只|仅|僅)(?:需|要)?(?:回复|回覆|回答|输出|輸出|返回)[^。！？；\n]{0,20}?(?:数字|數字|答案|结果|結果|代码|代碼|一句话|一句話|一个词|一個詞|JSON|CSV|XML)/giu,
  ];
  return constraints.some((pattern) => {
    return [...prompt.matchAll(pattern)].some((match) => {
      return !isNegatedRequest(prompt, match.index);
    });
  });
}

/** A one-time default; later user edits and selections own the draft. */
export function defaultOnboardingOutputFormat(
  prompt: string,
): OnboardingOutputFormat | null {
  if (hasExactResponseFormat(prompt)) {
    return null;
  }
  const generationType = /^\s*\/gen\s+(\w+)\b/iu
    .exec(prompt)?.[1]
    ?.toLowerCase();
  const generationFormat = Object.entries(GENERATION_FORMATS).find(([type]) => {
    return type === generationType;
  })?.[1];
  if (generationFormat) {
    return generationFormat;
  }

  const people = [...prompt.matchAll(PEOPLE_REQUEST)].find((match) => {
    return !isNegatedRequest(prompt, match.index);
  });
  const requests = OUTPUT_REQUESTS.flatMap(({ format, pattern }) => {
    return [...prompt.matchAll(pattern)].map((match) => {
      return {
        format,
        start: match.index,
        end: match.index + match[0].length,
        negated: isNegatedRequest(prompt, match.index),
      };
    });
  });
  const requested = requests
    .filter(({ start, end, negated }) => {
      if (negated) {
        return false;
      }
      if (people && start >= people.index) {
        const peopleEnd = people.index + people[0].length;
        // "Find people who can design a website" asks for people; the website
        // describes their skills. A separate output request still takes priority.
        const qualification = prompt.slice(peopleEnd, start);
        if (
          end <= peopleEnd ||
          /^(?:\s+(?:who|that|to)\b|\s*(?:能|会|會|可以|帮|幫))[^.!?;,\n。！？；，]*$/iu.test(
            qualification,
          )
        ) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      return a.end - b.end;
    })[0];
  if (requested) {
    return requested.format;
  }
  if (people) {
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
  return requests.some(({ format, negated }) => {
    return format === "report" && negated;
  })
    ? null
    : "report";
}
