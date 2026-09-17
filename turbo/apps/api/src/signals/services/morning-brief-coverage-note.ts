/**
 * The coverage statement the rendered brief is required to carry.
 *
 * The request already tells the model that its input was bounded, but nothing
 * forced that fact into the published Markdown. A reader who receives a brief
 * built from a truncated Slack read and a request that had to drop candidates
 * sees an ordinary morning summary, and the only places the reduction was
 * recorded are HTTP metadata and the prompt — neither of which they ever see.
 * A brief that quietly omits half a day reads exactly like a quiet day.
 *
 * So the note is written here, by the program, from the same numbers the
 * request was built from. The model never produces it, never edits it and
 * cannot suppress it, which is also why there is no second model call: the
 * wording is a fixed translation table, not generated prose.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

/** What the pipeline knows about how complete this brief's input was. */
export interface MorningBriefCoverageFacts {
  /** The collector's own verdict on the read it performed. */
  readonly collected: "complete" | "partial" | "empty";
  /** Candidates dropped so the request would fit its ceiling. */
  readonly omittedForSize: number;
}

interface CoverageWording {
  /** The collector could not read everything in scope. */
  readonly bounded: string;
  /** Candidates were dropped to fit the request. Takes the count. */
  readonly omitted: (count: number) => string;
  /** Joins the two clauses when both apply. */
  readonly separator: string;
  /** Prefix that marks the line as the pipeline's own statement. */
  readonly label: string;
}

/**
 * One fixed translation per supported output language.
 *
 * These cover the ten Settings locales plus the two Chinese scripts the Agent
 * language contract adds. They are deliberately short and factual: this line
 * describes the pipeline's own limits, so it must not read as part of the
 * summary the model wrote.
 */
const WORDINGS: Readonly<Record<string, CoverageWording>> = {
  "en-US": {
    label: "Coverage",
    bounded: "some messages in scope were not read",
    omitted: (count) => {
      return count === 1
        ? "1 item did not fit this summary"
        : `${count.toString()} items did not fit this summary`;
    },
    separator: "; ",
  },
  "pt-BR": {
    label: "Cobertura",
    bounded: "algumas mensagens do período não foram lidas",
    omitted: (count) => {
      return count === 1
        ? "1 item não coube neste resumo"
        : `${count.toString()} itens não couberam neste resumo`;
    },
    separator: "; ",
  },
  "ja-JP": {
    label: "カバレッジ",
    bounded: "対象の一部のメッセージは読み取れませんでした",
    omitted: (count) => {
      return `${count.toString()} 件はこの要約に収まりませんでした`;
    },
    separator: "、",
  },
  "ko-KR": {
    label: "커버리지",
    bounded: "범위 내 일부 메시지를 읽지 못했습니다",
    omitted: (count) => {
      return `${count.toString()}개 항목이 이 요약에 포함되지 못했습니다`;
    },
    separator: "; ",
  },
  "id-ID": {
    label: "Cakupan",
    bounded: "sebagian pesan dalam cakupan tidak terbaca",
    omitted: (count) => {
      return `${count.toString()} item tidak muat dalam ringkasan ini`;
    },
    separator: "; ",
  },
  "de-DE": {
    label: "Abdeckung",
    bounded: "einige Nachrichten im Zeitraum wurden nicht gelesen",
    omitted: (count) => {
      return count === 1
        ? "1 Eintrag passte nicht in diese Zusammenfassung"
        : `${count.toString()} Einträge passten nicht in diese Zusammenfassung`;
    },
    separator: "; ",
  },
  "es-ES": {
    label: "Cobertura",
    bounded: "algunos mensajes del periodo no se leyeron",
    omitted: (count) => {
      return count === 1
        ? "1 elemento no cupo en este resumen"
        : `${count.toString()} elementos no cupieron en este resumen`;
    },
    separator: "; ",
  },
  "it-IT": {
    label: "Copertura",
    bounded: "alcuni messaggi del periodo non sono stati letti",
    omitted: (count) => {
      return count === 1
        ? "1 elemento non è rientrato in questo riepilogo"
        : `${count.toString()} elementi non sono rientrati in questo riepilogo`;
    },
    separator: "; ",
  },
  "fr-FR": {
    label: "Couverture",
    bounded: "certains messages de la période n'ont pas été lus",
    omitted: (count) => {
      return count === 1
        ? "1 élément n'a pas tenu dans ce résumé"
        : `${count.toString()} éléments n'ont pas tenu dans ce résumé`;
    },
    separator: "; ",
  },
  "hi-IN": {
    label: "कवरेज",
    bounded: "अवधि के कुछ संदेश पढ़े नहीं जा सके",
    omitted: (count) => {
      return `${count.toString()} आइटम इस सारांश में नहीं आ सके`;
    },
    separator: "; ",
  },
  "zh-Hans": {
    label: "覆盖范围",
    bounded: "范围内部分消息未能读取",
    omitted: (count) => {
      return `${count.toString()} 条内容未能放入本摘要`;
    },
    separator: "；",
  },
  "zh-Hant": {
    label: "涵蓋範圍",
    bounded: "範圍內部分訊息未能讀取",
    omitted: (count) => {
      return `${count.toString()} 則內容未能納入本摘要`;
    },
    separator: "；",
  },
};

const DEFAULT_WORDING = WORDINGS["en-US"] as CoverageWording;

/**
 * Pick the wording for the language this brief was frozen to.
 *
 * An exact tag wins. Otherwise the base subtag matches the first supported
 * variant, so `de-AT` reads German rather than English. A language with no
 * translation falls back to the declared default: an English coverage line on a
 * non-English brief is worse than nothing only if you think the note is
 * decoration, and it is not — it is the disclosure that the brief is partial.
 */
function wordingFor(language: string): CoverageWording {
  const exact = WORDINGS[language];
  if (exact) {
    return exact;
  }
  const base = language.split("-")[0]?.toLowerCase() ?? "";
  for (const [tag, wording] of Object.entries(WORDINGS)) {
    if (tag.split("-")[0]?.toLowerCase() === base) {
      return wording;
    }
  }
  return DEFAULT_WORDING;
}

/**
 * The note this brief must carry, or null when it has nothing to disclose.
 *
 * A complete read that dropped nothing needs no line, and adding one anyway
 * would train readers to ignore it. `empty` never reaches here: an empty
 * collection produces no brief at all.
 */
export function morningBriefCoverageNote(
  facts: MorningBriefCoverageFacts,
  language: string,
): string | null {
  const omitted = Math.max(0, Math.trunc(facts.omittedForSize));
  const bounded = facts.collected !== "complete";
  if (!bounded && omitted === 0) {
    return null;
  }
  const wording = wordingFor(language);
  const clauses: string[] = [];
  if (bounded) {
    clauses.push(wording.bounded);
  }
  if (omitted > 0) {
    clauses.push(wording.omitted(omitted));
  }
  return `${wording.label}: ${clauses.join(wording.separator)}.`;
}
