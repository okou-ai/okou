import CCStateSwiftUI
import SwiftUI
import UIKit

/// A plain toolbar action like the composer's add button, with a spinner while the recorder starts.
/// It is placed under the composer's `StoreProvider`.
struct ComposerVoiceInputButton: View {
  let voice: ComposerVoiceInputStore
  @ResolvedValue private var phase: ComposerVoiceInputStore.Phase?

  init(voice: ComposerVoiceInputStore) {
    self.voice = voice
    _phase = ResolvedValue(voice.phaseValue)
  }

  var body: some View {
    Button {
      Task { await voice.start(choosesOutput: true) }
    } label: {
      Group {
        if phase == .starting {
          ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
        } else {
          OkouToolbarIcon("mic")
        }
      }
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Voice input")
    .accessibilityIdentifier("voice-input")
    .disabled(phase != .idle)
  }
}

/// Permission and capture failures stay visible in the existing composer notice area.
struct ComposerVoiceInputNotice: View {
  let voice: ComposerVoiceInputStore
  @ResolvedValue private var recording: ComposerVoiceInputStore.Content?
  @Environment(\.openURL) private var openURL

  init(voice: ComposerVoiceInputStore) {
    self.voice = voice
    _recording = ResolvedValue(voice.value)
  }

  var body: some View {
    if let error = recording?.error {
      OkouBanner(Text(error), icon: "mic", tone: .problem) {
        if recording?.microphoneDenied == true {
          Button("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
          }
        }
      }
      .accessibilityIdentifier("voice-input-status")
    }
  }
}

struct ComposerVoiceInputTray: View {
  let voice: ComposerVoiceInputStore
  let canSend: Bool
  let send: @MainActor () async -> Void
  @ResolvedValue private var recording: ComposerVoiceInputStore.Content?
  @State private var lastSampleAt = Date.distantPast
  @State private var sampleInterval = OkouMotion.waveformSample

  init(
    voice: ComposerVoiceInputStore, canSend: Bool,
    send: @escaping @MainActor () async -> Void
  ) {
    self.voice = voice
    self.canSend = canSend
    self.send = send
    _recording = ResolvedValue(voice.value)
  }

  private var state: ComposerVoiceInputStore.Content { recording ?? voice.snapshot }

  var body: some View {
    HStack(spacing: OkouSpace.xs) {
      Button {
        Task { await voice.discard() }
      } label: {
        OkouToolbarIcon("x")
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Discard recording")
      .disabled(state.phase == .processing)

      Group {
        switch state.phase {
        case .processing:
          HStack(spacing: OkouSpace.sm) {
            ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
            Text(state.uploadingAudio ? "Uploading recording…" : "Preparing text…")
          }
        case .recording:
          OkouLiveWaveform(
            levels: state.levels, lastSampleAt: lastSampleAt, interval: sampleInterval)
        default:
          Text("Recording saved")
        }
      }
      .font(.okou(.subheadline))
      .foregroundStyle(OkouColor.mutedForeground)
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(height: OkouControl.waveformHeight)

      if state.phase != .processing {
        if state.asVoiceMessage {
          Button {
            Task { await voice.finish(asAudio: true, send: send) }
          } label: {
            OkouToolbarIcon("arrow-up")
          }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.circle)
          .tint(OkouColor.primary)
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .accessibilityLabel("Send recording")
          .disabled(!canSend || !state.canUseRecording)
        }

        Button {
          Task { await voice.finish(asAudio: false) }
        } label: {
          OkouToolbarIcon("check")
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.circle)
        .tint(OkouColor.foreground)
        .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        .accessibilityLabel("Transcribe recording")
        .accessibilityIdentifier("finish-voice-input")
        .disabled(!state.canUseRecording)
      }
    }
    .frame(maxWidth: .infinity, minHeight: OkouControl.minimumTarget)
    .accessibilityIdentifier("voice-input-tray")
    .sensoryFeedback(.start, trigger: state.phase == .recording)
    .onChange(of: state.levels) { _, _ in
      let now = Date.now
      let gap = now.timeIntervalSince(lastSampleAt)
      if gap > 0.01 && gap < 0.5 { sampleInterval = sampleInterval * 0.7 + gap * 0.3 }
      lastSampleAt = now
    }
  }
}

/// Animates a container whose layout follows the voice tray. The phase is read from the session
/// graph, so the container changes in the same transaction as the composer.
struct ComposerVoiceAnimation: ViewModifier {
  let animation: Animation?
  @ResolvedValue private var phase: ComposerVoiceInputStore.Phase?

  init(voice: ComposerVoiceInputStore?, animation: Animation?) {
    self.animation = animation
    _phase = ResolvedValue(voice?.phaseValue ?? ComposerVoiceInputStore.idlePhase)
  }

  func body(content: Content) -> some View {
    content.animation(animation, value: phase)
  }
}
