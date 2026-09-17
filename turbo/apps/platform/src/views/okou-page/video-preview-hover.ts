import { detach, Reason } from "../../signals/utils.ts";

/**
 * Hover playback shared by the template galleries. Cards keep their poster
 * until playback actually starts and mark it with `data-preview-playing`, so
 * leaving a card restores exactly the still the user saw before hovering.
 */

function playVideoPreview(video: HTMLVideoElement): void {
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  detach(video.play(), Reason.DomCallback);
}

export function markVideoPreviewPlaying(
  video: HTMLVideoElement | null,
  playing: boolean,
): void {
  if (!video) {
    return;
  }
  video.dataset.previewPlaying = playing ? "true" : "false";
}

export function startVideoPreview(video: HTMLVideoElement | null): void {
  if (!video || (!video.paused && !video.ended)) {
    return;
  }
  playVideoPreview(video);
}

export function resetVideoPreview(video: HTMLVideoElement | null): void {
  if (!video) {
    return;
  }
  video.pause();
  video.currentTime = 0;
  markVideoPreviewPlaying(video, false);
}
