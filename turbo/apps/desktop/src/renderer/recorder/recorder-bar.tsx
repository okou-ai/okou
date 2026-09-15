import { useCallback, useEffect, useState } from "react";
import {
  AppWindow,
  Mic,
  MicOff,
  Monitor,
  SquareDashed,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

type CaptureChoice =
  | { readonly kind: "display" }
  | {
      readonly kind: "window";
      readonly sourceId: string;
      readonly title: string;
    };

const recorder = window.okouDesktopRecorder;

export function RecorderBar(): React.ReactElement {
  const [choice, setChoice] = useState<CaptureChoice>({ kind: "display" });
  const [systemAudio, setSystemAudio] = useState(true);
  const [microphone, setMicrophone] = useState(false);
  const [microphoneSupported, setMicrophoneSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recorder) {
      return;
    }
    // Capabilities only, deliberately: reading what is on screen would make
    // the system demand the recording permission the moment the bar opens.
    void recorder
      .getCapabilities()
      .then((capabilities) => {
        setMicrophoneSupported(capabilities.supportsMicrophone);
      })
      .catch((capabilitiesError: unknown) => {
        setError(
          capabilitiesError instanceof Error
            ? capabilitiesError.message
            : "Could not read what this Mac can record",
        );
      });
  }, []);

  const chooseWindow = useCallback(() => {
    if (!recorder) {
      return;
    }
    setError(null);
    // The picker takes over its own window, so the bar waits for a choice
    // rather than trying to show a grid inside a row of controls.
    void recorder
      .selectWindow()
      .then((chosen) => {
        if (chosen) {
          setChoice({
            kind: "window",
            sourceId: chosen.sourceId,
            title: chosen.title,
          });
        }
      })
      .catch((pickError: unknown) => {
        setError(
          pickError instanceof Error
            ? pickError.message
            : "Could not list the open windows",
        );
      });
  }, []);

  /**
   * Abandons an open window pick.
   *
   * `selectWindow` stays pending until something answers it. Leaving it open
   * while the user moves on left the picker floating over every other choice,
   * and tearing the bar down with the call still in flight surfaced Electron's
   * "reply was never sent" as a recording error.
   */
  const abandonWindowChoice = useCallback(() => {
    void recorder?.completeWindowSelection(null);
  }, []);

  const chooseArea = useCallback(() => {
    if (!recorder) {
      return;
    }
    abandonWindowChoice();
    setError(null);
    // An area capture is started by the overlay that draws it, so the audio
    // choices travel with the request rather than waiting for Start here.
    void recorder
      .beginAreaSelection({ systemAudio, microphone })
      .catch((selectError: unknown) => {
        setError(
          selectError instanceof Error
            ? selectError.message
            : "Could not select a region",
        );
      });
  }, [abandonWindowChoice, microphone, systemAudio]);

  const start = useCallback(() => {
    if (!recorder) {
      return;
    }
    setBusy(true);
    setError(null);
    const request =
      choice.kind === "window"
        ? {
            sourceKind: "window" as const,
            sourceId: choice.sourceId,
            systemAudio,
            microphone,
          }
        : { sourceKind: "display" as const, systemAudio, microphone };
    void recorder.startCapture(request).catch((startError: unknown) => {
      setBusy(false);
      setError(
        startError instanceof Error
          ? startError.message
          : "Could not start recording",
      );
    });
  }, [choice, microphone, systemAudio]);

  return (
    <div className="recorder-bar">
      <button
        type="button"
        className="recorder-bar__close"
        aria-label="Close"
        onClick={() => {
          void recorder?.cancel();
        }}
      >
        <X size={16} />
      </button>

      <div className="recorder-bar__sources">
        <button
          type="button"
          className="recorder-bar__source"
          aria-pressed={choice.kind === "display"}
          onClick={() => {
            abandonWindowChoice();
            setChoice({ kind: "display" });
          }}
        >
          <Monitor size={22} />
          <span className="recorder-bar__source-label">Display</span>
        </button>

        <button
          type="button"
          className="recorder-bar__source"
          aria-pressed={choice.kind === "window"}
          title={choice.kind === "window" ? choice.title : undefined}
          onClick={chooseWindow}
        >
          <AppWindow size={22} />
          {/* The mode keeps its own name. Naming the button after the chosen
              window made a pick titled "Menubar" read as a third capture mode
              beside Display and Area; the target belongs under it. */}
          <span className="recorder-bar__source-label">Window</span>
          {choice.kind === "window" ? (
            <span className="recorder-bar__source-target">{choice.title}</span>
          ) : null}
        </button>

        <button
          type="button"
          className="recorder-bar__source"
          onClick={chooseArea}
        >
          <SquareDashed size={22} />
          <span className="recorder-bar__source-label">Area</span>
        </button>
      </div>

      <span className="recorder-bar__divider" />

      <button
        type="button"
        className="recorder-bar__audio"
        aria-pressed={systemAudio}
        onClick={() => {
          setSystemAudio((enabled) => {
            return !enabled;
          });
        }}
      >
        {systemAudio ? <Volume2 size={18} /> : <VolumeX size={18} />}
        <span>{systemAudio ? "System audio" : "No system audio"}</span>
      </button>

      <button
        type="button"
        className="recorder-bar__audio"
        aria-pressed={microphone}
        disabled={!microphoneSupported}
        title={microphoneSupported ? undefined : "Needs macOS 15 or later"}
        onClick={() => {
          setMicrophone((enabled) => {
            return !enabled;
          });
        }}
      >
        {microphone ? <Mic size={18} /> : <MicOff size={18} />}
        <span>{microphone ? "Microphone" : "No microphone"}</span>
      </button>

      <button
        type="button"
        className="recorder-bar__start"
        disabled={busy}
        onClick={start}
      >
        {busy ? "Starting…" : "Start recording"}
      </button>

      {error ? (
        <p className="recorder-bar__error">
          {error}
          <button
            type="button"
            className="recorder-bar__error-action"
            onClick={() => {
              void recorder?.openScreenRecordingSettings();
            }}
          >
            Open settings
          </button>
        </p>
      ) : null}
    </div>
  );
}
