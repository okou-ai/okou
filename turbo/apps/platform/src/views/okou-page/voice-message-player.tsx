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

export function VoiceMessagePlayer({ player }: { player: VoicePlayer }) {
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
      className="inline-flex h-12 w-[245px] max-w-full items-center gap-3 self-end rounded-full border border-border bg-muted px-3 text-foreground hover:bg-accent"
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
      >
        <Icon size={14} className={failed ? undefined : "fill-current"} />
      </span>
      <svg
        aria-hidden="true"
        className="h-6 min-w-0 flex-1"
        viewBox="0 0 110 24"
        preserveAspectRatio="none"
      >
        {heights.map((height, i) => {
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
                total && i / heights.length < elapsed / total
                  ? "fill-violet-600"
                  : "fill-muted-foreground/50"
              }
            />
          );
        })}
      </svg>
      <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
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
