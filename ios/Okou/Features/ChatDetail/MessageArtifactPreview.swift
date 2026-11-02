import AVKit
import ChatData
import ChatDomain
import QuickLook
import SwiftUI

struct MessageArtifactPreview: View {
  let viewer: MessageArtifactStore
  let markdown: MessageMarkdownCache
  @State private var webError: String?
  @State private var webLoading = true

  var body: some View {
    NavigationStack {
      if let preview = viewer.preview {
        VStack(spacing: 0) {
          content(preview).frame(maxWidth: .infinity, maxHeight: .infinity)
          if let error = preview.downloadError {
            Text(error).font(.caption).foregroundStyle(.secondary).padding(12)
          }
          if let warning = viewer.catalogWarning {
            HStack {
              Text(warning).font(.caption)
              Button("Retry") { viewer.retry() }
            }.foregroundStyle(.secondary).padding(12)
          }
        }
        .navigationTitle(preview.artifact.filename)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { viewer.dismiss() }
          }
          ToolbarItemGroup(placement: .primaryAction) {
            if preview.artifact.kind == .image {
              Button {
                viewer.navigateImage(-1)
              } label: {
                Image(systemName: "chevron.left")
              }
              .disabled(!viewer.canNavigateImage(-1)).accessibilityLabel("Previous image")
              Button {
                viewer.navigateImage(1)
              } label: {
                Image(systemName: "chevron.right")
              }
              .disabled(!viewer.canNavigateImage(1)).accessibilityLabel("Next image")
            }
            if let text = preview.text {
              Button {
                UIPasteboard.general.string = text.text
              } label: {
                Image(systemName: "doc.on.doc")
              }
              .accessibilityLabel("Copy content")
            }
            if preview.file != nil {
              Button {
                viewer.share()
              } label: {
                Image(systemName: "square.and.arrow.up")
              }
              .accessibilityLabel("Share or save to Files")
            } else if preview.isDownloading {
              ProgressView().accessibilityLabel("Downloading file")
            } else {
              Button {
                viewer.downloadForSharing()
              } label: {
                Image(systemName: "arrow.down.to.line")
              }
              .accessibilityLabel("Download file to share or save")
            }
          }
        }
        .onChange(of: preview.id) { _, _ in
          webError = nil
          webLoading = true
        }
      }
    }
    .sheet(
      item: Binding(get: { viewer.sharing }, set: { if $0 == nil { viewer.dismissSharing() } })
    ) { share in
      ArtifactShareSheet(file: share.file) { viewer.dismissSharing() }
    }
  }

  @ViewBuilder private func content(_ preview: MessageArtifactStore.Preview) -> some View {
    if let error = preview.error {
      ContentUnavailableView {
        Label("Unable to open result", systemImage: "doc.badge.ellipsis")
      } description: {
        Text(error)
      } actions: {
        Button("Retry") { viewer.retry() }.buttonStyle(NeutralProminentButtonStyle())
        if case .hostedSite(let url) = preview.artifact.source {
          Link("Open in browser", destination: url)
        }
      }
    } else if let url = preview.contentURL {
      VStack(spacing: 0) {
        if let webError {
          VStack(alignment: .leading, spacing: 8) {
            Text(webError).font(.caption)
            HStack {
              Button("Retry") {
                self.webError = nil
                viewer.retry()
              }
              if case .hostedSite(let url) = preview.artifact.source {
                Link("Open in browser", destination: url)
              }
            }
          }.padding(12)
        }
        ZStack {
          ArtifactWebView(
            url: url,
            didFail: { message, status in
              guard viewer.preview?.id == preview.id else { return }
              if !viewer.renewHTMLSignature(status: status) { webError = message }
            },
            loadingChanged: { value in
              guard viewer.preview?.id == preview.id else { return }
              webLoading = value
            }
          )
          .id(preview.id)
          if webLoading {
            ProgressView("Loading page…").padding(16).background(
              .regularMaterial, in: RoundedRectangle(cornerRadius: 12))
          }
        }
      }
    } else if let text = preview.text {
      ArtifactTextView(
        content: text, kind: preview.artifact.kind, markdown: markdown, baseURL: viewer.webURL)
    } else if let file = preview.file {
      switch preview.artifact.kind {
      case .image:
        if QLPreviewController.canPreview(file.url as NSURL) {
          ArtifactQuickLook(file: file)
        } else {
          unsupported(preview)
        }
      case .video, .audio:
        ArtifactMediaPlayer(file: file)
      default:
        if QLPreviewController.canPreview(file.url as NSURL) {
          ArtifactQuickLook(file: file)
        } else {
          unsupported(preview)
        }
      }
    } else {
      ProgressView("Loading result…").frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private func unsupported(_ preview: MessageArtifactStore.Preview) -> some View {
    ContentUnavailableView {
      Label("Preview unavailable", systemImage: preview.artifact.symbol)
    } description: {
      Text("Share this file or save it to Files to open it in another app.")
    }
  }
}

struct ArtifactQuickLook: UIViewControllerRepresentable {
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

private struct ArtifactMediaPlayer: View {
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
                  .padding(12)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(index.isMultiple(of: 2) ? Color(.secondarySystemBackground) : Color.clear)
          }
        }.padding(16)
      }
      .accessibilityIdentifier("artifact-csv-table")
    } else {
      ScrollView(kind == .markdown ? .vertical : [.horizontal, .vertical]) {
        if kind == .markdown {
          MessageBodyView(
            text: content.text, baseURL: baseURL, markdown: markdown
          )
          .padding(20)
        } else {
          Text(content.text).font(.system(.body, design: .monospaced)).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).padding(20)
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
