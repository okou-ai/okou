import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import type { WorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import { surfaceVariants, Button } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { agentChatComposerSignals$ } from "../../signals/okou-page/agent-composer-signals.ts";
import {
  startCardKinds$,
  startCardWorkflowConnectorIcons$,
  startCardWorkflowTemplate$,
  type StartCardConnectorIcon,
  type StartCardKind,
} from "../../signals/okou-page/start-cards.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { localizedWorkflowTemplate } from "./workflow-template-copy.ts";

// Every kind draws into the same square slot so the row reads as one family.
// The card is only ~292px wide, so the tile stays small enough to leave the
// title on one line and the description on two.
const THUMBNAIL_CLASS =
  "grid size-[72px] shrink-0 place-items-center overflow-hidden rounded-xl";

const NODE_CLASS = "rounded-md border bg-card";

// The only illustrated palette the product already owns is the agent avatar's:
// five hair colours over one skin tone. Taking the tiles from there keeps the
// row in the same family as the face at the top of the page, and each colour is
// laid down at a fraction of its strength so the tiles stay quiet.
function kindAccent(kind: StartCardKind): string {
  switch (kind) {
    case "slides": {
      return "#E88033";
    }
    case "website": {
      return "#3EB7B8";
    }
    case "illustration": {
      return "#EDC43E";
    }
    case "video": {
      return "#FF81B2";
    }
    case "avatar": {
      return "#C77242";
    }
    case "workflow": {
      return "#97918A";
    }
  }
}

// One colour per kind, laid down at five strengths: the tile wash, the bands
// filled inside a drawing, the rules and edges, the muted marks, and the solid
// shapes. Nothing inside a tile is grey — a neutral border reads as a different
// material from the wash it sits on, so every edge is the same colour a few
// steps darker.
//
// The wash is the largest area of colour on the page — three 72px squares in a
// row — so it is the one strength that carries no drawing and is laid down
// lighter than the bands inside the art, which have white paper under them.
const TILE_ALPHA = "1A";
const BAND_ALPHA = "24";
const LINE_ALPHA = "59";
const SOFT_ALPHA = "40";
const FILL_ALPHA = "8C";

/** A resolved connector mark, or `undefined` while the catalog is loading. */
type WorkflowArtIcon = StartCardConnectorIcon | undefined;

function SlidesArt({ accent }: { accent: string }) {
  const edge = { borderColor: `${accent}${LINE_ALPHA}` };
  return (
    <div className="relative h-[31px] w-[42px]">
      <span
        className={`absolute inset-0 -translate-x-[3px] translate-y-[2px] -rotate-6 ${NODE_CLASS}`}
        style={edge}
      />
      <span
        className={`absolute inset-0 translate-x-[3px] translate-y-px rotate-6 ${NODE_CLASS}`}
        style={edge}
      />
      <span className={`absolute inset-0 ${NODE_CLASS}`} style={edge}>
        <span
          className="absolute left-[11px] top-[11px] h-[3px] w-5 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span
          className="absolute left-[11px] top-[17px] h-[3px] w-5 rounded-full"
          style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
        />
      </span>
    </div>
  );
}

function WebsiteArt({ accent }: { accent: string }) {
  return (
    <div
      className="h-[34px] w-[44px] overflow-hidden rounded-md border bg-card"
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      {/* A browser chrome bar reads as a page far more clearly than a coloured
          block does, and the traffic lights give the tile its detail. */}
      <div
        className="flex h-[10px] items-center gap-[2px] border-b px-[3px]"
        style={{
          borderColor: `${accent}${LINE_ALPHA}`,
          backgroundColor: `${accent}${BAND_ALPHA}`,
        }}
      >
        <span
          className="size-[2px] rounded-full"
          style={{ backgroundColor: `${accent}${LINE_ALPHA}` }}
        />
        <span
          className="size-[2px] rounded-full"
          style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
        />
        <span
          className="size-[2px] rounded-full"
          style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
        />
      </div>
      <div className="flex gap-[3px] p-[4px]">
        <span
          className="size-[10px] shrink-0 rounded-[2px]"
          style={{ backgroundColor: `${accent}${FILL_ALPHA}` }}
        />
        <span className="mt-[1px] flex flex-1 flex-col gap-[2px]">
          <span
            className="h-[2px] rounded-full"
            style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
          />
          <span
            className="h-[2px] w-3/5 rounded-full"
            style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
          />
        </span>
      </div>
    </div>
  );
}

function IllustrationArt({ accent }: { accent: string }) {
  return (
    <div
      className="h-[37px] w-[44px] rounded-md border bg-card p-1"
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      <div
        className="size-[7px] rounded-full"
        style={{ backgroundColor: accent }}
      />
      <div
        className="mt-[3px] h-[19px] rounded-sm"
        style={{
          backgroundColor: `${accent}${FILL_ALPHA}`,
          clipPath:
            "polygon(0 100%, 0 60%, 27% 26%, 49% 58%, 69% 18%, 100% 62%, 100% 100%)",
        }}
      />
    </div>
  );
}

function VideoArt({ accent }: { accent: string }) {
  return (
    <div
      className="grid h-[30px] w-[42px] place-items-center rounded-md border bg-card"
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      <span
        className="grid size-4 place-items-center rounded-full"
        style={{ backgroundColor: `${accent}${SOFT_ALPHA}`, color: accent }}
      >
        <Play size={7} fill="currentColor" />
      </span>
    </div>
  );
}

function AvatarArt({ accent }: { accent: string }) {
  return (
    // A round portrait chip beside a small waveform: the bust alone is the
    // account glyph every product has, and it is the speaking that makes this
    // an avatar video.
    <div className="flex items-center gap-[5px]">
      <span
        className="relative size-[32px] shrink-0 overflow-hidden rounded-full border bg-card"
        style={{ borderColor: `${accent}${LINE_ALPHA}` }}
      >
        <span
          className="absolute left-1/2 top-[7px] size-[10px] -translate-x-1/2 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span
          className="absolute bottom-0 left-1/2 h-[13px] w-[21px] -translate-x-1/2 rounded-t-full"
          style={{ backgroundColor: `${accent}${FILL_ALPHA}` }}
        />
      </span>
      <span className="flex items-center gap-[2px]">
        <span
          className="h-[7px] w-[2px] rounded-full"
          style={{ backgroundColor: `${accent}${FILL_ALPHA}` }}
        />
        <span
          className="h-[13px] w-[2px] rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span
          className="h-[9px] w-[2px] rounded-full"
          style={{ backgroundColor: `${accent}${FILL_ALPHA}` }}
        />
      </span>
    </div>
  );
}

function WorkflowNode({
  icon,
  accent,
}: {
  icon: WorkflowArtIcon;
  accent: string;
}) {
  return (
    <span
      className={`grid h-[17px] w-[22px] place-items-center ${NODE_CLASS}`}
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      <ConnectorIcon icon={icon?.icon} size={10} />
    </span>
  );
}

/**
 * Flow diagram for the workflow card: the template's first connector is the
 * trigger, the rest are the tools the workflow writes to. Only this card needs
 * connector marks, so the lookups start when it is actually drawn.
 */
function WorkflowArt({ accent }: { accent: string }) {
  const resolved = useLastResolved(startCardWorkflowConnectorIcons$);
  // Hold the diagram shape while the marks are still loading.
  const icons: readonly WorkflowArtIcon[] =
    resolved && resolved.length > 0 ? resolved : [undefined, undefined];
  const [trigger, ...steps] = icons;
  return (
    <div className="flex w-[54px] flex-col items-center">
      <div
        className="flex h-[17px] w-full items-center gap-1 rounded-md border bg-card px-1"
        style={{ borderColor: `${accent}${LINE_ALPHA}` }}
      >
        <ConnectorIcon icon={trigger?.icon} size={9} />
        <span
          className="h-[3px] flex-1 rounded-full"
          style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
        />
      </div>
      <span
        className="h-1.5 w-px"
        style={{ backgroundColor: `${accent}${LINE_ALPHA}` }}
      />
      {steps.length > 1 ? (
        <div className="relative flex w-full justify-between">
          <span
            className="absolute left-[11px] right-[11px] top-0 h-px"
            style={{ backgroundColor: `${accent}${LINE_ALPHA}` }}
          />
          {steps.slice(0, 2).map((icon, index) => {
            return (
              <span key={icon?.slug ?? index} className="relative mt-1.5">
                <span
                  className="absolute -top-1.5 left-1/2 h-1.5 w-px"
                  style={{ backgroundColor: `${accent}${LINE_ALPHA}` }}
                />
                <WorkflowNode icon={icon} accent={accent} />
              </span>
            );
          })}
        </div>
      ) : (
        <WorkflowNode icon={steps[0]} accent={accent} />
      )}
    </div>
  );
}

interface StartCardContent {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}

/** Shape of `chat.startCards.kinds` in the common namespace. */
type StartCardCopy = Record<
  Exclude<StartCardKind, "workflow">,
  StartCardContent
>;

function StartCard({
  kind,
  content,
  art,
  onSelectPrompt,
  onOpenTemplates,
}: {
  kind: StartCardKind;
  content: StartCardContent;
  art: ReactNode;
  onSelectPrompt: (prompt: string) => void;
  onOpenTemplates: () => void;
}) {
  const { t } = useTranslation();
  // `justify-center`: every card in the row is stretched to the tallest one, so
  // shorter content has to sit in the middle or its bottom padding reads as
  // deeper than its top.
  //
  // `@container`: the overlay drops its secondary action based on how wide the
  // card actually is, which the viewport alone does not tell us — the same
  // breakpoint yields a 292px card with the sidebar open and a wider one
  // without it.
  return (
    <div
      className={surfaceVariants({
        className: "group @container relative flex flex-col justify-center p-4",
      })}
    >
      {/* Stretched hit area so the whole card opens the template picker, kept as
          a real button so the hover actions stay focusable siblings. */}
      <button
        type="button"
        className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t(($) => {
          return $.chat.startCards.openTemplatesAria;
        })}
        onClick={onOpenTemplates}
      />
      <div className="pointer-events-none flex items-center gap-3">
        <div
          className={THUMBNAIL_CLASS}
          style={{
            backgroundColor: `${kindAccent(kind)}${TILE_ALPHA}`,
          }}
        >
          {art}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {content.title}
          </p>
          {/* The clamp is only a guard: beside the thumbnail a description gets
              a 176px column, and every one of them is written to land inside
              the two lines that fit there. */}
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {content.description}
          </p>
        </div>
      </div>
      {/* An overlay rather than a row in the flow: the actions must not reserve
          height while hidden, and `inset-x-4` keeps them inside the card, which
          the two buttons are otherwise too wide for. The longest description in
          a row reaches the card's bottom edge, so the buttons sit on a scrim
          that fades that text out instead of slicing through a line. Only the
          buttons take clicks — the rest of the overlay, and all of it on a
          touch device where `hover` never resolves, falls through to the card.
          */}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 flex h-14 items-end gap-1 bg-gradient-to-t from-card from-[57%] to-transparent opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-focus-within:[&>button]:pointer-events-auto group-hover:[&>button]:pointer-events-auto">
        {/* Peers that split the card: one starts the run from this card's
            prompt, the other opens the picker. Neither leads, so they take
            equal widths rather than each hugging its own label. */}
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="min-w-0 flex-1 text-xs"
          onClick={() => {
            onSelectPrompt(content.prompt);
          }}
        >
          <span className="truncate">
            {t(($) => {
              return $.chat.startCards.startWithPrompt;
            })}
          </span>
        </Button>
        {/* Dropped once the card is too narrow to hold both — the query reads
            the card's content box, so 15rem sits between the two-up card's
            188px and the three-up card's 260px. The card still opens the
            picker on its own. */}
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="hidden min-w-0 flex-1 text-xs @[15rem]:inline-flex"
          onClick={onOpenTemplates}
        >
          <span className="truncate">
            {t(($) => {
              return $.chat.startCards.templates;
            })}
          </span>
        </Button>
      </div>
    </div>
  );
}

export function StartCards({
  onSelectPrompt,
}: {
  onSelectPrompt: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const kinds = useGet(startCardKinds$);
  const introVideoEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.IntroVideo] === true;
  const workflowTemplate = useGet(startCardWorkflowTemplate$);
  const composerSignals = useGet(agentChatComposerSignals$);
  const setTemplateCategory = useSet(
    composerSignals.template.setTemplatePickerCategory$,
  );
  const setTemplateSearch = useSet(
    composerSignals.template.setTemplatePickerSearch$,
  );
  const setTemplatePreviewSlug = useSet(
    composerSignals.template.setTemplatePickerPreviewSlug$,
  );
  const setTemplateReferenceValue = useSet(
    composerSignals.template.setTemplatePickerReferenceValue$,
  );
  const setTemplateOpen = useSet(
    composerSignals.template.setTemplatePickerOpen$,
  );
  const copy: StartCardCopy = t(
    ($) => {
      return $.chat.startCards.kinds;
    },
    { returnObjects: true },
  );

  const openTemplates = (kind: StartCardKind) => {
    setTemplateSearch("");
    setTemplatePreviewSlug(null);
    setTemplateReferenceValue(null);
    setTemplateCategory(kind);
    setTemplateOpen(true);
  };

  const contentFor = (
    kind: StartCardKind,
    template: WorkflowTemplateItem | undefined,
  ): StartCardContent => {
    if (kind === "workflow") {
      const localized = template
        ? localizedWorkflowTemplate(template)
        : undefined;
      return {
        title: localized?.title ?? "",
        // The catalog's own `description` is written for the template picker
        // and runs past the two lines this card has.
        description: localized?.shortDescription ?? "",
        prompt: template?.promptGuidance ?? "",
      };
    }
    if (kind === "video" && introVideoEnabled) {
      return {
        ...copy.video,
        title: t(($) => {
          return $.artifacts.templates.creativeVideo;
        }),
      };
    }
    return copy[kind];
  };

  const artFor = (kind: StartCardKind): ReactNode => {
    const accent = kindAccent(kind);
    const art: Record<StartCardKind, ReactNode> = {
      slides: <SlidesArt accent={accent} />,
      website: <WebsiteArt accent={accent} />,
      illustration: <IllustrationArt accent={accent} />,
      video: <VideoArt accent={accent} />,
      avatar: <AvatarArt accent={accent} />,
      workflow: <WorkflowArt accent={accent} />,
    };
    return art[kind];
  };

  return (
    <>
      <div
        data-testid="start-cards"
        className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {kinds.map((kind) => {
          return (
            <StartCard
              key={kind}
              kind={kind}
              content={contentFor(kind, workflowTemplate)}
              art={artFor(kind)}
              onSelectPrompt={onSelectPrompt}
              onOpenTemplates={() => {
                openTemplates(kind);
              }}
            />
          );
        })}
      </div>
    </>
  );
}
