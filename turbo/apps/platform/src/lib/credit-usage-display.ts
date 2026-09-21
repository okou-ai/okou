import type { UsageRecordKindBreakdown } from "@okouai/api-contracts/contracts/usage-record";
import { getModelDisplayName } from "@okouai/core/model-display-name";
import { i18n } from "../i18n/index.ts";

interface CreditUsageEntry {
  readonly kind: string;
  readonly provider: string;
  readonly credits: number;
}

interface CreditUsageDisplayRow {
  readonly key: string;
  readonly label: string;
  readonly credits: number;
}

const USAGE_DISPLAY_NAMES = {
  avatar(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.avatar;
    });
  },
  finance(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.finance;
    });
  },
  imageRecognition(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.imageRecognition;
    });
  },
  maps(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.maps;
    });
  },
  peopleSearch(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.peopleSearch;
    });
  },
  seo(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.seo;
    });
  },
  socialSearch(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.socialSearch;
    });
  },
  translation(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.translation;
    });
  },
  weather(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.weather;
    });
  },
  webFetch(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.webFetch;
    });
  },
  webSearch(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.webSearch;
    });
  },
} as const;

const MANAGED_USAGE_KIND_DISPLAY_NAMES: Readonly<Record<string, () => string>> =
  {
    scrape: USAGE_DISPLAY_NAMES.webFetch,
    maps: USAGE_DISPLAY_NAMES.maps,
    "web-search": USAGE_DISPLAY_NAMES.webSearch,
    "people-search": USAGE_DISPLAY_NAMES.peopleSearch,
    seo: USAGE_DISPLAY_NAMES.seo,
    social: USAGE_DISPLAY_NAMES.socialSearch,
    finance: USAGE_DISPLAY_NAMES.finance,
    weather: USAGE_DISPLAY_NAMES.weather,
    "image-recognition": USAGE_DISPLAY_NAMES.imageRecognition,
    translation: USAGE_DISPLAY_NAMES.translation,
  };

const MODEL_DISPLAY_NAMES: Readonly<Record<string, () => string>> = {
  "heygen-avatar-iii": USAGE_DISPLAY_NAMES.avatar,
  "joggai-talking-avatar": USAGE_DISPLAY_NAMES.avatar,
  // Rows recorded before image tasks moved to task-scoped kinds carry
  // kind "model" with this provider; nothing else runs it as a chat model.
  "google/gemini-3.5-flash": USAGE_DISPLAY_NAMES.imageRecognition,
};

function titleCaseUsageToken(token: string): string {
  const upper = token.toUpperCase();
  if (["AI", "API", "GLM", "GPT", "ID", "SQL", "URL"].includes(upper)) {
    return upper;
  }

  return token.charAt(0).toUpperCase() + token.slice(1);
}

function formatUsageDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return i18n.t(($) => {
      return $.usage.displayNames.usage;
    });
  }

  return normalized
    .split(/[/._-]+/)
    .filter((token) => {
      return token.length > 0;
    })
    .map(titleCaseUsageToken)
    .join(" ");
}

function stripUsageProviderPrefix(value: string): string {
  const normalized = value.trim();
  if (normalized.startsWith("fal-ai/")) {
    return normalized.slice("fal-ai/".length);
  }
  if (normalized.startsWith("bytedance/")) {
    return normalized.slice("bytedance/".length);
  }
  if (normalized.startsWith("dreamina-")) {
    return normalized.slice("dreamina-".length);
  }
  return normalized;
}

function usageModelDisplayName(
  model: string,
  preserveUnknownModelId: boolean,
): string {
  const usageDisplayName = MODEL_DISPLAY_NAMES[model];
  if (usageDisplayName) {
    return usageDisplayName();
  }

  const directDisplayName = getModelDisplayName(model);
  if (directDisplayName !== model) {
    return directDisplayName;
  }

  const strippedModel = stripUsageProviderPrefix(model);
  const strippedDisplayName = getModelDisplayName(strippedModel);
  if (strippedDisplayName !== strippedModel) {
    return strippedDisplayName;
  }

  return preserveUnknownModelId
    ? strippedModel
    : formatUsageDisplayName(strippedModel);
}

function usageKindBase(kind: string): string {
  return kind.split("/", 1)[0];
}

/**
 * Managed capabilities are one product surface regardless of which vendor
 * served the request, so their rows merge on the kind alone. The stored
 * provider identity (for example "socialkit" or "monid/instagram") stays
 * untouched; only this presentation layer collapses it.
 */
function managedUsageRowKey(kind: string): string | null {
  const baseKind = usageKindBase(kind);
  return Object.hasOwn(MANAGED_USAGE_KIND_DISPLAY_NAMES, baseKind)
    ? baseKind
    : null;
}

function getCreditUsageDisplayName(kind: string, provider: string): string {
  const baseKind = usageKindBase(kind);
  const managedKindDisplayName = MANAGED_USAGE_KIND_DISPLAY_NAMES[baseKind];
  if (managedKindDisplayName) {
    return managedKindDisplayName();
  }

  if (!provider || provider === "unknown") {
    return formatUsageDisplayName(kind);
  }

  const normalizedProvider = provider.trim();
  if (baseKind === "model" || baseKind === "image" || baseKind === "video") {
    return usageModelDisplayName(normalizedProvider, baseKind === "model");
  }

  return formatUsageDisplayName(normalizedProvider);
}

function parseUsageKind(kind: string): {
  readonly kind: string;
  readonly provider?: string;
} {
  const parts = kind.split("/");
  const parsedKind = parts[0];
  if (
    (parsedKind === "model" ||
      parsedKind === "image" ||
      parsedKind === "video") &&
    parts.length >= 2
  ) {
    const categoryIndex = parts.findIndex((part, index) => {
      return (
        index > 1 && (part.startsWith("tokens.") || part.startsWith("output_"))
      );
    });
    const providerParts =
      categoryIndex > 1 ? parts.slice(1, categoryIndex) : parts.slice(1);
    const provider = providerParts.join("/");
    if (provider) {
      return { kind: parsedKind, provider };
    }
  }

  return { kind };
}

export function buildCreditUsageDisplayRows(
  entries: readonly CreditUsageEntry[],
): readonly CreditUsageDisplayRow[] {
  const rows = new Map<string, CreditUsageDisplayRow>();
  for (const entry of entries) {
    const parsed = parseUsageKind(entry.kind);
    const provider = parsed.provider ?? entry.provider;
    const managedKey = managedUsageRowKey(parsed.kind);
    const key = managedKey ? `kind:${managedKey}` : `${parsed.kind}:${provider}`;
    const existing = rows.get(key);
    rows.set(key, {
      key,
      label: getCreditUsageDisplayName(parsed.kind, provider),
      credits: (existing?.credits ?? 0) + entry.credits,
    });
  }
  return Array.from(rows.values());
}

export function buildCreditUsageDisplaySegments(
  breakdown: readonly UsageRecordKindBreakdown[],
) {
  const segments = new Map<
    UsageRecordKindBreakdown["kind"],
    {
      kind: UsageRecordKindBreakdown["kind"];
      credits: number;
      entries: CreditUsageEntry[];
    }
  >();

  function getSegment(kind: UsageRecordKindBreakdown["kind"]) {
    let segment = segments.get(kind);
    if (!segment) {
      segment = { kind, credits: 0, entries: [] };
      segments.set(kind, segment);
    }
    return segment;
  }

  for (const source of breakdown) {
    const segment = getSegment(source.kind);
    segment.credits += source.credits;
    for (const provider of source.providers) {
      const usageKinds =
        provider.usageKinds.length > 0
          ? provider.usageKinds
          : [{ kind: source.kind, credits: provider.credits }];
      for (const usageKind of usageKinds) {
        const entry = { ...usageKind, provider: provider.provider };
        // Social Search is one managed capability, so every vendor behind it
        // contributes to a single segment instead of splitting across the
        // segment the raw breakdown happens to report.
        const target =
          source.kind === "other" && usageKindBase(usageKind.kind) === "social"
            ? getSegment("connector")
            : segment;
        if (target !== segment) {
          segment.credits -= entry.credits;
          target.credits += entry.credits;
        }
        target.entries.push(entry);
      }
    }
  }

  return Array.from(segments.values())
    .filter((segment) => {
      return segment.credits > 0;
    })
    .map((segment) => {
      return {
        kind: segment.kind,
        credits: segment.credits,
        rows: buildCreditUsageDisplayRows(segment.entries),
      };
    });
}
