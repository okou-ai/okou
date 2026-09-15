import { useLoadableSet } from "ccstate-react/experimental";
import { Play, Square } from "lucide-react";
import type { DesktopComputerUseDriverState } from "../computer-use-types";
import { startComputerUse$, stopComputerUse$ } from "./computer-use-state";
import { IconButton } from "./components";
import { detach, Reason } from "./async-action";

export function ComputerUseRecovery({
  state,
}: {
  readonly state: DesktopComputerUseDriverState;
}) {
  const [retry, start] = useLoadableSet(startComputerUse$);
  const [stopping, stop] = useLoadableSet(stopComputerUse$);
  const needsRecovery =
    state.phase === "error" || state.error !== null || state.cleanupPending;
  if (!needsRecovery) return null;

  const recovery = (
    <>
      {state.cleanupPending && (
        <p className="inline-alert" role="status">
          Cleanup is still pending. Recovery waits for the previous native
          helper to exit.
        </p>
      )}
      {state.error && (
        <p className="inline-alert" role="alert">
          {state.error}
        </p>
      )}
      {retry.state === "hasError" && (
        <p className="inline-alert" role="alert">
          The driver could not start. Check permissions and cleanup status.
        </p>
      )}
      <div className="panel-actions">
        {(state.phase === "starting" ||
          state.phase === "recovering" ||
          state.cleanupPending) && (
          <IconButton
            icon={<Square size={15} />}
            tone="danger"
            disabled={stopping.state === "loading"}
            onClick={() => detach(stop(), Reason.DomCallback)}
          >
            Stop
          </IconButton>
        )}
        {state.phase !== "ready" && (
          <IconButton
            icon={<Play size={15} />}
            disabled={!state.canRetry || retry.state === "loading"}
            onClick={() => {
              detach(start(), Reason.DomCallback);
            }}
          >
            Retry
          </IconButton>
        )}
      </div>
    </>
  );

  return <div aria-label="Computer Use recovery">{recovery}</div>;
}
