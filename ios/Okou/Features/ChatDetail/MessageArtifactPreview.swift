import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

struct MessageArtifactPreview: View {
  let viewer: MessageArtifactStore
  let markdown: MessageMarkdownCache

  var body: some View {
    Group {
      if let preview = viewer.preview {
        StoreProvider(preview.store) {
          if preview.loadsMetadata {
            ArtifactMetadataPreview(viewer: viewer, preview: preview, markdown: markdown)
          } else {
            ArtifactPreviewContent(viewer: viewer, preview: preview, markdown: markdown)
          }
        }
        .id(preview.id)
      }
    }
    .sheet(
      item: Binding(get: { viewer.sharing }, set: { if $0 == nil { viewer.dismissSharing() } })
    ) { share in
      ArtifactShareSheet(file: share.file) { viewer.dismissSharing() }
    }
  }
}

private struct ArtifactMetadataPreview: View {
  let viewer: MessageArtifactStore
  let preview: MessageArtifactPreviewRead
  let markdown: MessageMarkdownCache
  @LoadableValue private var catalog: Loadable<[ChatArtifact]>

  init(
    viewer: MessageArtifactStore, preview: MessageArtifactPreviewRead,
    markdown: MessageMarkdownCache
  ) {
    self.viewer = viewer
    self.preview = preview
    self.markdown = markdown
    _catalog = LoadableValue(task: preview.reads.catalog, keepLast: true)
  }

  var body: some View {
    ArtifactPreviewContent(viewer: viewer, preview: preview, markdown: markdown, catalog: catalog)
  }
}

private struct ArtifactPreviewContent: View {
  let viewer: MessageArtifactStore
  let preview: MessageArtifactPreviewRead
  let markdown: MessageMarkdownCache
  let catalog: Loadable<[ChatArtifact]>?
  @LoadableValue private var value: Loadable<MessageArtifactPreviewRead.Content>
  @LoadableValue private var download: Loadable<ChatAttachmentFile?>
  @State private var webError: String?
  @State private var webLoading = true
  // Only the adjacent raster covers needed by UIKit's transient paging surface.
  // The shared card resources retain ownership of their requests and errors.
  @State private var imageCovers: [Int: Data] = [:]

  init(
    viewer: MessageArtifactStore, preview: MessageArtifactPreviewRead,
    markdown: MessageMarkdownCache,
    catalog: Loadable<[ChatArtifact]>? = nil
  ) {
    self.viewer = viewer
    self.preview = preview
    self.markdown = markdown
    self.catalog = catalog
    _value = LoadableValue(task: preview.value)
    _download = LoadableValue(task: preview.download)
  }

  private var artifact: ChatArtifact {
    preview.reads.metadata(value.data?.artifact ?? preview.artifact)
  }

  var body: some View {
    MessagePreviewSheet(title: artifact.filename, dismiss: viewer.dismiss) {
      VStack(spacing: 0) {
        content.frame(maxWidth: .infinity, maxHeight: .infinity)
        if let error = download.error {
          Text(MessageArtifactStore.message(for: error))
            .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground).padding(OkouSpace.md)
        }
        if let catalog {
          ArtifactCatalogWarning(catalog: catalog, retry: viewer.refreshDetails)
        }
      }
      .task(id: value.data?.artifact.id) { await prepareImageCovers() }
    } actions: {
      if artifact.kind == .image {
        Button {
          if let content = value.data {
            viewer.navigateImage(-1, content: content, previewID: preview.id)
          }
        } label: {
          OkouToolbarIcon("chevron-left")
        }
        .disabled(value.data?.image(-1) == nil).accessibilityLabel("Previous image")
        Button {
          if let content = value.data {
            viewer.navigateImage(1, content: content, previewID: preview.id)
          }
        } label: {
          OkouToolbarIcon("chevron-right")
        }
        .disabled(value.data?.image(1) == nil).accessibilityLabel("Next image")
      }
      if let text = value.data?.text {
        Button {
          UIPasteboard.general.string = text.text
        } label: {
          OkouToolbarIcon("copy")
        }
        .accessibilityLabel("Copy content")
      }
      if let file = (download.data ?? nil) ?? value.data?.file {
        Button {
          viewer.share(file, previewID: preview.id)
        } label: {
          OkouToolbarIcon("share")
        }
        .accessibilityLabel("Share or save to Files")
      } else if case .loading = download {
        ProgressView().accessibilityLabel("Downloading file")
      } else {
        Button {
          viewer.downloadForSharing(previewID: preview.id, retry: download.error != nil)
        } label: {
          OkouToolbarIcon("download")
        }
        .accessibilityLabel("Download file to share or save")
      }
    }
  }

  @ViewBuilder private var content: some View {
    switch value {
    case .hasError(let error):
      OkouEmptyState(
        "Unable to open result", icon: "file-warning",
        description: Text(MessageArtifactStore.message(for: error))
      ) {
        if ChatRequestFailure.canRetry(error) {
          Button("Retry") { viewer.retry() }
            .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
        if case .hostedSite(let url) = artifact.source {
          Link("Open in browser", destination: url)
            .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
      }
    case .hasData(let content):
      resolvedContent(content)
    case .loading:
      if artifact.kind == .video {
        MessageMediaPlayer(url: nil, autoplays: true, retry: viewer.retry)
      } else {
        fileContent(nil)
      }
    }
  }

  @ViewBuilder private func resolvedContent(_ content: MessageArtifactPreviewRead.Content)
    -> some View
  {
    if content.artifact.kind == .video {
      MessageMediaPlayer(url: content.contentURL, autoplays: true, retry: viewer.retry)
    } else if let url = content.contentURL {
      VStack(spacing: 0) {
        if let webError {
          OkouLoadErrorRow(message: webError, actionTitle: "Retry") {
            self.webError = nil
            viewer.retry()
          }
          .padding(.horizontal, OkouSpace.lg)
        }
        ZStack {
          ArtifactWebView(
            url: url,
            didFail: { message, status in
              guard viewer.preview?.id == preview.id else { return }
              if !viewer.renewHTMLSignature(status: status, content: content, previewID: preview.id)
              {
                webError = message
              }
            },
            loadingChanged: { value in
              guard viewer.preview?.id == preview.id else { return }
              webLoading = value
            }
          )
          .id(preview.id)
          if webLoading {
            OkouLoadingRow("Loading page…")
              .fixedSize()
              .padding(.horizontal, OkouSpace.lg)
              .modifier(OkouFloatingPanelStyle(radius: OkouRadius.control))
          }
        }
      }
    } else if let text = content.text {
      ArtifactTextView(
        content: text, kind: artifact.kind, markdown: markdown, baseURL: viewer.webURL)
    } else {
      fileContent(content.file)
    }
  }

  private func fileContent(_ file: ChatAttachmentFile?) -> some View {
    MessageFilePreview(
      kind: artifact.kind, symbol: artifact.symbol, file: file,
      thumbnail: preview.thumbnail.flatMap(UIImage.init(data:)), error: nil,
      canRetry: true, retry: viewer.retry,
      imageNavigation: imageNavigation)
  }

  private var imageNavigation: MessageImageNavigation? {
    guard let content = value.data, artifact.kind == .image,
      content.image(-1) != nil || content.image(1) != nil
    else { return nil }
    return MessageImageNavigation(
      canGoPrevious: content.image(-1) != nil, canGoNext: content.image(1) != nil,
      previous: imageCovers[-1].flatMap(UIImage.init(data:)),
      next: imageCovers[1].flatMap(UIImage.init(data:)),
      select: { direction in
        viewer.navigateImage(
          direction, content: content, previewID: preview.id, thumbnail: imageCovers[direction])
      })
  }

  private func prepareImageCovers() async {
    guard let content = value.data, content.artifact.kind == .image else { return }
    async let previous: Void = prepareImageCover(-1, content: content)
    async let next: Void = prepareImageCover(1, content: content)
    _ = await (previous, next)
  }

  private func prepareImageCover(_ direction: Int, content: MessageArtifactPreviewRead.Content)
    async
  {
    guard let image = content.image(direction) else { return }
    do {
      let card = try await viewer.card(image, thumbnail: true)
      guard !Task.isCancelled, viewer.preview?.id == preview.id else { return }
      if let cover = card.thumbnail { imageCovers[direction] = cover }
    } catch {
      // A cover is optional; selecting the page still uses the normal preview/error path.
    }
  }

}

private struct ArtifactCatalogWarning: View {
  let catalog: Loadable<[ChatArtifact]>
  let retry: @MainActor () -> Void

  var body: some View {
    if let error = catalog.error,
      (error as? APIClientError)?.statusCode != 401,
      (error as? APIClientError)?.statusCode != 426
    {
      DisclosureGroup("File details unavailable") {
        Text("Some file details could not be loaded.").font(.okou(.caption))
        Button("Refresh file details", action: retry)
      }.font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground).padding(OkouSpace.md)
    }
  }
}

private struct ArtifactTextView: View {
  let content: ArtifactTextContent
  let kind: ChatArtifact.Kind
  let markdown: MessageMarkdownCache
  let baseURL: URL

  var body: some View {
    if let rows = content.rows {
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
            HStack(alignment: .top, spacing: 0) {
              ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                Text(cell).font(index == 0 ? .subheadline.weight(.semibold) : .subheadline)
                  .textSelection(.enabled).frame(width: 180, alignment: .leading)
                  .padding(OkouSpace.md)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(index.isMultiple(of: 2) ? OkouColor.stateHover : Color.clear)
          }
        }.padding(OkouSpace.lg)
      }
      .accessibilityIdentifier("artifact-csv-table")
    } else {
      ScrollView(kind == .markdown ? .vertical : [.horizontal, .vertical]) {
        if kind == .markdown {
          MessageBodyView(
            text: content.text, baseURL: baseURL, markdown: markdown
          )
          .padding(OkouSpace.xl)
        } else {
          Text(content.text).font(.okou(.body, design: .monospaced)).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).padding(OkouSpace.xl)
        }
      }
      .accessibilityIdentifier("artifact-text-reader")
    }
  }
}

private struct ArtifactShareSheet: UIViewControllerRepresentable {
  let file: ChatAttachmentFile
  let didFinish: @MainActor () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(file: file) }
  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: [file.url], applicationActivities: nil)
    controller.completionWithItemsHandler = { _, _, _, _ in didFinish() }
    return controller
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}

  final class Coordinator {
    // Keep bytes alive throughout the system's asynchronous file handoff.
    let file: ChatAttachmentFile
    init(file: ChatAttachmentFile) { self.file = file }
  }
}
