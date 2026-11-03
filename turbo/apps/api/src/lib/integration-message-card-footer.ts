import type {
  TeamsAdaptiveCard,
  TeamsMentionEntity,
} from "../signals/external/teams-bot-client";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve both supported Feishu card schemas and all caller-owned fields. */
export function appendFeishuCardFooter(
  card: Readonly<Record<string, unknown>>,
  footerText: string | undefined,
) {
  // Published templates own their fields; extra elements are not template inputs.
  if (!footerText || card.type === "template") {
    return card;
  }
  const footer = [
    { tag: "hr" },
    { tag: "markdown", content: footerText, text_size: "notation" },
  ];
  if (card.schema === "2.0") {
    const body = isRecord(card.body) ? card.body : {};
    const elements: readonly unknown[] = Array.isArray(body.elements)
      ? body.elements
      : [];
    return { ...card, body: { ...body, elements: [...elements, ...footer] } };
  }
  const elements: readonly unknown[] = Array.isArray(card.elements)
    ? card.elements
    : [];
  return {
    ...card,
    elements: [
      ...elements,
      { tag: "hr" },
      {
        tag: "note",
        elements: [{ tag: "lark_md", content: footerText }],
      },
    ],
  };
}

export function appendTeamsCardFooter(
  card: TeamsAdaptiveCard & Readonly<Record<string, unknown>>,
  presentation: {
    readonly footerText: string | undefined;
    readonly entities: readonly TeamsMentionEntity[];
  },
) {
  if (!presentation.footerText) {
    return card;
  }
  const msteams = isRecord(card.msteams) ? card.msteams : {};
  const entities: readonly unknown[] = Array.isArray(msteams.entities)
    ? msteams.entities
    : [];
  return {
    ...card,
    body: [
      ...(card.body ?? []),
      {
        type: "TextBlock",
        text: presentation.footerText,
        size: "Small",
        isSubtle: true,
        wrap: true,
        separator: true,
      },
    ],
    msteams: { ...msteams, entities: [...entities, ...presentation.entities] },
  };
}
