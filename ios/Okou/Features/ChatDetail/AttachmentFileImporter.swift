import ChatData
import ChatDomain
import CoreTransferable
import Foundation
import ImageIO
import Synchronization
import UniformTypeIdentifiers

struct ImportedAttachmentFile: Codable, Equatable, Transferable, Sendable {
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

  func remove() {
    guard url.isFileURL else { return }
    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
  }
}

/// Copy provider-owned URLs while access is granted; file IO and thumbnail decoding stay off main.
actor AttachmentFileImporter {
  static let shared = AttachmentFileImporter()

  func copy(_ source: URL) throws -> ImportedAttachmentFile {
    try Self.copyFile(source)
  }

  @MainActor static func image(from provider: NSItemProvider) async throws -> ImportedAttachmentFile
  {
    let identifier =
      provider.registeredTypeIdentifiers.first {
        UTType($0)?.conforms(to: .image) == true
      } ?? UTType.image.identifier
    let name = provider.suggestedName
    let progress = Progress(totalUnitCount: 1)
    let pending = Mutex<CheckedContinuation<ImportedAttachmentFile, Error>?>(nil)
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        pending.withLock { $0 = continuation }
        if progress.isCancelled {
          pending.withLock { value in
            defer { value = nil }
            return value
          }?.resume(throwing: CancellationError())
          return
        }
        let loading = provider.loadInPlaceFileRepresentation(forTypeIdentifier: identifier) {
          url, _, error in
          // Cancellation can race a successful provider callback. Claim the
          // result before copying so neither files nor continuations are duplicated.
          guard
            let continuation = pending.withLock({ value in
              defer { value = nil }
              return value
            })
          else { return }
          do {
            if let error { throw error }
            guard let url else { throw CocoaError(.fileReadUnknown) }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= ChatAttachment.maximumSize
            else { throw ChatError.invalidContract("File too large (max 1 GB).") }
            // Validate in place before making our private copy. Provider-owned URLs
            // are valid during this callback. Preserve encoded bytes and orientation;
            // only the small preview is decoded.
            let source = CGImageSourceCreateWithURL(url as CFURL, nil)
            let type = source.flatMap { CGImageSourceGetType($0) }.flatMap { UTType($0 as String) }
            guard let type, type.conforms(to: .image) else {
              throw ChatError.invalidContract("This image could not be loaded. Copy it again.")
            }
            let base = (name as NSString?)?.lastPathComponent
            let filename: String
            if let base, !base.isEmpty,
              UTType(filenameExtension: (base as NSString).pathExtension) == type
            {
              filename = base
            } else {
              let stem = base.map { ($0 as NSString).deletingPathExtension }
              filename =
                "\(stem.flatMap { $0.isEmpty ? nil : $0 } ?? "Image")"
                + ".\(type.preferredFilenameExtension ?? "img")"
            }
            let file = try Self.copyFile(url, filename: filename, contentType: type)
            if progress.isCancelled {
              file.remove()
              throw CancellationError()
            }
            continuation.resume(returning: file)
          } catch { continuation.resume(throwing: error) }
        }
        progress.addChild(loading, withPendingUnitCount: 1)
        if progress.isCancelled { loading.cancel() }
      }
    } onCancel: {
      progress.cancel()
      pending.withLock { value in
        defer { value = nil }
        return value
      }?.resume(throwing: CancellationError())
    }
  }

  private nonisolated static func copyFile(
    _ source: URL, filename: String? = nil, contentType: UTType? = nil
  ) throws -> ImportedAttachmentFile {
    try Task.checkCancellation()
    let access = source.startAccessingSecurityScopedResource()
    defer { if access { source.stopAccessingSecurityScopedResource() } }
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "OkouAttachments/\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var mutable = directory
    var backup = URLResourceValues()
    backup.isExcludedFromBackup = true
    try mutable.setResourceValues(backup)
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
          let filename = filename ?? source.lastPathComponent
          guard !filename.isEmpty, filename.utf16.count <= 255 else {
            throw ChatError.invalidContract(
              "The filename is too long. Rename the file and try again.")
          }
          let destination = directory.appendingPathComponent(filename)
          try FileManager.default.copyItem(at: url, to: destination)
          let type =
            contentType ?? values.contentType
            ?? UTType(filenameExtension: destination.pathExtension)
          result = ImportedAttachmentFile(
            url: destination, filename: filename,
            contentType: type?.preferredMIMEType ?? "application/octet-stream",
            size: size,
            thumbnail: type?.conforms(to: .image) == true
              ? makeThumbnail(destination, maximumPixelSize: 160) : nil
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

  func thumbnail(_ url: URL, maximumPixelSize: Int = 160) -> Data? {
    Self.makeThumbnail(url, maximumPixelSize: maximumPixelSize)
  }

  private nonisolated static func makeThumbnail(_ url: URL, maximumPixelSize: Int) -> Data? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
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
