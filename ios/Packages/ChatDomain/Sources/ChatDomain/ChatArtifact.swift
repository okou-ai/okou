import Foundation

/// Stable transcript resource identity. Temporary access URLs live only in the data layer.
public struct ChatArtifact: Equatable, Hashable, Sendable, Identifiable {
  public enum Source: Equatable, Hashable, Sendable {
    case reference(String, fragment: String)
    case file(String)
    case hostedSite(URL)
    case published(URL)
  }

  public enum Kind: String, Sendable {
    case image, video, audio, markdown, text, json, csv, pdf, html, file
  }

  public let source: Source
  public let filename: String
  public let contentType: String?
  public let size: Int?
  public let artifactKind: String?
  public var id: Source {
    switch source {
    case .reference(let reference, _):
      return .reference(String(reference.split(separator: ".")[0]), fragment: "")
    default: return source
    }
  }

  public init(
    source: Source, filename: String, contentType: String? = nil, size: Int? = nil,
    artifactKind: String? = nil
  ) {
    self.source = source
    self.filename = filename
    self.contentType = contentType
    self.size = size
    self.artifactKind = artifactKind
  }

  public var kind: Kind {
    let type =
      (contentType ?? "").split(separator: ";").first.map(String.init)?
      .trimmingCharacters(in: .whitespaces).lowercased() ?? ""
    if type.hasPrefix("image/") { return .image }
    if type.hasPrefix("video/") { return .video }
    if type.hasPrefix("audio/") { return .audio }
    switch type {
    case "text/markdown", "text/x-markdown": return .markdown
    case "text/plain", "text/tab-separated-values", "text/xml", "text/yaml", "text/x-yaml",
      "application/xml", "application/yaml", "application/x-yaml":
      return .text
    case "application/json": return .json
    case "text/csv": return .csv
    case "application/pdf": return .pdf
    case "text/html": return .html
    default: break
    }
    switch (filename as NSString).pathExtension.lowercased() {
    case "md": return .markdown
    case "txt", "log", "xml", "yaml", "yml", "tsv": return .text
    case "json": return .json
    case "csv": return .csv
    case "pdf": return .pdf
    case "html", "htm": return .html
    case "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif",
      "tif", "tiff", "psd":
      return .image
    case "mp4", "webm", "mov", "ogv": return .video
    case "mp3", "wav", "wave", "m4a", "aac", "ogg", "oga", "opus", "flac", "mpga":
      return .audio
    default: return .file
    }
  }

  public var isHTMLPresentation: Bool { kind == .html && artifactKind == "presentation-html" }
}
