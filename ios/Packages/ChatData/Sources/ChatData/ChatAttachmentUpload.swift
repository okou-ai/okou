import ChatDomain
import Foundation

public struct ChatAttachment: Codable, Equatable, Sendable {
  public static let maximumSize = 1024 * 1024 * 1024
  public let id: String
  public let filename: String
  public let contentType: String
  public let size: Int
  public let url: String?

  public init(id: String, filename: String, contentType: String, size: Int, url: String? = nil) {
    self.id = id
    self.filename = filename
    self.contentType = contentType
    self.size = size
    self.url = url
  }
}

struct ChatAttachmentUpload {
  let client: APIClient

  func upload(
    file: URL, filename: String, contentType: String,
    progress: @escaping @Sendable (Double) -> Void
  ) async throws -> ChatAttachment {
    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true, let size = values.fileSize else {
      throw ChatError.invalidContract("The selected file could not be read. Select it again.")
    }
    guard size <= ChatAttachment.maximumSize else {
      throw ChatError.invalidContract("File too large (max 1 GB).")
    }
    let prepared: PreparedUpload = try await client.request(
      "/api/uploads/prepare", method: "POST",
      body: JSONEncoder().encode(
        PrepareBody(
          filename: filename, contentType: contentType, size: size,
          multipart: size >= 5 * 1024 * 1024 ? true : nil)))
    if let multipart = prepared.multipart {
      do {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        guard multipart.partSize > 0,
          multipart.parts.count == max(1, (size + multipart.partSize - 1) / multipart.partSize),
          multipart.parts.map(\.partNumber) == Array(1...multipart.parts.count)
        else { throw APIClientError.incompatibleData }
        for part in multipart.parts {
          try Task.checkCancellation()
          let offset = (part.partNumber - 1) * multipart.partSize
          let length = min(multipart.partSize, size - offset)
          guard let data = try handle.read(upToCount: length), data.count == length else {
            throw ChatError.invalidContract("The selected file could not be read. Select it again.")
          }
          try await client.uploadAttachmentBytes(
            data, to: part.uploadUrl, headers: ["Content-Type": prepared.contentType]
          ) { fraction in
            progress((Double(offset) + fraction * Double(length)) / Double(max(size, 1)))
          }
        }
        let completed: CompletedMultipart = try await client.request(
          "/api/uploads/multipart/complete", method: "POST",
          body: JSONEncoder().encode(
            CompleteMultipart(
              id: prepared.id, filename: prepared.filename,
              uploadId: multipart.uploadId, partCount: multipart.parts.count)))
        return ChatAttachment(
          id: completed.id, filename: prepared.filename,
          contentType: prepared.contentType, size: size, url: completed.url)
      } catch {
        // Cancellation must not prevent cleanup of an allocated multipart upload.
        let body = try JSONEncoder().encode(
          AbortMultipart(id: prepared.id, filename: prepared.filename, uploadId: multipart.uploadId)
        )
        _ = await Task {
          try? await client.data(
            "/api/uploads/multipart/abort", method: "POST", body: body)
        }.value
        throw error
      }
    }
    guard let url = prepared.uploadUrl, let headers = prepared.uploadHeaders else {
      throw APIClientError.incompatibleData
    }
    guard size < 5 * 1024 * 1024 else { throw APIClientError.incompatibleData }
    // Small files are bounded below the multipart threshold; large files use one part at a time.
    try await client.uploadAttachmentBytes(
      Data(contentsOf: file), to: url,
      headers: headers.merging(["Content-Type": prepared.contentType]) { signed, _ in signed },
      progress: progress)
    let completed: CompletedUpload = try await client.request(
      "/api/uploads/complete", method: "POST",
      body: JSONEncoder().encode(["id": prepared.id]))
    return ChatAttachment(
      id: completed.id, filename: completed.filename,
      contentType: completed.contentType, size: completed.size, url: completed.url)
  }

  private struct PrepareBody: Encodable {
    let filename: String
    let contentType: String
    let size: Int
    let multipart: Bool?
  }
  private struct PreparedUpload: Decodable, Sendable {
    let id: String
    let filename: String
    let contentType: String
    let uploadUrl: URL?
    let uploadHeaders: [String: String]?
    let multipart: Multipart?
    struct Multipart: Decodable, Sendable {
      let uploadId: String
      let partSize: Int
      let parts: [Part]
    }
    struct Part: Decodable, Sendable {
      let partNumber: Int
      let uploadUrl: URL
    }
  }
  private struct CompletedUpload: Decodable, Sendable {
    let id: String
    let filename: String
    let contentType: String
    let size: Int
    let url: String
  }
  private struct CompletedMultipart: Decodable, Sendable {
    let id: String
    let url: String
  }
  private struct CompleteMultipart: Encodable {
    let id: String
    let filename: String
    let uploadId: String
    let partCount: Int
  }
  private struct AbortMultipart: Encodable {
    let id: String
    let filename: String
    let uploadId: String
  }
}
