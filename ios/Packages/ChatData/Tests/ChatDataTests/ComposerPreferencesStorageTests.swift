import Foundation
import XCTest

@testable import ChatData

final class ComposerPreferencesStorageTests: XCTestCase {
  func testDefaultAndSavedReturnKeySurviveReopeningDevicePreferences() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ComposerPreferencesStorage(directory: directory)
    XCTAssertEqual(try storage.returnKey(), .newline)
    try storage.setReturnKey(.send)
    XCTAssertEqual(try ComposerPreferencesStorage(directory: directory).returnKey(), .send)
    try storage.setReturnKey(.newline)
    XCTAssertEqual(try ComposerPreferencesStorage(directory: directory).returnKey(), .newline)
  }

  func testUnreadablePreferencesAreReportedWithoutReplacingThemWithTheDefault() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let folder = directory.appending(path: "ComposerPreferences", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let file = folder.appending(path: "return-key.json")
    let unsupported = try JSONEncoder().encode("unsupported")
    try unsupported.write(to: file)
    XCTAssertThrowsError(try ComposerPreferencesStorage(directory: directory).returnKey())
    XCTAssertEqual(try Data(contentsOf: file), unsupported)
  }
}
