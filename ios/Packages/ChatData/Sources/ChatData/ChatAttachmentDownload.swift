import ChatDomain
import Foundation

/// Owned by a thumbnail operation or presented preview, never by durable history.
public final class ChatAttachmentFile: Sendable {
  public let url: URL
  public let size: Int

  init(url: URL, size: Int) {
    self.url = url
    self.size = size
  }

  static func adopt(_ temporary: URL, filename: String) throws -> ChatAttachmentFile {
    try Task.checkCancellation()
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "OkouMessageFiles/\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      let name = (filename as NSString).lastPathComponent
      let destination = directory.appendingPathComponent(
        name.isEmpty || name == "." || name == ".." || name == "/" ? "Attachment" : name)
      try FileManager.default.moveItem(at: temporary, to: destination)
      guard let size = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize else {
        throw APIClientError.invalidResponse
      }
      try Task.checkCancellation()
      return ChatAttachmentFile(url: destination, size: size)
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }

  deinit { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

struct ChatAttachmentDownload {
  let client: APIClient

  func download(_ attachment: ChatMessageAttachment, thumbnail: Bool) async throws
    -> ChatAttachmentFile?
  {
    // A rejected/expired storage signature gets one fresh authorization lookup, never a stored URL.
    for attempt in 0...1 {
      let resolved: FileURL = try await client.request(
        "/api/web/file-url", query: [URLQueryItem(name: "file_id", value: attachment.downloadID)])
      let url: URL
      if thumbnail {
        if let preview = resolved.previewImageUrl {
          url = preview
        } else if attachment.contentType.hasPrefix("image/") {
          url = resolved.url
        } else {
          return nil
        }
      } else {
        url = resolved.downloadUrl
      }
      do {
        let temporary = try await client.downloadAttachmentBytes(
          url, maximumSize: thumbnail ? 20 * 1024 * 1024 : ChatAttachment.maximumSize)
        defer { try? FileManager.default.removeItem(at: temporary) }
        // Snapshot filenames are display data, never filesystem paths.
        return try ChatAttachmentFile.adopt(temporary, filename: attachment.filename)
      } catch APIClientError.downloadFailed(let status)
        where attempt == 0 && [401, 403].contains(status)
      {
        continue
      }
    }
    throw APIClientError.invalidResponse
  }

  private struct FileURL: Decodable, Sendable {
    let url: URL
    let downloadUrl: URL
    let previewImageUrl: URL?
  }
}
