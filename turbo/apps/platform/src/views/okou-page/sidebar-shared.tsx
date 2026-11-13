import { useGet, useLastResolved } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { BellOff, Pencil } from "lucide-react";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import {
  agentAvatarTexture,
  avatarTextureUrl,
  defaultAgentAvatarTextures,
} from "@okouai/core/agent-avatar-texture";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { OkouAvatar, RunningIndicator } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import { agents$ } from "../../signals/agent.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { currentChatAgentDisplayName$ } from "../../signals/agent-chat.ts";
import type { SidebarChatThreadIndicatorState } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import { resolveAvatarUrl, resolveAvatarSvgConfig } from "./avatar-utils.ts";
import { AvatarSvgPreview, AvatarTextureLayer } from "./avatar-svg-preview.tsx";
import { isLegacyAvatarSvgConfig } from "./avatar-svg-utils.ts";
import { assistantName$ } from "../../signals/branding.ts";

/**
 * Returns labels for the current agent-scoped chat thread list.
 * Used by both the sidebar thread list and the full chat-list page so the two
 * surfaces stay in sync without duplicating the logic.
 */
export function useChatThreadsTitleLabels() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const agentDisplayName = useLastResolved(currentChatAgentDisplayName$);
  const agentName = agentDisplayName ?? assistantName;
  return {
    titleLabel: t(
      ($) => {
        return $.chat.sidebar.chatsWith;
      },
      { agentName },
    ),
    newChatAriaLabel: t(
      ($) => {
        return $.chat.sidebar.newChatWith;
      },
      { agentName },
    ),
  };
}

// One spatial cycle spans 12 rows: 200ms per row at the existing 2.4s cadence.
const RUNNING_INDICATOR_WAVE_ROWS = 12;

/**
 * The state glyph a chat list row rests on. A folded Project draws the same
 * glyph for the chats it hides, so `rowIndex` is the row's position in the
 * whole list: running rows of either kind then breathe as one wave.
 */
export function ChatThreadStateIndicator({
  state,
  rowIndex,
}: {
  readonly state: SidebarChatThreadIndicatorState;
  readonly rowIndex: number;
}) {
  if (state === "running") {
    return (
      <RunningIndicator phaseOffset={rowIndex / RUNNING_INDICATOR_WAVE_ROWS} />
    );
  }
  if (state === "muted") {
    return <BellOff size={16} className="opacity-35" />;
  }
  if (state === "unread") {
    return <span className="h-2 w-2 rounded-full bg-sky-600" />;
  }
  // The draft pencil shares the pin's ink: the menu button's muted ramp at
  // 70%. Lucide's pencil runs corner to corner, so at the same box it reads
  // larger than the upright pin; it is drawn at 0.8 as iOS does
  // (`opticalScales` in icons.json), with the stroke widened by 1/0.8 so the
  // drawn line keeps the shared 1.5 icon weight.
  return (
    <Pencil className="scale-[0.8] opacity-70" size={16} strokeWidth={1.875} />
  );
}

export function ChatThreadStateText({
  state,
}: {
  readonly state: "running" | "muted" | "unread" | "draft" | "pinned" | null;
}) {
  const { t } = useTranslation();
  if (state === null) {
    return null;
  }
  const labels = {
    running: t(($) => {
      return $.activity.statuses.running;
    }),
    muted: t(($) => {
      return $.chat.sidebar.muted;
    }),
    unread: t(($) => {
      return $.chat.sidebar.unread;
    }),
    draft: t(($) => {
      return $.chat.sidebar.draft;
    }),
    pinned: t(($) => {
      return $.chat.sidebar.pinned;
    }),
  };

  return <span className="sr-only"> {labels[state]}</span>;
}

interface AgentAvatarState {
  /** Resolved image URL, or null when SVG/loading. */
  src: string | null;
  /** Raw avatarUrl from the DB, used to detect SVG avatars. */
  rawAvatarUrl: string | null | undefined;
}

/**
 * Reactive hook that returns the agent avatar state from the DB.
 * Returns `{ src: null, rawAvatarUrl: null }` while the agent id is unknown
 * (still loading) or the agent has no avatar set.
 */
function useAgentAvatarState(id: string): AgentAvatarState {
  const resolved = useLastResolved(agents$);
  if (!id || resolved === undefined) {
    return { src: null, rawAvatarUrl: null };
  }
  const agent = resolved.find((a) => {
    return a.agentId === id;
  });
  const rawAvatarUrl = agent?.avatarUrl;
  const dbAvatar = resolveAvatarUrl(rawAvatarUrl);
  return { src: dbAvatar, rawAvatarUrl };
}

/**
 * A drawn file: an uploaded image, or the organization default agent's own
 * SVG. Both are transparent, so a texture behind them shows through.
 */
function DrawnAvatarImage({
  src,
  alt,
  className,
  textureUrl,
  "data-testid": testId,
}: {
  src: string;
  alt: string;
  className: string;
  textureUrl?: string;
  "data-testid"?: string;
}) {
  if (!textureUrl) {
    return (
      <img src={src} alt={alt} className={className} data-testid={testId} />
    );
  }
  return (
    <span className={cn("relative block overflow-hidden", className)}>
      <AvatarTextureLayer url={textureUrl} />
      <img
        src={src}
        alt={alt}
        className="absolute inset-0 h-full w-full object-cover object-top"
        data-testid={testId}
      />
    </span>
  );
}

/**
 * The organization default agent's texture. It is one drawn file rather than a
 * composer configuration, so it gets the one tile that clears the five brand
 * colours it is painted in, by the same rule as every other agent.
 */
function defaultAgentAvatarTextureUrl(): string {
  // Not guarded for emptiness, for the same reason `agentAvatarTexture` is
  // not: the suite pins this list to exactly one tile, so a repaint that
  // emptied it should fail there rather than quietly drop the texture.
  return avatarTextureUrl(defaultAgentAvatarTextures()[0]!);
}

/**
 * Whether the default artwork gives way to the animated design-system avatar.
 *
 * The organization default agent is Okou, and its stored avatar is the flat
 * default drawing. Every surface draws agents through `AgentAvatarImg` or
 * `AvatarFromUrl`, so swapping here reaches every place Okou appears with one
 * decision. An agent whose avatar was changed keeps its own.
 */
function useOkouAvatarFor(rawAvatarUrl: string | null | undefined): boolean {
  const animatedAvatar =
    useGet(featureSwitch$)[FeatureSwitchKey.OkouAnimatedAvatar];
  return animatedAvatar && rawAvatarUrl === DEFAULT_AGENT_AVATAR_URL;
}

/**
 * Okou in a slot sized for an image. The caller's classes size the slot; its
 * corner rounding is dropped because the avatar brings its own frame.
 */
function OkouAvatarInSlot({
  alt,
  className,
  size,
  "data-testid": testId,
}: {
  alt: string;
  className: string;
  size?: number;
  "data-testid"?: string;
}) {
  return (
    <OkouAvatar
      size={size}
      label={alt === "" ? undefined : alt}
      className={cn(className, "rounded-none")}
      data-testid={testId}
    />
  );
}

/**
 * Render an avatar from an avatarUrl string (preset, svg, or custom upload).
 * Does NOT look up the agent — use this when you already have the avatarUrl.
 *
 * Callers should pass shape and size but not a background fill: preset and
 * uploaded avatars are transparent, so a fill shows through as a gray disc
 * behind the face. WorkflowAgentAvatar is the one deliberate exception, where
 * the avatar shares a bordered chip style with its initials fallback.
 */
export function AvatarFromUrl({
  avatarUrl,
  alt,
  className,
  size,
  "data-testid": testId,
}: {
  avatarUrl: string | null | undefined;
  alt: string;
  className: string;
  size?: number;
  "data-testid"?: string;
}) {
  const okou = useOkouAvatarFor(avatarUrl);
  if (okou) {
    return (
      <OkouAvatarInSlot
        alt={alt}
        className={className}
        size={size}
        data-testid={testId}
      />
    );
  }
  const svgConfig = resolveAvatarSvgConfig(avatarUrl);
  if (svgConfig) {
    return (
      <AvatarSvgPreview
        config={svgConfig}
        size={size}
        className={className}
        alt={alt}
        data-testid={testId}
      />
    );
  }
  const src = resolveAvatarUrl(avatarUrl);
  if (src) {
    return (
      <img src={src} alt={alt} className={className} data-testid={testId} />
    );
  }
  // Transparent placeholder, matching AgentAvatarImg: reserves the avatar's box
  // so layout doesn't shift while the agent (or its avatarUrl) is still loading.
  return <span className={className} aria-hidden="true" data-testid={testId} />;
}

/**
 * The brand texture for one agent, or null when it cannot have one.
 *
 * A texture is chosen to clear whatever the avatar itself is painted in, so it
 * needs to know those colours. Composer avatars carry them in their URL, and
 * the organization default agent is a known file whose palette is recorded in
 * core. An uploaded image and the legacy `svg:` configurations are neither, so
 * they get none. Pass a null id to opt out entirely — the hook still runs, so
 * callers stay unconditional.
 *
 * Exported because the frame around the avatar changes with the answer: with a
 * texture the frame's own hairline is redundant, and without one it is still
 * the only edge the artwork has.
 */
export function useAgentAvatarTexture(id: string | null): string | null {
  const { rawAvatarUrl } = useAgentAvatarState(id ?? "");
  if (id === null) {
    return null;
  }
  // The organization default agent is the avatar most people see: every
  // workspace's chat home opens on it.
  if (rawAvatarUrl === DEFAULT_AGENT_AVATAR_URL) {
    return defaultAgentAvatarTextureUrl();
  }
  const svgConfig = resolveAvatarSvgConfig(rawAvatarUrl);
  if (!svgConfig || isLegacyAvatarSvgConfig(svgConfig)) {
    return null;
  }
  const texture = agentAvatarTexture(id, svgConfig);
  return texture ? avatarTextureUrl(texture) : null;
}

/** Reactive avatar image that respects DB-persisted and user overrides. */
export function AgentAvatarImg({
  name,
  alt,
  className,
  size,
  preserveChinBaseline = false,
  textureUrl,
  "data-testid": testId,
}: {
  name: string;
  alt: string;
  className: string;
  size?: number;
  preserveChinBaseline?: boolean;
  /**
   * Brand texture to draw behind the artwork, from `useAgentAvatarTexture`.
   * Only the chat home greeting passes one; it is the single surface that
   * shows one agent large enough for a brush mark to read as a brush mark.
   */
  textureUrl?: string;
  "data-testid"?: string;
}) {
  const { src, rawAvatarUrl } = useAgentAvatarState(name);
  const okou = useOkouAvatarFor(rawAvatarUrl);
  if (okou) {
    return (
      <OkouAvatarInSlot
        alt={alt}
        className={className}
        size={size}
        data-testid={testId}
      />
    );
  }

  // SVG avatar (preset or custom svg:)
  const svgConfig = resolveAvatarSvgConfig(rawAvatarUrl);
  if (svgConfig) {
    return (
      <AvatarSvgPreview
        config={svgConfig}
        size={size}
        preserveChinBaseline={preserveChinBaseline}
        textureUrl={textureUrl}
        className={className}
        alt={alt}
        data-testid={testId}
      />
    );
  }

  if (src) {
    return (
      <DrawnAvatarImage
        src={src}
        alt={alt}
        className={className}
        textureUrl={textureUrl}
        data-testid={testId}
      />
    );
  }

  // Transparent placeholder: reserves the avatar's box so layout doesn't shift
  // while the agent (or its avatarUrl) is still loading, and avoids flashing a
  // default preset that doesn't match the agent's real avatar.
  return <span className={className} aria-hidden="true" data-testid={testId} />;
}
