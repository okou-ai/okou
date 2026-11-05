import PDFKit
import SwiftUI
import UIKit
import VisionKit

/// Dictation as ChatGPT draws it: the composer collapses to one bar with cancel, a live
/// waveform, stop (the words go into the draft to read and edit) and send (the words are
/// sent as heard). No red dot or timer: this is typing by voice, not making a recording.
struct VoiceRecordingBar: View {
  let voice: VoiceInputStore
  let canSend: Bool
  let finish: (_ send: Bool) -> Void

  var body: some View {
    HStack(spacing: OkouSpace.xs) {
      Button {
        voice.cancel()
      } label: {
        OkouToolbarIcon("x")
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Cancel dictation")
      .accessibilityIdentifier("cancel-dictation")

      Group {
        if voice.phase == .transcribing {
          HStack(spacing: OkouSpace.sm) {
            ProgressView().controlSize(.small)
            Text("Transcribing…")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        } else if voice.reachedLimit {
          Text("Limit reached")
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          OkouLiveWaveform(
            levels: voice.levels, lastSampleAt: voice.lastLevelAt,
            interval: VoiceInputStore.levelInterval)
        }
      }
      .font(.okou(.subheadline))
      .foregroundStyle(OkouColor.mutedForeground)
      .frame(maxWidth: .infinity)
      .frame(height: OkouControl.waveformHeight)

      Button {
        finish(false)
      } label: {
        OkouIcon("square", size: OkouIconSize.inline)
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .disabled(voice.phase != .recording)
      .accessibilityLabel("Insert transcription")
      .accessibilityIdentifier("finish-dictation")

      Button {
        finish(true)
      } label: {
        OkouToolbarIcon("arrow-up")
          .font(.okou(size: 16, weight: .semibold))
          .foregroundStyle(OkouColor.primaryForeground)
      }
      .buttonStyle(.glassProminent)
      .buttonBorderShape(.circle)
      .tint(OkouColor.primary)
      .disabled(voice.phase != .recording || !canSend)
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .contentShape(Circle())
      .accessibilityLabel("Send message")
      .accessibilityIdentifier("send-dictation")
    }
    .foregroundStyle(OkouColor.foreground)
    .padding(.horizontal, OkouSpace.six)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .sensoryFeedback(.start, trigger: voice.phase == .recording)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Dictation")
    .accessibilityValue(
      Text(Duration.seconds(voice.elapsed).formatted(.time(pattern: .minuteSecond))))
  }
}

/// The system camera; the photo joins the draft like any other attachment.
struct ComposerCamera: UIViewControllerRepresentable {
  static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

  let captured: (URL) -> Void
  @Environment(\.dismiss) private var dismiss

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate,
    UINavigationControllerDelegate
  {
    let parent: ComposerCamera
    init(_ parent: ComposerCamera) { self.parent = parent }

    func imagePickerController(
      _ picker: UIImagePickerController,
      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      if let image = info[.originalImage] as? UIImage,
        let data = image.jpegData(
          compressionQuality: 0.85),
        let url = ComposerCaptureFile.write(data, name: "Photo", extension: "jpg")
      {
        parent.captured(url)
      }
      parent.dismiss()
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
  }
}

/// VisionKit's document camera; the scanned pages join the draft as one PDF.
struct ComposerDocumentScanner: UIViewControllerRepresentable {
  static var isAvailable: Bool { VNDocumentCameraViewController.isSupported }

  let captured: (URL) -> Void
  @Environment(\.dismiss) private var dismiss

  func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
    let scanner = VNDocumentCameraViewController()
    scanner.delegate = context.coordinator
    return scanner
  }

  func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  @MainActor
  final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
    let parent: ComposerDocumentScanner
    init(_ parent: ComposerDocumentScanner) { self.parent = parent }

    func documentCameraViewController(
      _ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
    ) {
      let document = PDFDocument()
      for index in 0..<scan.pageCount {
        if let page = PDFPage(image: scan.imageOfPage(at: index)) {
          document.insert(page, at: document.pageCount)
        }
      }
      if let data = document.dataRepresentation(),
        let url = ComposerCaptureFile.write(data, name: "Scan", extension: "pdf")
      {
        parent.captured(url)
      }
      parent.dismiss()
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
      parent.dismiss()
    }

    func documentCameraViewController(
      _ controller: VNDocumentCameraViewController, didFailWithError error: Error
    ) {
      parent.dismiss()
    }
  }
}

private enum ComposerCaptureFile {
  static func write(_ data: Data, name: String, extension fileExtension: String) -> URL? {
    let stamp = Date.now.formatted(
      .iso8601.year().month().day().time(includingFractionalSeconds: false)
    )
    .replacingOccurrences(of: ":", with: "-")
    let url = FileManager.default.temporaryDirectory
      .appending(path: "\(name) \(stamp).\(fileExtension)")
    do {
      try data.write(to: url, options: .atomic)
      return url
    } catch {
      return nil
    }
  }
}
