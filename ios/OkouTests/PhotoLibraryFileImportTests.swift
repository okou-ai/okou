import Foundation
import UIKit
import XCTest

@testable import Okou

@MainActor
final class PhotoLibraryFileImportTests: XCTestCase {
  func testPhotoImportPreservesEncodedBytesAndRemovesItsIntermediateDirectory() async throws {
    let root = try directory()
    let importer = AttachmentFileImporter(temporaryDirectory: root)
    let data = try imageData()
    let file = try await importer.photo(data, filename: "Edited Photo.png")
    addTeardownBlock { file.remove() }

    XCTAssertEqual(try Data(contentsOf: file.url), data)
    XCTAssertEqual(file.filename, "Edited Photo.png")
    XCTAssertEqual(file.contentType, "image/png")
    XCTAssertEqual(file.size, data.count)
    XCTAssertEqual(try contents(root), ["OkouAttachments"])
    XCTAssertEqual(try contents(file.url.deletingLastPathComponent()), [file.filename])
    file.remove()
    XCTAssertEqual(try contents(root.appending(path: "OkouAttachments")), [])
  }

  func testFailedRetentionRemovesThePhotoSourceWithoutTouchingExistingFiles() async throws {
    let root = try directory()
    let blocker = root.appending(path: "OkouAttachments")
    let existing = Data("existing file".utf8)
    try existing.write(to: blocker)
    let importer = AttachmentFileImporter(temporaryDirectory: root)
    do {
      _ = try await importer.photo(imageData(), filename: "Photo.png")
      XCTFail("An occupied destination cannot retain a photo")
    } catch {
      XCTAssertFalse(error is CancellationError)
    }

    XCTAssertEqual(try Data(contentsOf: blocker), existing)
    XCTAssertEqual(try contents(root), ["OkouAttachments"])
  }

  func testCancelledImportCreatesNoPhotoFiles() async throws {
    let root = try directory()
    let importer = AttachmentFileImporter(temporaryDirectory: root)
    let data = try imageData()
    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await importer.photo(data, filename: "Photo.png")
    }
    addTeardownBlock {
      task.cancel()
      _ = await task.result
    }
    do {
      _ = try await task.value
      XCTFail("A cancelled import must not retain files")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertEqual(try contents(root), [])
  }

  private func directory() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try FileManager.default.removeItem(at: root) }
    return root
  }

  private func imageData() throws -> Data {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 6)).image { context in
      UIColor.blue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 8, height: 6))
    }
    return try XCTUnwrap(image.pngData())
  }

  private func contents(_ directory: URL) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
  }
}
