import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { DesktopRecorderWindowOption } from "../../desktop-recorder-types";

const recorder = window.okouDesktopRecorder;

/**
 * Picks the window to record by sight.
 *
 * The list the system reports is mostly menu-bar extras and other chrome, and
 * as plain text one line looks much like another, so windows are shown as their
 * current preview with the application they belong to.
 */
export function WindowPicker(): React.ReactElement {
  const [options, setOptions] = useState<
    readonly DesktopRecorderWindowOption[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recorder) {
      return;
    }
    void recorder
      .listWindowOptions()
      .then(setOptions)
      .catch((listError: unknown) => {
        setError(
          listError instanceof Error
            ? listError.message
            : "Could not read the open windows",
        );
      });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        void recorder?.completeWindowSelection(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="window-picker">
      <header className="window-picker__header">
        <h1 className="window-picker__title">Choose a window</h1>
        <button
          type="button"
          className="window-picker__close"
          aria-label="Close"
          onClick={() => {
            void recorder?.completeWindowSelection(null);
          }}
        >
          <X size={16} />
        </button>
      </header>

      {error ? (
        <div className="window-picker__error">
          <p className="window-picker__error-text">{error}</p>
          {/* The system will not ask again once it has been told no, so the
              only way forward is the Settings pane itself. */}
          <button
            type="button"
            className="window-picker__settings"
            onClick={() => {
              void recorder?.openScreenRecordingSettings();
            }}
          >
            Open Screen Recording settings
          </button>
        </div>
      ) : null}

      {options === null && !error ? (
        <p className="window-picker__empty">Looking for open windows…</p>
      ) : null}

      {options?.length === 0 ? (
        <p className="window-picker__empty">
          No window is open to record. Try Display instead.
        </p>
      ) : null}

      <div className="window-picker__grid">
        {options?.map((option) => {
          return (
            <button
              key={option.id}
              type="button"
              className="window-picker__option"
              onClick={() => {
                void recorder?.completeWindowSelection({
                  sourceId: option.id,
                  title: option.title,
                });
              }}
            >
              <img
                className="window-picker__preview"
                src={option.previewDataUrl}
                alt=""
              />
              <span className="window-picker__app">{option.appName}</span>
              <span className="window-picker__window">{option.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
