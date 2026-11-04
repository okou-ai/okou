import SwiftUI
import UIKit

struct ComposerVoiceInputButton: View {
  let voice: ComposerVoiceInputStore

  var body: some View {
    Button {
      Task { await voice.start() }
    } label: {
      if voice.phase == .starting {
        ProgressView().controlSize(.small).frame(width: 44, height: 44)
      } else {
        Image(systemName: "mic").font(.system(size: 20)).frame(width: 44, height: 44)
      }
    }
    .accessibilityLabel("Voice input")
    .accessibilityIdentifier("voice-input")
    .disabled(voice.phase != .idle)
  }
}

struct ComposerVoiceInputTray: View {
  let voice: ComposerVoiceInputStore
  @Environment(\.openURL) private var openURL
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let error = voice.error {
        Text(error).font(.caption).foregroundStyle(.secondary)
          .accessibilityIdentifier("voice-input-status")
        if voice.microphoneDenied {
          Button("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
          }
          .font(.caption)
        }
      }
      if voice.phase == .recording || voice.phase == .saved || voice.phase == .processing {
        HStack(spacing: 12) {
          Button(role: .destructive) {
            Task { await voice.discard() }
          } label: {
            Image(systemName: "trash").frame(width: 44, height: 44)
          }
          .accessibilityLabel("Discard recording")
          .disabled(voice.phase == .processing)
          if voice.phase == .processing {
            ProgressView().controlSize(.small)
            Text("Preparing text…").font(.subheadline)
          } else {
            Text(String(format: "%02d:%02d", Int(voice.duration) / 60, Int(voice.duration) % 60))
              .monospacedDigit().font(.subheadline)
              .accessibilityLabel("Recording duration, \(Int(voice.duration)) seconds")
            if voice.phase == .recording {
              GeometryReader { geometry in
                HStack(alignment: .center, spacing: 3) {
                  ForEach(0..<24, id: \.self) { index in
                    let samples = Array(voice.levels.suffix(24))
                    let level = index < samples.count ? samples[index] : 0
                    Capsule().fill(.tint)
                      .frame(height: max(3, CGFloat(level) * geometry.size.height))
                  }
                }
                .frame(height: geometry.size.height)
              }
              .frame(height: 24)
              .animation(reduceMotion ? nil : .linear(duration: 0.12), value: voice.levels)
              .accessibilityHidden(true)
            } else {
              Text("Recording saved").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
          }
          Spacer(minLength: 0)
          if voice.phase != .processing {
            Button(voice.phase == .recording ? "Done" : "Use") {
              Task { await voice.finish() }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityLabel(voice.phase == .recording ? "Finish recording" : "Use recording")
            .disabled(!voice.canUseRecording)
            .accessibilityIdentifier("finish-voice-input")
          }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24))
      }
    }
    .accessibilityIdentifier("voice-input-tray")
  }
}
