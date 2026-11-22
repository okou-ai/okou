import { command, computed, state } from "ccstate";
import { attachmentDownloadSource$ } from "../attachment-download-source.ts";
import { createAttachmentResourceUrl$ } from "../attachment-resource-url.ts";
import { onRef, resetSignal } from "../utils.ts";
import { canonicalUserMessageFileUrl } from "./user-message-files.ts";

export function createVoicePlayer(clips: readonly { fileId: string }[]) {
  const tracks = clips.map(({ fileId }, index) => {
    const url = canonicalUserMessageFileUrl(fileId);
    return {
      key: `${fileId}-${index}`,
      url,
      resourceUrl$: createAttachmentResourceUrl$(url),
      duration$: state<number | null>(null),
    };
  });
  const total$ = computed((get) => {
    let sum = 0;
    for (const track of tracks) {
      const duration = get(track.duration$);
      if (duration === null) {
        return null;
      }
      sum += duration;
    }
    return sum;
  });
  const cursor$ = state({ index: 0, offset: 0 });
  const elapsed$ = state(0);
  const playback$ = state<"ready" | "playing" | "paused" | "error">("ready");
  const owner$ = state<{ audio: HTMLAudioElement; signal: AbortSignal } | null>(
    null,
  );
  const resetAttempt$ = resetSignal();
  const mount$ = onRef(
    command(({ set }, audio: HTMLAudioElement, signal: AbortSignal) => {
      set(owner$, { audio, signal });
      signal.addEventListener("abort", () => {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        set(owner$, null);
        set(cursor$, { index: 0, offset: 0 });
        set(elapsed$, 0);
        set(playback$, "ready");
      });
    }),
  );
  const updateTime$ = command(({ get, set }, time: number) => {
    if (get(playback$) !== "ready") {
      set(elapsed$, get(cursor$).offset + time);
    }
  });
  const control$ = command(
    async (
      { get, set },
      action: "play" | "pause" | "next" | "retry",
      parentSignal: AbortSignal,
    ) => {
      const owner = get(owner$);
      if (!owner) {
        return;
      }
      const { audio } = owner;
      const signal = set(resetAttempt$, owner.signal, parentSignal);
      if (action === "pause") {
        audio.pause();
        set(playback$, "paused");
        return;
      }
      let { index, offset } = get(cursor$);
      if (action === "next") {
        const duration = Number.isFinite(audio.duration)
          ? audio.duration
          : audio.currentTime;
        set(tracks[index]!.duration$, duration);
        index += 1;
        offset += duration;
        if (index === tracks.length) {
          set(cursor$, { index: 0, offset: 0 });
          set(elapsed$, 0);
          set(playback$, "ready");
          return;
        }
        set(cursor$, { index, offset });
        set(elapsed$, offset);
      }
      const resume =
        action === "play" &&
        get(playback$) === "paused" &&
        !audio.ended &&
        audio.src;
      set(playback$, "playing");
      if (!resume) {
        const track = tracks[index]!;
        const url =
          action === "retry"
            ? (await set(attachmentDownloadSource$, track.url, "app", signal))
                .resourceUrl
            : await get(track.resourceUrl$);
        signal.throwIfAborted();
        // Reuse the element activated by the user across clip boundaries.
        audio.src = url;
      }
      await audio.play();
    },
  );
  return { tracks, total$, elapsed$, playback$, mount$, control$, updateTime$ };
}
export type VoicePlayer = ReturnType<typeof createVoicePlayer>;
