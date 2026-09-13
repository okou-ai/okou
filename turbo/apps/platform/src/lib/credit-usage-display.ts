import { getModelDisplayName } from "@okouai/core/model-display-name";
import { i18n } from "../i18n/index.ts";

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

export function getCreditUsageDisplayName(
  kind: string,
  provider: string,
): string {
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
