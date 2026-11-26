import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ComposerVoiceOutputTests: XCTestCase {
  func testExplicitTranscriptionOverridesVoiceMessageDefault() async throws {
    let fixture = VoiceComposerFixture()
    fixture.state.value.withLock { $0.recordAsMessage = true }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }

    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    capture.speak(seconds: 1)
    await voice.finish(asAudio: false)

    XCTAssertEqual(composer.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.polishRequests }, 1)
  }

  func testSendRecordingSubmitsVoiceClipWithExistingDraft() async throws {
    let fixture = VoiceComposerFixture()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    composer.text = "Existing draft"
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }

    let voice = try XCTUnwrap(composer.voice)
    await voice.start(choosesOutput: true)
    capture.speak(seconds: 16)
    var submitted: ChatDraftDocument?
    await voice.finish(asAudio: true) { submitted = composer.document }

    let document = try XCTUnwrap(submitted)
    XCTAssertEqual(document.text, "Existing draft")
    XCTAssertTrue(document.parts.contains { $0["type"]?.string == "voice" })
    XCTAssertEqual(fixture.state.value.withLock { $0.polishRequests }, 0)
  }
}
