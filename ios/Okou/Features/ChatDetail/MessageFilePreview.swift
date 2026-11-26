import ChatData
import ChatDomain
import QuickLook
import SwiftUI

/// One presentation surface for uploaded attachments and generated results.
struct MessagePreviewSheet<Content: View, Actions: View>: View {
  let title: String
  let dismiss: () -> Void
  let isImage: Bool
  @ViewBuilder var content: () -> Content
  @ViewBuilder var actions: () -> Actions

  var body: some View {
    if isImage {
      ImagePreviewSwipeDismiss(dismiss: dismiss) { navigation }
    } else {
      navigation
    }
  }

  private var navigation: some View {
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
  var imageNavigation: MessageImageNavigation?

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
        MessageImagePreview(file: file, thumbnail: thumbnail, imageNavigation: imageNavigation)
      } else if kind == .video || kind == .audio {
        MessageMediaPlayer(url: file.url, autoplays: kind == .video, retry: retry)
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

struct MessageImagePreview<File: QuickLookPreviewFile>: View {
  let file: File
  let thumbnail: UIImage?
  var imageNavigation: MessageImageNavigation?
  private struct Prepared {
    let url: URL
    let image: UIImage?
    let document: LocalImageDocument?
  }
  @State private var prepared: Prepared?

  var body: some View {
    Group {
      if let prepared, prepared.url == file.url {
        if let image = prepared.image {
          if let imageNavigation {
            MessageImagePager(image: image, navigation: imageNavigation).id(file.url)
          } else {
            MessageZoomableImage(image: image).id(file.url)
          }
        } else if let document = prepared.document {
          MessageWebImage(document: document).id(file.url)
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
      let importer = AttachmentFileImporter.shared
      let data = await importer.previewImageData(file.url)
      guard !Task.isCancelled else { return }
      var image = data.flatMap(UIImage.init(data:))
      let document = image == nil ? await importer.imageDocument(file.url) : nil
      if image == nil, document == nil {
        let cover = await importer.documentCover(
          file.url, size: CGSize(width: 1_024, height: 1_024))
        image = cover.flatMap(UIImage.init(data:))
      }
      guard !Task.isCancelled else { return }
      prepared = Prepared(url: file.url, image: image, document: document)
    }
  }
}

protocol QuickLookPreviewFile {
  var url: URL { get }
}

extension ChatAttachmentFile: QuickLookPreviewFile {}
extension ImportedAttachmentFile: QuickLookPreviewFile {}

struct MessageFileQuickLook<File: QuickLookPreviewFile>: UIViewControllerRepresentable {
  let file: File

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
    var file: File
    init(_ file: File) { self.file = file }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> any QLPreviewItem
    {
      file.url as NSURL
    }
  }
}
