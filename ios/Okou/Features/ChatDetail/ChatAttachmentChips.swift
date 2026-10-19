import QuickLook
import SwiftUI

struct ChatAttachmentChips: View {
  let draft: AttachmentDraftStore
  let isDisabled: Bool
  @State private var previewURL: URL?

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 8) {
        ForEach(draft.items) { item in
          VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
              Button {
                previewURL = item.file.url
              } label: {
                HStack(spacing: 8) {
                  if let data = item.file.thumbnail, let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFill()
                      .frame(width: 40, height: 40).clipped()
                      .clipShape(RoundedRectangle(cornerRadius: 6))
                  } else {
                    Image(systemName: "doc.fill").font(.title2)
                      .frame(width: 40, height: 40).foregroundStyle(.secondary)
                  }
                  Text(item.file.filename).font(.caption).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Preview \(item.file.filename)")
              Button {
                draft.remove(item.id)
              } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                  .frame(width: 44, height: 44)
              }
              .buttonStyle(.plain)
              .disabled(isDisabled)
              .accessibilityLabel("Remove \(item.file.filename)")
            }
            switch item.state {
            case .waiting:
              Text("Waiting to upload…").foregroundStyle(.secondary)
            case .uploading(let fraction):
              ProgressView(value: fraction)
                .accessibilityLabel("Uploading \(item.file.filename)")
            case .ready:
              Text(
                ByteCountFormatter.string(fromByteCount: Int64(item.file.size), countStyle: .file)
              )
              .foregroundStyle(.secondary)
            case .failed(let message):
              Text(message).foregroundStyle(.red).lineLimit(2)
              Button("Retry upload") { draft.retry(item.id) }.disabled(isDisabled)
            }
          }
          .font(.caption2)
          .padding(10)
          .frame(width: 240, alignment: .leading)
          .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        }
      }
    }
    .scrollIndicators(.hidden)
    .quickLookPreview($previewURL)
  }
}
