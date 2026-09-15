import { useCallback, useEffect, useState } from "react";
import { Circle } from "lucide-react";
import { areaFromDrag } from "../../desktop-recorder-overlay-geometry";
import type { DesktopRecorderArea } from "../../desktop-recorder-types";

interface DragPoint {
  readonly x: number;
  readonly y: number;
}

const recorder = window.okouDesktopRecorder;
/**
 * Which screen this overlay covers.
 *
 * One selector opens per display, so the region alone is ambiguous: the same
 * rectangle means a different place on every screen until it is rebased onto
 * the one it was drawn on.
 */
const displayId = Number(
  new URLSearchParams(window.location.search).get("display"),
);
const START_BUTTON_HEIGHT = 52;

/**
 * Full-screen overlay for choosing the region to record.
 *
 * The region stays adjustable: every new drag replaces it, and nothing is
 * committed until Start is pressed, which begins the recording straight away.
 */
export function AreaSelector(): React.ReactElement {
  const [start, setStart] = useState<DragPoint | null>(null);
  const [current, setCurrent] = useState<DragPoint | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    void recorder?.completeAreaSelection(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [cancel]);

  const selection: DesktopRecorderArea | null =
    start && current ? areaFromDrag(start, current) : null;
  const committable =
    selection !== null && selection.width >= 2 && selection.height >= 2;

  // Above the region when there is room, otherwise just inside its top edge, so
  // the button is never off-screen for a selection drawn at the very top.
  const buttonTop =
    selection && selection.y >= START_BUTTON_HEIGHT + 12
      ? selection.y - START_BUTTON_HEIGHT - 12
      : (selection?.y ?? 0) + 12;

  return (
    <div
      className="area-selector"
      role="presentation"
      onMouseDown={(event) => {
        const point = { x: event.clientX, y: event.clientY };
        setStart(point);
        setCurrent(point);
        setDragging(true);
      }}
      onMouseMove={(event) => {
        if (dragging) {
          setCurrent({ x: event.clientX, y: event.clientY });
        }
      }}
      onMouseUp={() => {
        setDragging(false);
      }}
    >
      {selection ? (
        <div
          className="area-selector__region"
          style={{
            left: `${selection.x.toString()}px`,
            top: `${selection.y.toString()}px`,
            width: `${selection.width.toString()}px`,
            height: `${selection.height.toString()}px`,
          }}
        >
          <span className="area-selector__size">
            {selection.width} × {selection.height}
          </span>
        </div>
      ) : (
        <p className="area-selector__hint">
          Drag to choose what to record · Esc to cancel
        </p>
      )}

      {committable && !dragging ? (
        <button
          type="button"
          className="area-selector__start"
          disabled={busy}
          style={{
            left: `${(selection.x + selection.width / 2).toString()}px`,
            top: `${buttonTop.toString()}px`,
          }}
          onMouseDown={(event) => {
            // The overlay starts a new drag on mousedown; this button must not.
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (!recorder) {
              return;
            }
            setBusy(true);
            setError(null);
            void recorder
              .completeAreaSelection({ displayId, area: selection })
              .catch((startError: unknown) => {
                setBusy(false);
                setError(
                  startError instanceof Error
                    ? startError.message
                    : "Could not start recording",
                );
              });
          }}
        >
          <Circle size={15} fill="currentColor" />
          {busy ? "Starting…" : "Start recording"}
        </button>
      ) : null}

      {error ? <p className="area-selector__error">{error}</p> : null}
    </div>
  );
}
