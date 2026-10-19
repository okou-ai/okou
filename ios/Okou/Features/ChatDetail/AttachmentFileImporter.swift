import ChatData
import ChatDomain
import CoreTransferable
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct ImportedAttachmentFile: Transferable, Sendable {
  let url: URL
  let filename: String
  let contentType: String
  let size: Int
  let thumbnail: Data?

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      try await AttachmentFileImporter.shared.copy(received.file)
    }
    FileRepresentation(importedContentType: .movie) { received in
      try await AttachmentFileImporter.shared.copy(received.file)
    }
  }

  func remove() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

/// Copy provider-owned URLs while access is granted; file IO and thumbnail decoding stay off main.
actor AttachmentFileImporter {
  static let shared = AttachmentFileImporter()

  func copy(_ source: URL) throws -> ImportedAttachmentFile {
    try Task.checkCancellation()
    let access = source.startAccessingSecurityScopedResource()
    defer { if access { source.stopAccessingSecurityScopedResource() } }
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "OkouAttachments/\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      var result: ImportedAttachmentFile?
      var failure: Error?
      var coordinationError: NSError?
      NSFileCoordinator().coordinate(readingItemAt: source, error: &coordinationError) { url in
        do {
          let values = try url.resourceValues(forKeys: [
            .isRegularFileKey, .fileSizeKey, .contentTypeKey,
          ])
          guard values.isRegularFile == true else {
            throw ChatError.invalidContract("Choose a file rather than a folder.")
          }
          guard let size = values.fileSize, size <= ChatAttachment.maximumSize else {
            throw ChatError.invalidContract("File too large (max 1 GB).")
          }
          let filename = source.lastPathComponent
          guard !filename.isEmpty, filename.utf16.count <= 255 else {
            throw ChatError.invalidContract(
              "The filename is too long. Rename the file and try again.")
          }
          let destination = directory.appendingPathComponent(filename)
          try FileManager.default.copyItem(at: url, to: destination)
          let type = values.contentType ?? UTType(filenameExtension: destination.pathExtension)
          result = ImportedAttachmentFile(
            url: destination, filename: filename,
            contentType: type?.preferredMIMEType ?? "application/octet-stream",
            size: size, thumbnail: type?.conforms(to: .image) == true ? thumbnail(destination) : nil
          )
        } catch { failure = error }
      }
      if let failure { throw failure }
      if let coordinationError { throw coordinationError }
      try Task.checkCancellation()
      guard let result else { throw CocoaError(.fileReadUnknown) }
      return result
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }

  private func thumbnail(_ url: URL) -> Data? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceThumbnailMaxPixelSize: 160,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    else { return nil }
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
  }
}
