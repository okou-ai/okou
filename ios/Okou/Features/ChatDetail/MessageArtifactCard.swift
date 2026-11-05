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
  @ScaledMetric(relativeTo: .body) private var informationHeight: CGFloat = 56

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
        VStack(alignment: .leading, spacing: OkouSpace.md) {
          if isMedia {
            ZStack {
              Rectangle().fill(OkouColor.stateHover)
              if let data = card?.thumbnail, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFit()
              } else if error == nil, loadsContent, card == nil {
                ProgressView().accessibilityLabel("Loading result thumbnail")
              } else {
                OkouIcon(artifact.symbol, size: OkouIconSize.mediaOverlay).foregroundStyle(
                  OkouColor.mutedForeground)
              }
              if artifact.kind == .video {
                OkouIcon("circle-play", size: OkouIconSize.mediaOverlay)
                  .foregroundStyle(OkouMediaColor.foreground)
                  .background(OkouMediaColor.scrim.opacity(0.55), in: Circle())
              }
            }
            .frame(height: OkouControl.cardMediaHeight).clipped().clipShape(
              RoundedRectangle(cornerRadius: OkouRadius.control))
          }
          HStack(spacing: OkouSpace.sm) {
            ChatCardHeader(title: title, icon: artifact.symbol, titleLineLimit: 2) {
              Text(error ?? artifact.subtitle).lineLimit(1, reservesSpace: true)
            }
            .frame(height: informationHeight)
            OkouIcon("chevron-right", size: OkouIconSize.inline)
              .foregroundStyle(OkouColor.mutedForeground)
          }
        }
        .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.md)
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Preview \(title)")
      .accessibilityHint(error ?? artifact.subtitle)
      .contextMenu {
        if error != nil { Button("Retry preview") { retry += 1 } }
      }

    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .modifier(ChatCardSurface())
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
        prepared = Prepared(
          key: key, card: nil,
          error: ChatRequestFailure.isTransient(error)
            ? String(localized: "Tap to load preview") : MessageArtifactStore.message(for: error))
      }
    }
  }
}

extension ChatArtifact {
  var symbol: String {
    if isHTMLPresentation { return "layers" }
    switch kind {
    case .image: return "image"
    case .video: return "video"
    case .audio: return "audio-lines"
    case .html: return "globe"
    case .csv, .json: return "table"
    case .pdf, .markdown, .text: return "file-text"
    case .file:
      switch (filename as NSString).pathExtension.lowercased() {
      case "ppt", "pptx", "key", "odp": return "layers"
      case "xls", "xlsx", "numbers", "ods": return "table"
      default: return "file-text"
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
