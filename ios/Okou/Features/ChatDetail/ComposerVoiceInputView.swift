import SwiftUI
import UIKit

/// The composer's mic: a clear glass circle like every bar control, a spinner while the
/// recorder starts.
struct ComposerVoiceInputButton: View {
  let voice: ComposerVoiceInputStore

  var body: some View {
    Button {
      // The keyboard goes away while recording; the tray above the composer takes over.
      UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
      Task { await voice.start() }
    } label: {
      Group {
        if voice.phase == .starting {
          ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
        } else {
          OkouToolbarIcon("mic")
        }
      }
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
    }
    .buttonStyle(.plain)
    .modifier(OkouGlassControl(shape: .circle))
    .accessibilityLabel("Voice input")
    .accessibilityIdentifier("voice-input")
    .disabled(voice.phase != .idle)
  }
}

/// Recording above the composer, as ChatGPT draws dictation: one glass bar with discard, the
/// elapsed time, a live waveform and Done, which turns the recording into text in the draft.
/// A recording kept from an earlier session offers Use instead. Problems are the shared quiet
/// banner.
struct ComposerVoiceInputTray: View {
  let voice: ComposerVoiceInputStore
  @Environment(\.openURL) private var openURL
  @State private var lastSampleAt = Date.distantPast
  @State private var sampleInterval = OkouMotion.waveformSample

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      if let error = voice.error {
        OkouBanner(Text(error), icon: "mic", tone: .problem) {
          if voice.microphoneDenied {
            Button("Open Settings") {
              if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
          }
        }
        .accessibilityIdentifier("voice-input-status")
      }
      if voice.phase == .recording || voice.phase == .saved || voice.phase == .processing {
        bar
      }
    }
    .accessibilityIdentifier("voice-input-tray")
    .onChange(of: voice.levels) { _, _ in
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
      .disabled(voice.phase == .processing)

      Group {
        if voice.phase == .processing {
          HStack(spacing: OkouSpace.sm) {
            ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
            Text("Preparing text…")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          HStack(spacing: OkouSpace.sm) {
            Text(String(format: "%02d:%02d", Int(voice.duration) / 60, Int(voice.duration) % 60))
              .monospacedDigit()
              .accessibilityLabel("Recording duration, \(Int(voice.duration)) seconds")
            if voice.phase == .recording {
              OkouLiveWaveform(
                levels: voice.levels, lastSampleAt: lastSampleAt, interval: sampleInterval)
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

      if voice.phase != .processing {
        Button {
          Task { await voice.finish() }
        } label: {
          Text(voice.phase == .recording ? "Done" : "Use")
            .font(.okou(.subheadline).weight(.semibold))
            .foregroundStyle(OkouColor.primaryForeground)
            .padding(.horizontal, OkouSpace.xs)
        }
        .buttonStyle(.glassProminent)
        .tint(OkouColor.primary)
        .disabled(!voice.canUseRecording)
        .accessibilityLabel(voice.phase == .recording ? "Finish recording" : "Use recording")
        .accessibilityIdentifier("finish-voice-input")
      }
    }
    .padding(.leading, OkouSpace.six)
    .padding(.trailing, OkouSpace.sm)
    .frame(minHeight: OkouControl.minimumTarget + OkouSpace.sm)
    .glassEffect(.regular, in: Capsule())
    .sensoryFeedback(.start, trigger: voice.phase == .recording)
    .accessibilityElement(children: .contain)
  }
}
