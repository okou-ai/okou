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
          MessageArtifactPreviewContent(viewer: viewer, preview: preview, markdown: markdown)
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

private struct MessageArtifactPreviewContent: View {
  let viewer: MessageArtifactStore
  let preview: MessageArtifactStore.Preview
  let markdown: MessageMarkdownCache
  @LoadableValue private var resolution: Loadable<MessageArtifactStore.Preview.Resolution>
  @LoadableValue private var value: Loadable<MessageArtifactStore.Preview.Content>
  @LoadableValue private var download: Loadable<ChatAttachmentFile?>
  @LoadableValue private var catalog: Loadable<[ChatArtifact]>
  // WebKit owns navigation, its progress and navigation errors, independently of the read.
  @State private var webError: String?
  @State private var webLoading = true

  init(
    viewer: MessageArtifactStore, preview: MessageArtifactStore.Preview,
    markdown: MessageMarkdownCache
  ) {
    self.viewer = viewer
    self.preview = preview
    self.markdown = markdown
    _resolution = LoadableValue(task: preview.resolution)
    _value = LoadableValue(task: preview.content)
    _download = LoadableValue(task: preview.download)
    _catalog = LoadableValue(task: preview.catalog, keepLast: true)
  }

  private var artifact: ChatArtifact {
    let artifact = value.data?.artifact ?? resolution.data?.artifact ?? preview.artifact
    guard let details = catalog.data?.first(where: { $0.id == artifact.id }) else {
      return artifact
    }
    return ChatArtifact(
      source: artifact.source, filename: details.filename, contentType: details.contentType,
      size: details.size, artifactKind: details.artifactKind)
  }

  var body: some View {
    MessagePreviewSheet(title: artifact.filename, dismiss: viewer.dismiss) {
      VStack(spacing: 0) {
        content.frame(maxWidth: .infinity, maxHeight: .infinity)
        if let error = download.error {
          Text(MessageArtifactStore.message(for: error))
            .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground).padding(OkouSpace.md)
        }
        if let error = catalog.error,
          (error as? APIClientError)?.statusCode != 401,
          (error as? APIClientError)?.statusCode != 426
        {
          DisclosureGroup("File details unavailable") {
            Text("Some file details could not be loaded.").font(.okou(.caption))
            Button("Refresh file details") { viewer.refreshDetails() }
          }.font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground).padding(OkouSpace.md)
        }
      }
    } actions: {
      if artifact.kind == .image {
        Button {
          viewer.navigateImage(-1, resolution: resolution.data)
        } label: {
          OkouToolbarIcon("chevron-left")
        }
        .disabled(!viewer.canNavigateImage(-1, resolution: resolution.data)).accessibilityLabel(
          "Previous image")
        Button {
          viewer.navigateImage(1, resolution: resolution.data)
        } label: {
          OkouToolbarIcon("chevron-right")
        }
        .disabled(!viewer.canNavigateImage(1, resolution: resolution.data)).accessibilityLabel(
          "Next image")
      }
      if let text = value.data?.text {
        Button {
          UIPasteboard.general.string = text.text
        } label: {
          OkouToolbarIcon("copy")
        }
        .accessibilityLabel("Copy content")
      }
      if let file = download.data.flatMap { $0 } ?? value.data?.file {
        Button {
          viewer.share(file, previewID: preview.id)
        } label: {
          OkouToolbarIcon("share")
        }
        .accessibilityLabel("Share or save to Files")
      } else if download.state == .loading {
        ProgressView().accessibilityLabel("Downloading file")
      } else {
        Button {
          viewer.downloadForSharing()
        } label: {
          OkouToolbarIcon("download")
        }
        .accessibilityLabel("Download file to share or save")
      }
    }
  }

  @ViewBuilder private var content: some View {
    if let error = value.error {
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
    } else if let resolved = value.data, let url = resolved.contentURL {
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
              if !viewer.renewHTMLSignature(status: status, content: resolved) {
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
    } else if let text = value.data?.text {
      ArtifactTextView(
        content: text, kind: artifact.kind, markdown: markdown, baseURL: viewer.webURL)
    } else {
      MessageFilePreview(
        kind: artifact.kind, symbol: artifact.symbol, file: value.data?.file,
        thumbnail: preview.thumbnail.flatMap(UIImage.init(data:)), error: nil,
        canRetry: true, retry: viewer.retry)
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
