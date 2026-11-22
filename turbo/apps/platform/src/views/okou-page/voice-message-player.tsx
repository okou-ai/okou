import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Pause, Play, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { VoicePlayer } from "../../signals/chat-page/voice-player.ts";

const heights = Object.freeze([
  5, 9, 16, 12, 6, 18, 24, 14, 7, 13, 20, 10, 5, 11, 18, 23, 14, 6, 12, 17, 8,
  4,
]);

function ClipMetadata({ track }: { track: VoicePlayer["tracks"][number] }) {
  const url = useLoadable(track.resourceUrl$);
  const setDuration = useSet(track.duration$);
  return (
    <audio
      hidden
      preload="metadata"
      src={url.state === "hasData" ? url.data : undefined}
      onDurationChange={(event) => {
        const duration = event.currentTarget.duration;
        setDuration(Number.isFinite(duration) ? duration : null);
      }}
    />
  );
}

export function VoiceMessagePlayer({
  player,
  compact = false,
}: {
  player: VoicePlayer;
  compact?: boolean;
}) {
  const bars = compact ? heights.slice(0, 7) : heights;
  const { t } = useTranslation();
  const playback = useGet(player.playback$);
  const elapsed = useGet(player.elapsed$);
  const total = useGet(player.total$);
  const signal = useGet(pageSignal$);
  const mount = useSet(player.mount$);
  const [operation, control] = useLoadableSet(player.control$);
  const updateTime = useSet(player.updateTime$);
  const setPlayback = useSet(player.playback$);
  const failed = playback === "error" || operation.state === "hasError";
  const time = playback === "ready" ? total : elapsed;
  const playing = playback === "playing";
  const label = failed
    ? t(($) => {
        return $.chat.messageDocument.retryVoice;
      })
    : playing
      ? t(($) => {
          return $.chat.messageDocument.pauseVoice;
        })
      : t(($) => {
          return $.chat.messageDocument.playVoice;
        });
  const Icon = failed ? RotateCw : playing ? Pause : Play;
  return (
    <button
      type="button"
      onClick={() => {
        detach(
          control(failed ? "retry" : playing ? "pause" : "play", signal),
          Reason.DomCallback,
        );
      }}
      aria-label={label}
      className={`inline-flex max-w-full shrink-0 items-center border border-border text-foreground hover:bg-accent ${compact ? "h-9 w-26 gap-1 rounded-lg bg-background px-2" : "h-12 w-[245px] gap-3 rounded-full bg-muted px-3"}`}
    >
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-full bg-foreground text-background ${compact ? "size-5" : "size-8"}`}
      >
        <Icon
          size={compact ? 10 : 14}
          className={failed ? undefined : "fill-current"}
        />
      </span>
      <svg
        aria-hidden="true"
        className={compact ? "h-4 min-w-0 flex-1" : "h-6 min-w-0 flex-1"}
        viewBox={`0 0 ${bars.length * 5} 24`}
        preserveAspectRatio="none"
      >
        {bars.map((height, i) => {
          const x = i * 5;
          return (
            <rect
              key={x}
              x={x}
              y={(24 - height) / 2}
              width={2.5}
              height={height}
              rx={1.25}
              className={
                total && i / bars.length < elapsed / total
                  ? "fill-violet-600"
                  : "fill-muted-foreground/50"
              }
            />
          );
        })}
      </svg>
      <span
        className={`shrink-0 text-right tabular-nums text-muted-foreground ${compact ? "w-8 text-xs" : "w-12 text-sm"}`}
      >
        {time === null
          ? "–:––"
          : `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`}
      </span>
      <audio
        hidden
        ref={mount}
        onTimeUpdate={(event) => {
          return updateTime(event.currentTarget.currentTime);
        }}
        onPause={(event) => {
          if (
            event.currentTarget.paused &&
            !event.currentTarget.ended &&
            playing &&
            !failed
          ) {
            setPlayback("paused");
          }
        }}
        onError={() => {
          return setPlayback("error");
        }}
        onEnded={() => {
          return detach(control("next", signal), Reason.DomCallback);
        }}
      />
      {player.tracks.map((track) => {
        return <ClipMetadata track={track} key={track.key} />;
      })}
    </button>
  );
}
