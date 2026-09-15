import { useEffect, useState } from "react";
import { Pause, Play, Square, Trash2 } from "lucide-react";

const recorder = window.okouDesktopRecorder;

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Controls shown while a recording runs: pause, stop, discard.
 *
 * Lives in its own window placed outside the captured region, so for an area
 * capture it is never part of the video.
 */
type FinishPhase = "finalizing" | "delivering" | null;

function finishLabel(phase: FinishPhase): string {
  return phase === "delivering" ? "Uploading…" : "Finishing…";
}

export function RecordingController(): React.ReactElement {
  // Narrowed once here so the handlers below need no assertions.
  const bridge = recorder;
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [finishing, setFinishing] = useState<FinishPhase>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recorder) {
      return;
    }
    const timer = setInterval(() => {
      void recorder
        .getState()
        .then((state) => {
          setPaused(state.status === "paused");
          setElapsedMs(state.elapsedMs);
          // The window outlives the capture so the finish has somewhere to be
          // seen; the controls it carried are meaningless by then.
          setFinishing(
            state.status === "finalizing" || state.status === "delivering"
              ? state.status
              : null,
          );
        })
        .catch((pollError: unknown) => {
          setError(
            pollError instanceof Error
              ? pollError.message
              : "Lost track of the recording",
          );
        });
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, []);

  function run(action: () => Promise<void>, failure: string): void {
    setBusy(true);
    setError(null);
    void action()
      .catch((actionError: unknown) => {
        // Finishing uploads the recording, so this is a reachable path with
        // nothing else to show it: without a message the button would just
        // come back and the user would try again.
        setError(actionError instanceof Error ? actionError.message : failure);
      })
      .finally(() => {
        setBusy(false);
      });
  }

  const controlsDisabled = busy || finishing !== null || !bridge;

  return (
    <div className="recording-controller">
      <span className="recording-controller__clock">
        <span
          className={
            paused || finishing
              ? "recording-controller__dot recording-controller__dot--paused"
              : "recording-controller__dot"
          }
        />
        {finishing ? finishLabel(finishing) : formatElapsed(elapsedMs)}
      </span>

      <button
        type="button"
        className="recording-controller__button"
        aria-label={paused ? "Resume" : "Pause"}
        disabled={controlsDisabled}
        onClick={() => {
          if (bridge) {
            run(
              () => (paused ? bridge.resume() : bridge.pause()),
              paused ? "Could not resume" : "Could not pause",
            );
          }
        }}
      >
        {paused ? <Play size={17} /> : <Pause size={17} />}
      </button>

      <button
        type="button"
        className="recording-controller__button recording-controller__button--stop"
        aria-label="Finish recording"
        disabled={controlsDisabled}
        onClick={() => {
          if (bridge) {
            run(() => bridge.stop(), "Could not finish the recording");
          }
        }}
      >
        <Square size={15} />
      </button>

      <button
        type="button"
        className="recording-controller__button recording-controller__button--discard"
        aria-label="Delete recording"
        disabled={controlsDisabled}
        onClick={() => {
          if (bridge) {
            run(() => bridge.discard(), "Could not delete the recording");
          }
        }}
      >
        <Trash2 size={16} />
      </button>

      {error ? <p className="recording-controller__error">{error}</p> : null}
    </div>
  );
}
