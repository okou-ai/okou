import type { TFunction } from "i18next";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  INDUSTRY_RECOMMENDED_SOURCES,
  SOURCE_FAMILIES,
  type IndustryId,
  type SourceFamily,
} from "./onboarding-sources-first-data.ts";

/**
 * Starting-prompt match, ported from the onboarding design prototype: an exact
 * industry/source pair wins, then the source family for that industry, then a
 * family-shaped fallback, then a generic one. No account content is read.
 */

const EXACT_PROMPT_KEYS = [
  "finance_quickbooks",
  "finance_xero",
  "marketing_google_ads",
  "marketing_google_analytics",
  "marketing_google_search_console",
  "marketing_meta_ads",
  "marketing_tiktok_ads",
  "marketing_youtube",
  "sales_google_contacts",
  "sales_hubspot",
  "software_github",
  "software_linear",
] as const;
type ExactPromptKey = (typeof EXACT_PROMPT_KEYS)[number];

const FAMILY_PROMPT_KEYS = [
  "coaching_calendar",
  "coaching_documents",
  "coaching_email",
  "coaching_sheets",
  "consulting_documents",
  "consulting_email",
  "consulting_sheets",
  "design_documents",
  "design_email",
  "design_sheets",
  "finance_documents",
  "finance_email",
  "finance_sheets",
  "investing_documents",
  "investing_email",
  "investing_sheets",
  "marketing_documents",
  "marketing_email",
  "marketing_sheets",
  "operations_calendar",
  "operations_documents",
  "operations_email",
  "operations_sheets",
  "other_documents",
  "other_email",
  "other_sheets",
  "research_documents",
  "research_email",
  "research_sheets",
  "sales_calendar",
  "sales_documents",
  "sales_email",
  "sales_sheets",
  "software_documents",
  "software_email",
  "software_sheets",
] as const;
type FamilyPromptKey = (typeof FAMILY_PROMPT_KEYS)[number];

function resourceKey(value: string): string {
  return value.replaceAll("-", "_");
}

function exactPromptKey(
  industry: IndustryId,
  slug: ConnectorSlug,
): ExactPromptKey | null {
  const candidate = `${industry}_${resourceKey(slug)}`;
  return (
    EXACT_PROMPT_KEYS.find((key) => {
      return key === candidate;
    }) ?? null
  );
}

function familyPromptKey(
  industry: IndustryId,
  family: SourceFamily,
): FamilyPromptKey | null {
  const candidate = `${industry}_${family}`;
  return (
    FAMILY_PROMPT_KEYS.find((key) => {
      return key === candidate;
    }) ?? null
  );
}

function sourceFamilyOf(slug: ConnectorSlug): SourceFamily | null {
  for (const [family, slugs] of Object.entries(SOURCE_FAMILIES)) {
    if ((slugs as readonly string[]).includes(slug)) {
      return family as SourceFamily;
    }
  }
  return null;
}

/**
 * The prototype's source order: an industry recommendation first, then a source
 * with exact copy, then one that matches a family, then anything connected.
 */
export function pickStartingPromptSource(
  industry: IndustryId,
  connectedSlugs: readonly ConnectorSlug[],
): ConnectorSlug | null {
  const recommended = INDUSTRY_RECOMMENDED_SOURCES[industry].find((slug) => {
    return connectedSlugs.includes(slug);
  });
  if (recommended) {
    return recommended;
  }
  const exact = connectedSlugs.find((slug) => {
    return exactPromptKey(industry, slug) !== null;
  });
  if (exact) {
    return exact;
  }
  const family = connectedSlugs.find((slug) => {
    const candidate = sourceFamilyOf(slug);
    return candidate !== null && familyPromptKey(industry, candidate) !== null;
  });
  return family ?? connectedSlugs[0] ?? null;
}

interface StartingPrompt {
  /** Editable first request shown in the welcome dialog. */
  readonly text: string;
  /** The question Okou asks back once the prompt is sent. */
  readonly question: string;
  /** Outcome headline above the prompt. */
  readonly outcome: string;
}

export function startingPromptFor(
  t: TFunction<"common">,
  industry: IndustryId,
  source: { readonly slug: ConnectorSlug; readonly name: string } | null,
): StartingPrompt {
  const short = t(($) => {
    return $.onboarding.sourcesFirst.startingPrompt.profile[industry].short;
  });

  if (!source) {
    return {
      text: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.profile[industry]
          .firstTaskPrompt;
      }),
      question: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.fallback.noSource
          .question;
      }),
      outcome: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.profile[industry]
          .firstTaskTitle;
      }),
    };
  }

  const exactKey = exactPromptKey(industry, source.slug);
  if (exactKey) {
    return {
      text: t(
        ($) => {
          return $.onboarding.sourcesFirst.startingPrompt.exact[exactKey].text;
        },
        { source: source.name },
      ),
      question: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.exact[exactKey]
          .question;
      }),
      outcome: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.exact[exactKey].outcome;
      }),
    };
  }

  const family = sourceFamilyOf(source.slug);
  const familyKey = family ? familyPromptKey(industry, family) : null;
  if (familyKey) {
    return {
      text: t(
        ($) => {
          return $.onboarding.sourcesFirst.startingPrompt.family[familyKey]
            .text;
        },
        { source: source.name },
      ),
      question: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.family[familyKey]
          .question;
      }),
      outcome: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.family[familyKey]
          .outcome;
      }),
    };
  }

  if (family === "projects" || family === "calendar") {
    return {
      text: t(
        ($) => {
          return $.onboarding.sourcesFirst.startingPrompt.fallback[family].text;
        },
        { source: source.name, short },
      ),
      question: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.fallback[family]
          .question;
      }),
      outcome: t(($) => {
        return $.onboarding.sourcesFirst.startingPrompt.fallback[family]
          .outcome;
      }),
    };
  }

  return {
    text: t(
      ($) => {
        return $.onboarding.sourcesFirst.startingPrompt.fallback.generic.text;
      },
      { source: source.name, short },
    ),
    question: t(($) => {
      return $.onboarding.sourcesFirst.startingPrompt.fallback.generic.question;
    }),
    outcome: t(
      ($) => {
        return $.onboarding.sourcesFirst.startingPrompt.fallback.generic
          .outcome;
      },
      { source: source.name },
    ),
  };
}
