import ChatDomain
import Foundation

/// Retained by the workspace's bounded file cache and any active preview/share consumer.
public final class ChatAttachmentFile: Sendable {
  public let url: URL
  public let size: Int
  /// Set only for complete attachment bytes, not a separate preview image.
  public let originalAttachmentID: String?

  init(url: URL, size: Int, originalAttachmentID: String?) {
    self.url = url
    self.size = size
    self.originalAttachmentID = originalAttachmentID
  }

  static func adopt(
    _ temporary: URL, filename: String, originalAttachmentID: String? = nil
  ) throws -> ChatAttachmentFile {
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
      return ChatAttachmentFile(
        url: destination, size: size, originalAttachmentID: originalAttachmentID)
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }

  static func retaining(_ source: URL, filename: String, attachmentID: String) throws
    -> ChatAttachmentFile
  {
    let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    // A separate link keeps draft cleanup from deleting the sent file without duplicating bytes.
    do {
      try FileManager.default.linkItem(at: source, to: temporary)
    } catch {
      try FileManager.default.copyItem(at: source, to: temporary)
    }
    defer { try? FileManager.default.removeItem(at: temporary) }
    return try adopt(temporary, filename: filename, originalAttachmentID: attachmentID)
  }

  deinit { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}
