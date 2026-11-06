import AVKit
import ChatData
import ChatDomain
import QuickLook
import SwiftUI

/// One presentation surface for uploaded attachments and generated results.
struct MessagePreviewSheet<Content: View, Actions: View>: View {
  let title: String
  let dismiss: () -> Void
  @ViewBuilder var content: () -> Content
  @ViewBuilder var actions: () -> Actions

  var body: some View {
    NavigationStack {
      content()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItemGroup(placement: .topBarTrailing) { actions() }
          ToolbarSpacer(.fixed, placement: .topBarTrailing)
          OkouCloseToolbarItem(action: dismiss)
        }
    }
  }
}

/// Keeps the loaded thumbnail visible while original bytes become available.
struct MessageFilePreview: View {
  let kind: ChatArtifact.Kind
  let symbol: String
  let file: ChatAttachmentFile?
  let thumbnail: UIImage?
  let error: String?
  let canRetry: Bool
  let retry: () -> Void

  var body: some View {
    if let error {
      OkouEmptyState("Unable to open result", icon: "file-warning", description: Text(error)) {
        if canRetry {
          Button("Retry", action: retry)
            .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
      }
    } else if let file {
      if kind == .image {
        MessageImagePreview(file: file, thumbnail: thumbnail)
      } else if kind == .video || kind == .audio {
        MessageFileMediaPlayer(file: file)
      } else if QLPreviewController.canPreview(file.url as NSURL) {
        MessageFileQuickLook(file: file)
      } else {
        OkouEmptyState(
          "Preview unavailable", icon: symbol,
          description: Text("Share this file or save it to Files to open it in another app."))
      }
    } else {
      ZStack(alignment: .bottom) {
        if let thumbnail {
          Image(uiImage: thumbnail).resizable().scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
          OkouLoadingRow("Loading result…").fixedSize()
            .padding(OkouSpace.lg)
        } else {
          OkouLoadingRow("Loading result…").fixedSize()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
  }
}

private struct MessageImagePreview: View {
  let file: ChatAttachmentFile
  let thumbnail: UIImage?
  private struct Prepared {
    let url: URL
    let image: UIImage?
  }
  @State private var prepared: Prepared?

  var body: some View {
    Group {
      if let prepared, prepared.url == file.url {
        if let image = prepared.image {
          MessageZoomableImage(image: image).id(file.url)
        } else if QLPreviewController.canPreview(file.url as NSURL) {
          MessageFileQuickLook(file: file)
        } else {
          OkouEmptyState(
            "Preview unavailable", icon: "image",
            description: Text("Share this file or save it to Files to open it in another app."))
        }
      } else if let thumbnail {
        Image(uiImage: thumbnail).resizable().scaledToFit()
      } else {
        OkouLoadingRow("Loading result…").fixedSize()
      }
    }
    .task(id: file.url) {
      let data = await AttachmentFileImporter.shared.previewImageData(file.url)
      guard !Task.isCancelled else { return }
      prepared = Prepared(url: file.url, image: data.flatMap(UIImage.init(data:)))
    }
  }
}

struct MessageFileQuickLook: UIViewControllerRepresentable {
  let file: ChatAttachmentFile

  func makeCoordinator() -> Coordinator { Coordinator(file) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }
  func updateUIViewController(_ controller: QLPreviewController, context: Context) {
    guard context.coordinator.file.url != file.url else { return }
    context.coordinator.file = file
    controller.reloadData()
  }
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    var file: ChatAttachmentFile
    init(_ file: ChatAttachmentFile) { self.file = file }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> any QLPreviewItem
    {
      file.url as NSURL
    }
  }
}

private struct MessageFileMediaPlayer: View {
  let file: ChatAttachmentFile
  @State private var player: AVPlayer?
  var body: some View {
    VideoPlayer(player: player)
      .task(id: file.url) { player = AVPlayer(url: file.url) }
      .onDisappear {
        player?.pause()
        player = nil
      }
  }
}
