import type { ViewerError } from "./types.ts";

export type ImageRecovery = {
  readonly owner: object;
  readonly targetId: string;
  readonly error: ViewerError;
  readonly phase:
    | "settling"
    | "ready"
    | "preparing"
    | "starting"
    | "waiting-image"
    | "presented"
    | "blocked";
};

export type ImageEvent =
  | {
      readonly type: "image-failed";
      readonly owner: object;
      readonly targetId: string;
      readonly error: ViewerError;
    }
  | {
      readonly type: "image-settled";
      readonly owner: object;
      readonly ready: boolean;
    }
  | {
      readonly type: "image-blocked";
      readonly owner: object;
      readonly error: ViewerError;
    }
  | {
      readonly type:
        | "image-retrying"
        | "image-starting"
        | "image-painted"
        | "image-released";
      readonly owner: object;
    }
  | {
      readonly type: "image-cancelled";
      readonly owner: object;
      readonly stopped: boolean;
    };

export interface ImageDecision {
  readonly state: ImageRecovery | null;
  readonly accepted: boolean;
  readonly imageReady: boolean;
  readonly resumeDisplay: boolean;
}

export function retryingImage(image: ImageRecovery | null): boolean {
  return (
    image?.phase === "preparing" ||
    image?.phase === "starting" ||
    image?.phase === "waiting-image"
  );
}

/** Pure recovery decisions; native receipts and the capture lane remain resource-owned. */
export function transitionImage(
  image: ImageRecovery | null,
  event: ImageEvent,
): ImageDecision {
  const ignored: ImageDecision = {
    state: image,
    accepted: false,
    imageReady: false,
    resumeDisplay: false,
  };
  if (event.type === "image-failed") {
    return acceptedImage({
      owner: event.owner,
      targetId: event.targetId,
      error: event.error,
      phase: "settling",
    });
  }
  if (!image || image.owner !== event.owner) {
    return ignored;
  }
  switch (event.type) {
    case "image-settled": {
      return image.phase === "settling"
        ? acceptedImage({ ...image, phase: event.ready ? "ready" : "blocked" })
        : ignored;
    }
    case "image-retrying": {
      return image.phase === "ready"
        ? acceptedImage({ ...image, phase: "preparing" })
        : ignored;
    }
    case "image-starting": {
      return image.phase === "preparing"
        ? acceptedImage({ ...image, phase: "starting" })
        : ignored;
    }
    case "image-painted": {
      if (image.phase === "starting") {
        return acceptedImage({ ...image, phase: "presented" }, true);
      }
      return image.phase === "waiting-image"
        ? acceptedImage(null, true, true)
        : ignored;
    }
    case "image-released": {
      if (image.phase === "starting") {
        return acceptedImage({ ...image, phase: "waiting-image" });
      }
      return image.phase === "presented"
        ? acceptedImage(null, false, true)
        : ignored;
    }
    case "image-blocked":
    case "image-cancelled": {
      return settleImageIntent(image, event, ignored);
    }
  }
}

function acceptedImage(
  state: ImageRecovery | null,
  imageReady = false,
  resumeDisplay = false,
): ImageDecision {
  return { state, accepted: true, imageReady, resumeDisplay };
}

function settleImageIntent(
  image: ImageRecovery,
  event: Extract<ImageEvent, { type: "image-blocked" | "image-cancelled" }>,
  ignored: ImageDecision,
): ImageDecision {
  switch (event.type) {
    case "image-blocked": {
      return retryingImage(image) || image.phase === "presented"
        ? acceptedImage({ ...image, phase: "blocked", error: event.error })
        : ignored;
    }
    case "image-cancelled": {
      // Settling still needs every original receipt, even if capture alone stopped.
      return retryingImage(image) || image.phase === "presented"
        ? acceptedImage({
            ...image,
            phase: event.stopped ? "ready" : "blocked",
          })
        : ignored;
    }
  }
}
