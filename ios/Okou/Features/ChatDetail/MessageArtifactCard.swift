import ChatDomain
import SwiftUI

struct MessageArtifactCard: View {
  let resource: ChatArtifact
  let label: String
  let destination: URL?
  let images: [ChatArtifact]
  let imageSources: [String]
  let viewer: MessageArtifactStore
  let loadsContent: Bool
  private struct LoadKey: Hashable {
    let resource: ChatArtifact
    let owner: ObjectIdentifier
    let enabled: Bool
    let retry: Int
  }
  private struct Prepared {
    let key: LoadKey
    let card: MessageArtifactStore.Card?
    let error: String?
  }
  @State private var prepared: Prepared?
  @State private var retry = 0
  @Environment(\.openURL) private var openURL
  @ScaledMetric(relativeTo: .subheadline) private var titleHeight = 42

  private var loadKey: LoadKey {
    LoadKey(
      resource: resource, owner: ObjectIdentifier(viewer), enabled: loadsContent, retry: retry)
  }
  private var card: MessageArtifactStore.Card? { prepared?.key == loadKey ? prepared?.card : nil }
  private var error: String? { prepared?.key == loadKey ? prepared?.error : nil }
  private var artifact: ChatArtifact { card?.artifact ?? resource }
  private var isMedia: Bool { [.image, .video, .html].contains(resource.kind) }
  private var title: String {
    let text = label.trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty || text == "\u{fffc}" ? artifact.filename : text
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        if let destination {
          openURL(destination)
        } else {
          viewer.open(artifact, images: images, imageSources: imageSources)
        }
      } label: {
        VStack(alignment: .leading, spacing: 10) {
          if isMedia {
            ZStack {
              Rectangle().fill(Color(.tertiarySystemFill))
              if let data = card?.thumbnail, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFit()
              } else if error == nil, loadsContent, card == nil {
                ProgressView().accessibilityLabel("Loading result thumbnail")
              } else {
                Image(systemName: artifact.symbol).font(.largeTitle).foregroundStyle(.secondary)
              }
              if artifact.kind == .video {
                Image(systemName: "play.circle.fill").font(.system(size: 42))
                  .symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.55))
              }
            }
            .frame(height: 180).clipped().clipShape(RoundedRectangle(cornerRadius: 10))
          }
          HStack(spacing: 12) {
            if !isMedia {
              Image(systemName: artifact.symbol).font(.title2).foregroundStyle(.secondary).frame(
                width: 32)
            }
            VStack(alignment: .leading, spacing: 3) {
              Text(title).font(.subheadline.weight(.medium)).lineLimit(2)
                .frame(height: titleHeight, alignment: .leading)
              Text(error ?? artifact.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(
                1)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(
              .tertiary)
          }
        }
        .padding(12).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Preview \(title)")
      .accessibilityHint(error ?? artifact.subtitle)
      .contextMenu {
        if error != nil { Button("Retry preview") { retry += 1 } }
      }

    }
    .frame(maxWidth: 400, alignment: .leading)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    .accessibilityIdentifier("generated-result-card")
    .task(id: loadKey) {
      guard loadsContent else { return }
      let key = loadKey
      do {
        let value = try await viewer.card(resource, thumbnail: isMedia)
        guard !Task.isCancelled else { return }
        prepared = Prepared(key: key, card: value, error: nil)
      } catch {
        guard !Task.isCancelled else { return }
        prepared = Prepared(key: key, card: nil, error: MessageArtifactStore.message(for: error))
      }
    }
  }
}

extension ChatArtifact {
  var symbol: String {
    if isHTMLPresentation { return "rectangle.stack" }
    switch kind {
    case .image: return "photo"
    case .video: return "video"
    case .audio: return "waveform"
    case .html: return "globe"
    case .csv, .json: return "tablecells"
    case .pdf, .markdown, .text: return "doc.text"
    case .file:
      switch (filename as NSString).pathExtension.lowercased() {
      case "ppt", "pptx", "key", "odp": return "rectangle.stack"
      case "xls", "xlsx", "numbers", "ods": return "tablecells"
      default: return "doc.text"
      }
    }
  }

  var subtitle: String {
    let format = (filename as NSString).pathExtension.uppercased()
    var parts = [
      isHTMLPresentation
        ? "HTML presentation" : (format.isEmpty ? kind.rawValue.capitalized : format)
    ]
    if let size {
      parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
    }
    return parts.joined(separator: " · ")
  }
}
