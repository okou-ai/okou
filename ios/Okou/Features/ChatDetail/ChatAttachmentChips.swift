import QuickLook
import SwiftUI

struct ChatAttachmentChips: View {
  let draft: AttachmentDraftStore
  /// The composer graph's items for this render; actions go to `draft`.
  let items: [AttachmentDraftStore.Item]
  let isDisabled: Bool
  @ScaledMetric(relativeTo: .caption2) private var chipWidth: CGFloat = 240
  @State private var previewURL: URL?

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: OkouSpace.sm) {
        ForEach(items) { item in
          let fileSize = ByteCountFormatter.string(
            fromByteCount: Int64(item.file.size), countStyle: .file)
          VStack(alignment: .leading, spacing: OkouSpace.six) {
            HStack(spacing: OkouSpace.sm) {
              Button {
                if item.file.url.isFileURL { previewURL = item.file.url }
              } label: {
                HStack(spacing: OkouSpace.sm) {
                  if let data = item.file.thumbnail, let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFill()
                      .frame(width: 40, height: 40).clipped()
                      .clipShape(RoundedRectangle(cornerRadius: OkouRadius.thumbnail))
                  } else {
                    OkouIcon("file", size: OkouIconSize.standard)
                      .frame(width: 40, height: 40).foregroundStyle(OkouColor.mutedForeground)
                  }
                  VStack(alignment: .leading, spacing: OkouSpace.two) {
                    Text(item.file.filename)
                      .font(.okou(.caption))
                      .truncationMode(.middle)
                    Text(fileSize)
                      .foregroundStyle(OkouColor.mutedForeground)
                  }
                  .lineLimit(1)
                  .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: OkouControl.minimumTarget)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .disabled(!item.file.url.isFileURL)
              .accessibilityLabel("Preview \(item.file.filename)")
              .accessibilityValue(fileSize)
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
            switch item.state {
            case .waiting:
              Text("Waiting to upload…").foregroundStyle(OkouColor.mutedForeground)
            case .uploading(let fraction):
              ProgressView(value: fraction)
                .accessibilityLabel("Uploading \(item.file.filename)")
            case .checking:
              Text("Checking uploaded file…").foregroundStyle(OkouColor.mutedForeground)
            case .ready:
              EmptyView()
            case .failed(let message):
              Text(message).foregroundStyle(OkouColor.destructive).lineLimit(2)
              Button {
                draft.retry(item.id)
              } label: {
                Text("Retry attachment").font(.okou(.caption).weight(.medium))
                  .frame(
                    maxWidth: .infinity, minHeight: OkouControl.minimumTarget, alignment: .leading
                  )
                  .contentShape(Rectangle())
              }
              .disabled(isDisabled)
            }
          }
          .font(.okou(.caption2))
          .padding(OkouSpace.ten)
          .frame(width: chipWidth, alignment: .leading)
          .glassEffect(.regular, in: RoundedRectangle(cornerRadius: OkouRadius.control))
        }
      }
    }
    .scrollIndicators(.hidden)
    .quickLookPreview($previewURL)
  }
}
