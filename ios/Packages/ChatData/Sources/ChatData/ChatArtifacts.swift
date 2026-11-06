import ChatDomain
import Foundation

/// Temporary, authorized addresses; never encoded into chat history or the durable cache.
public struct ChatArtifactResolution: Sendable {
  public let artifact: ChatArtifact
  public let contentURL: URL
  public let downloadURL: URL
  public let previewImageURL: URL?
  public let expiresAt: Date?
  /// Canonical identity supplied by the authority, including files reached through a reference.
  public var fileID: String? = nil
}

/// Read-only artifact access through the existing API and credential-free storage transport.
public struct ChatArtifacts: Sendable {
  private let client: APIClient
  private let files = ChatFileCache()
  public var apiURL: URL { client.baseURL }
  init(client: APIClient) { self.client = client }

  public func list(threadID: String, webURL: URL) async throws -> [ChatArtifact] {
    let response: Catalog = try await client.request("/api/chat-threads/\(threadID)/artifacts")
    return response.runs.flatMap(\.files).compactMap { file in
      guard let parsed = ChatArtifactReference.parse(file.url, webURL: webURL, apiURL: apiURL)
      else { return nil }
      return ChatArtifact(
        source: parsed.source, filename: file.filename, contentType: file.contentType,
        size: file.size, artifactKind: file.artifactKind)
    }
  }

  public func resolve(_ artifact: ChatArtifact) async throws -> ChatArtifactResolution {
    switch artifact.source {
    case .reference(let reference, let fragment):
      let response: ReferenceResponse = try await client.request(
        "/api/artifact-references/\(reference)")
      var components = URLComponents(url: response.url, resolvingAgainstBaseURL: false)
      if !fragment.isEmpty { components?.fragment = fragment }
      guard let contentURL = components?.url else { throw APIClientError.invalidURL }
      return ChatArtifactResolution(
        artifact: ChatArtifact(
          source: artifact.source, filename: response.filename, contentType: response.contentType,
          size: artifact.size, artifactKind: artifact.artifactKind),
        contentURL: contentURL, downloadURL: response.downloadUrl,
        previewImageURL: response.previewImageUrl, expiresAt: response.expiresAt,
        fileID: response.target?.kind == "file" ? response.target?.id : nil)
    case .file(let id):
      let response: FileResponse = try await client.request(
        "/api/web/file-url", query: [URLQueryItem(name: "file_id", value: id)])
      return ChatArtifactResolution(
        artifact: artifact, contentURL: response.url, downloadURL: response.downloadUrl,
        previewImageURL: response.previewImageUrl, expiresAt: response.expiresAt, fileID: id)
    case .hostedSite(let url):
      guard let hostname = url.host, let slug = hostname.split(separator: ".").first,
        let source = URLComponents(url: url, resolvingAgainstBaseURL: false)
      else { throw APIClientError.invalidURL }
      let response: SitePreviewResponse = try await client.request(
        "/api/host/sites/\(slug)/preview", query: [URLQueryItem(name: "hostname", value: hostname)])
      var contentURL = url
      if response.expiresAt != nil {
        guard var preview = URLComponents(url: response.url, resolvingAgainstBaseURL: false) else {
          throw APIClientError.invalidURL
        }
        preview.percentEncodedPath = source.percentEncodedPath
        preview.percentEncodedQuery = source.percentEncodedQuery
        preview.percentEncodedFragment = source.percentEncodedFragment
        guard let resolved = preview.url else { throw APIClientError.invalidURL }
        contentURL = resolved
      }
      return ChatArtifactResolution(
        artifact: artifact, contentURL: contentURL, downloadURL: contentURL,
        previewImageURL: response.previewImageUrl, expiresAt: response.expiresAt)
    case .published(let url):
      return ChatArtifactResolution(
        artifact: artifact, contentURL: url, downloadURL: url, previewImageURL: nil, expiresAt: nil)
    }
  }

  public func download(_ artifact: ChatArtifact, maximumSize: Int = ChatAttachment.maximumSize)
    async throws -> (ChatArtifact, ChatAttachmentFile)
  {
    try Task.checkCancellation()
    if let file = files.file(for: artifact.id, uploadedOnly: true) {
      try checkSize(file, maximumSize: maximumSize)
      return (artifact, file)
    }
    let resolved = try await resolve(artifact)
    return try await download(resolved, maximumSize: maximumSize)
  }

  /// Consume the authorization already obtained by the preview; renew only on a rejected signature.
  public func download(
    _ resolution: ChatArtifactResolution, maximumSize: Int = ChatAttachment.maximumSize
  ) async throws -> (ChatArtifact, ChatAttachmentFile) {
    var resolved = resolution
    for attempt in 0...1 {
      try Task.checkCancellation()
      let key = resolved.fileID.map(ChatArtifact.Source.file) ?? resolved.artifact.id
      if let cached = files.file(for: key) {
        try checkSize(cached, maximumSize: maximumSize)
        return (resolved.artifact, cached)
      }
      do {
        let file = try await download(
          resolved.downloadURL, filename: resolved.artifact.filename, maximumSize: maximumSize,
          attachmentID: resolved.fileID)
        try Task.checkCancellation()
        files.insert(file, for: key)
        return (resolved.artifact, file)
      } catch APIClientError.downloadFailed(let status)
        where attempt == 0 && [401, 403].contains(status)
        && resolved.artifact.source.requiresAuthorization
      {
        // Renew once through the authority, rather than reusing an expired storage signature.
        resolved = try await resolve(resolved.artifact)
      }
    }
    throw APIClientError.invalidResponse
  }

  public func thumbnail(_ artifact: ChatArtifact, webURL: URL) async throws -> (
    ChatArtifact, ChatAttachmentFile?
  ) {
    try Task.checkCancellation()
    if let file = files.file(for: artifact.id, uploadedOnly: true) { return (artifact, file) }
    for attempt in 0...1 {
      let resolved = try await resolve(artifact)
      let key = resolved.fileID.map(ChatArtifact.Source.file) ?? resolved.artifact.id
      if let cached = files.file(for: key), resolved.artifact.kind == .image {
        return (resolved.artifact, cached)
      }
      let url: URL
      if let preview = resolved.previewImageURL {
        if let source = ChatArtifactReference.parse(
          preview.absoluteString, webURL: webURL, apiURL: apiURL)
        {
          url = try await resolve(source).contentURL
        } else {
          // This URL came from the authenticated authority, not from message markup.
          url = preview
        }
      } else if resolved.artifact.kind == .image {
        url = resolved.contentURL
      } else {
        return (resolved.artifact, nil)
      }
      do {
        let isOriginal = resolved.previewImageURL == nil && resolved.artifact.kind == .image
        let file = try await download(
          url, filename: isOriginal ? resolved.artifact.filename : "thumbnail",
          maximumSize: 20 * 1024 * 1024, attachmentID: isOriginal ? resolved.fileID : nil)
        try Task.checkCancellation()
        if isOriginal { files.insert(file, for: key) }
        return (resolved.artifact, file)
      } catch APIClientError.downloadFailed(let status)
        where attempt == 0 && [401, 403].contains(status) && artifact.source.requiresAuthorization
      { continue }
    }
    throw APIClientError.invalidResponse
  }

  /// Only bytes selected on this device may open without another remote authorization lookup.
  public func uploadedFile(_ artifact: ChatArtifact) -> ChatAttachmentFile? {
    files.file(for: artifact.id, uploadedOnly: true)
  }

  func retainUpload(_ file: ChatAttachmentFile, id: String) {
    files.insert(file, for: .file(id), uploaded: true)
  }

  public func closeFileCache() { files.close() }

  private func checkSize(_ file: ChatAttachmentFile, maximumSize: Int) throws {
    if file.size > maximumSize { throw URLError(.dataLengthExceedsMaximum) }
  }

  private func download(
    _ url: URL, filename: String, maximumSize: Int, attachmentID: String? = nil
  ) async throws
    -> ChatAttachmentFile
  {
    let temporary = try await client.downloadAttachmentBytes(url, maximumSize: maximumSize)
    defer { try? FileManager.default.removeItem(at: temporary) }
    return try ChatAttachmentFile.adopt(
      temporary, filename: filename, originalAttachmentID: attachmentID)
  }

  private struct ReferenceResponse: Decodable, Sendable {
    let url: URL
    let downloadUrl: URL
    let filename: String
    let contentType: String
    let previewImageUrl: URL?
    let expiresAt: Date?
    let target: Target?

    struct Target: Decodable, Sendable {
      let kind: String
      let id: String
    }
  }
  private struct FileResponse: Decodable, Sendable {
    let url: URL
    let downloadUrl: URL
    let previewImageUrl: URL?
    let expiresAt: Date?
  }
  private struct SitePreviewResponse: Decodable, Sendable {
    let url: URL
    let expiresAt: Date?
    let previewImageUrl: URL?
  }
  private struct Catalog: Decodable, Sendable {
    let runs: [Run]
    struct Run: Decodable, Sendable {
      let files: [File]
    }
    struct File: Decodable, Sendable {
      let url: String
      let filename: String
      let contentType: String
      let size: Int
      let artifactKind: String?
    }
  }
}

extension ChatArtifact.Source {
  fileprivate var requiresAuthorization: Bool {
    switch self {
    case .reference, .file, .hostedSite: true
    case .published: false
    }
  }
}
