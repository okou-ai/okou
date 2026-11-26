import QuickLook
import SwiftUI

struct ChatAttachmentChips: View {
  let draft: AttachmentDraftStore
  let content: AttachmentDraftStore.Content
  let isDisabled: Bool
  @ScaledMetric(relativeTo: .caption2) private var chipWidth: CGFloat = 240
  @State private var previewURL: URL?
  @State private var previewImage: AttachmentDraftStore.Item?

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: OkouSpace.sm) {
        ForEach(content.items) { item in
          chip { attachment(item) }
        }
        if content.importingCount > 0 {
          chip {
            label(Text("Attachment"), detail: Text("Preparing attachments…"), showsProgress: true)
              .accessibilityElement(children: .combine)
          }
        }
      }
    }
    .scrollIndicators(.hidden)
    .quickLookPreview($previewURL)
    .sheet(item: $previewImage) { item in
      MessagePreviewSheet(title: item.file.filename, dismiss: closeImagePreview, isImage: true) {
        MessageFileQuickLook(file: item.file)
      } actions: {
        ShareLink(item: item.file.url) { OkouToolbarIcon("share") }
          .accessibilityLabel("Share or save to Files")
      }
    }
  }

  private func closeImagePreview() { previewImage = nil }

  private func chip<Content: View>(@ViewBuilder _ body: () -> Content) -> some View {
    body()
      .font(.okou(.caption2))
      .padding(OkouSpace.ten)
      .containerRelativeFrame(.horizontal, alignment: .leading) { availableWidth, _ in
        min(chipWidth, availableWidth)
      }
      .glassEffect(.regular, in: RoundedRectangle(cornerRadius: OkouRadius.control))
  }

  private func attachment(_ item: AttachmentDraftStore.Item) -> some View {
    let status: Text? =
      switch item.state {
      case .waiting: Text("Waiting to upload…")
      case .uploading(let fraction):
        Text("Uploading \(fraction, format: .percent.precision(.fractionLength(0)))")
      case .checking: Text("Checking uploaded file…")
      case .ready, .failed: nil
      }
    let fileSize = ByteCountFormatter.string(
      fromByteCount: Int64(item.file.size), countStyle: .file)
    let detail = status ?? Text(fileSize)
    return VStack(alignment: .leading, spacing: OkouSpace.six) {
      HStack(spacing: OkouSpace.sm) {
        Button {
          guard item.file.url.isFileURL else { return }
          if item.file.contentType.hasPrefix("image/") {
            previewImage = item
          } else {
            previewURL = item.file.url
          }
        } label: {
          label(
            Text(verbatim: item.file.filename), detail: detail, thumbnail: item.file.thumbnail,
            showsProgress: status != nil
          )
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!item.file.url.isFileURL)
        .accessibilityLabel("Preview \(item.file.filename)")
        .accessibilityValue(detail)
        Button {
          draft.remove(item.id)
        } label: {
          OkouToolbarIcon("circle-x").foregroundStyle(OkouColor.mutedForeground)
            .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityLabel("Remove \(item.file.filename)")
      }
      if case .failed(let message) = item.state {
        Text(message).foregroundStyle(OkouColor.destructive).lineLimit(2)
        Button {
          draft.retry(item.id)
        } label: {
          Text("Retry attachment").font(.okou(.caption).weight(.medium))
            .frame(maxWidth: .infinity, minHeight: OkouControl.minimumTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .disabled(isDisabled)
      }
    }
  }

  private func label(
    _ title: Text, detail: Text, thumbnail: Data? = nil, showsProgress: Bool
  ) -> some View {
    HStack(spacing: OkouSpace.sm) {
      Group {
        if let thumbnail, let image = UIImage(data: thumbnail) {
          Image(uiImage: image).resizable().scaledToFill()
        } else {
          OkouIcon("file", size: OkouIconSize.standard).foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .frame(width: 40, height: 40)
      .overlay {
        if showsProgress {
          OkouMediaColor.scrim.opacity(0.55)
            .overlay { ProgressView().controlSize(.small).tint(OkouMediaColor.foreground) }
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: OkouRadius.thumbnail))
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: OkouSpace.two) {
        title.font(.okou(.caption)).truncationMode(.middle)
        detail.foregroundStyle(OkouColor.mutedForeground)
      }
      .lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(minHeight: OkouControl.minimumTarget)
  }
}
