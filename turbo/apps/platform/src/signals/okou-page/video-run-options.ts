import type { ChatRunVideoOptionsRequest } from "@okouai/api-contracts/contracts/chat-threads";
import {
  resolveVideoGenerationOptions,
  type ResolvedVideoGenerationOptions,
  type VideoModel,
} from "@okouai/core/video-model-catalog";

/**
 * What the user changed, and nothing else.
 *
 * Storing the sparse set rather than four settled values is what makes the
 * panel follow the video model: an untouched setting has no stored value to go
 * stale, so it resolves against whichever model is in effect when it is read.
 * A value the newly chosen model does not accept falls back the same way the
 * generation service would, and comes back if the user returns to a model that
 * does accept it.
 */
export type VideoRunOptionsPatch = ChatRunVideoOptionsRequest;

/** The four values a run would actually use, for the given model. */
export function resolveVideoRunOptions(
  patch: VideoRunOptionsPatch,
  model: VideoModel,
): ResolvedVideoGenerationOptions {
  return resolveVideoGenerationOptions({ ...patch, model });
}

/**
 * Drops back to the sparse set after an edit. Values equal to the model's own
 * default are not the user's choice to keep — they are what an absent value
 * already means — so they are left out.
 */
export function videoRunOptionsPatch(
  next: ResolvedVideoGenerationOptions,
  model: VideoModel,
): VideoRunOptionsPatch {
  const defaults = resolveVideoGenerationOptions({ model });
  return {
    ...(next.aspectRatio === defaults.aspectRatio
      ? {}
      : { aspectRatio: next.aspectRatio }),
    ...(next.duration === defaults.duration ? {} : { duration: next.duration }),
    ...(next.resolution === defaults.resolution
      ? {}
      : { resolution: next.resolution }),
    ...(next.generateAudio === defaults.generateAudio
      ? {}
      : { generateAudio: next.generateAudio }),
  };
}

/** Text summary; the control presents audio separately as an icon. */
export function videoRunOptionsText(
  resolved: ResolvedVideoGenerationOptions,
): string {
  return [resolved.aspectRatio, resolved.duration, resolved.resolution].join(
    " · ",
  );
}

/**
 * Send all displayed parameters, including untouched defaults, without the
 * model (which the run carries separately). Resolve against the effective
 * model so unsupported stored values fall back to its current defaults.
 */
export function videoRunOptionsForSend(
  patch: VideoRunOptionsPatch,
  model: VideoModel,
): ChatRunVideoOptionsRequest {
  const { aspectRatio, duration, resolution, generateAudio } =
    resolveVideoRunOptions(patch, model);
  return { aspectRatio, duration, resolution, generateAudio };
}
