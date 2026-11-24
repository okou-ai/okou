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
      Task { await voice.start() }
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

/// Recording above the composer, as ChatGPT draws dictation: one glass bar with discard, the
/// elapsed time, a live waveform and Done, which turns the recording into text in the draft.
/// A recording kept from an earlier session offers Use instead. Problems are the shared quiet
/// banner.
struct ComposerVoiceInputTray: View {
  let voice: ComposerVoiceInputStore
  @ResolvedValue private var recording: ComposerVoiceInputStore.Content?
  @Environment(\.openURL) private var openURL
  @State private var lastSampleAt = Date.distantPast
  @State private var sampleInterval = OkouMotion.waveformSample

  init(voice: ComposerVoiceInputStore) {
    self.voice = voice
    _recording = ResolvedValue(voice.value)
  }

  /// This render's graph value. The synchronous read only covers a missing first resolution.
  private var state: ComposerVoiceInputStore.Content { recording ?? voice.snapshot }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      if let error = state.error {
        OkouBanner(Text(error), icon: "mic", tone: .problem) {
          if state.microphoneDenied {
            Button("Open Settings") {
              if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
          }
        }
        .accessibilityIdentifier("voice-input-status")
      }
      if state.phase == .recording || state.phase == .saved || state.phase == .processing {
        bar
      }
    }
    .accessibilityIdentifier("voice-input-tray")
    .onChange(of: state.levels) { _, _ in
      // The waveform glides one bar per sample; follow the capture's own cadence.
      let now = Date.now
      let gap = now.timeIntervalSince(lastSampleAt)
      if gap > 0.01 && gap < 0.5 { sampleInterval = sampleInterval * 0.7 + gap * 0.3 }
      lastSampleAt = now
    }
  }

  private var bar: some View {
    HStack(spacing: OkouSpace.xs) {
      Button(role: .destructive) {
        Task { await voice.discard() }
      } label: {
        OkouToolbarIcon("trash-2")
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(OkouColor.foreground)
      .accessibilityLabel("Discard recording")
      .disabled(state.phase == .processing)

      Group {
        if state.phase == .processing {
          HStack(spacing: OkouSpace.sm) {
            ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
            Text(state.asVoiceMessage ? "Uploading recording…" : "Preparing text…")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          HStack(spacing: OkouSpace.sm) {
            Text(String(format: "%02d:%02d", Int(state.duration) / 60, Int(state.duration) % 60))
              .monospacedDigit()
              .accessibilityLabel("Recording duration, \(Int(state.duration)) seconds")
            if state.phase == .recording {
              OkouLiveWaveform(
                levels: state.levels, lastSampleAt: lastSampleAt, interval: sampleInterval)
            } else {
              Text("Recording saved")
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        }
      }
      .font(.okou(.subheadline))
      .foregroundStyle(OkouColor.mutedForeground)
      .frame(maxWidth: .infinity)
      .frame(height: OkouControl.waveformHeight)

      if state.phase != .processing {
        Button {
          Task { await voice.finish() }
        } label: {
          Text(state.phase == .recording ? "Done" : "Use")
            .font(.okou(.subheadline).weight(.semibold))
            .foregroundStyle(OkouColor.primaryForeground)
            .padding(.horizontal, OkouSpace.xs)
        }
        // A solid fill: the recording bar under it is already glass.
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .tint(OkouColor.primary)
        .disabled(!state.canUseRecording)
        .accessibilityLabel(state.phase == .recording ? "Finish recording" : "Use recording")
        .accessibilityIdentifier("finish-voice-input")
      }
    }
    .padding(.leading, OkouSpace.six)
    .padding(.trailing, OkouSpace.sm)
    .frame(minHeight: OkouControl.minimumTarget + OkouSpace.sm)
    .glassEffect(.regular, in: Capsule())
    .sensoryFeedback(.start, trigger: state.phase == .recording)
    .accessibilityElement(children: .contain)
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
