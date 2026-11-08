import AVFoundation
import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComposerVoiceInputTests: XCTestCase {
  func testConfirmedSilenceLeavesDraftUnchangedWithoutVoiceRequests() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    composer.text = "Keep these notes"
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    // Nonzero microphone offset exercises the bundled model, rather than only
    // the exact-digital-silence shortcut.
    capture.record(Data(repeating: 1, count: 32_000))
    await voice.finish()
    XCTAssertEqual(composer.text, "Keep these notes")
    XCTAssertEqual(voice.phase, .idle)
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 0)
    XCTAssertEqual(fixture.state.value.withLock { $0.polishRequests }, 0)
  }

  func testSilentTailSkipsEarlierSpeechOverlapAndSurvivesPolishRetry() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let uploaded = expectation(description: "Full speech segment uploaded")
    fixture.state.value.withLock {
      $0.transcriptionRequested = uploaded
      $0.failPolish = true
    }
    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    capture.speak(seconds: 15)
    await fulfillment(of: [uploaded], timeout: 3)
    capture.record(Data(repeating: 0, count: 32_000))
    await voice.finish()
    XCTAssertEqual(composer.text, "")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 1)
    composer.close()
    unmount(window)

    fixture.state.value.withLock { $0.failPolish = false }
    let restored = fixture.composer(root: root, capture: VoiceCaptureFixture())
    defer { restored.close() }
    let restoredHost = UIHostingController(rootView: MentionComposerHarness(state: restored))
    let restoredWindow = try await mountMentionHost(restoredHost)
    defer { unmount(restoredWindow) }
    await restored.voice?.finish()
    XCTAssertEqual(restored.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 1)
  }

  func testShortNonzeroAudioIsPreservedForRecognition() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    capture.record(Data(repeating: 1, count: 200))
    await voice.finish()
    XCTAssertEqual(composer.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.uploadedAudioBytes }, [200])
  }

  func testVoiceReplacesSelectionPreservesReferencesAndSupportsUndoWithoutSending() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    composer.text = "Before old after "
    let reference = MessageJSON.object([
      "type": .string("agent"), "agentId": .string("73000000-0000-4000-8000-000000000001"),
      "nameSnapshot": .string("Planner"),
    ])
    let block = try XCTUnwrap(composer.editorBlocks.first)
    var document = block.content
    document.parts.append(reference)
    composer.editBlock(block.id, document: document)
    let original = composer.document
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.selectedRange = NSRange(location: 7, length: 3)
    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    capture.speak(seconds: 1)
    await voice.finish()
    XCTAssertEqual(composer.text, "Before spoken words after ")
    XCTAssertTrue(composer.document.parts.contains(reference))
    XCTAssertEqual(input.selectedRange.location, 7 + "spoken words".utf16.count)
    await voice.finish()
    XCTAssertEqual(composer.text, "Before spoken words after ")
    input.undoManager?.undo()
    XCTAssertEqual(composer.document, original)
    XCTAssertEqual(fixture.state.value.withLock { $0.sentMessages }, 0)
  }

  func testFailedPolishRestoresRecordingAndReusesTranscriptsAfterRelaunch() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    composer.text = "Notes: "
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.selectedRange = NSRange(location: input.text.utf16.count, length: 0)
    let voice = try XCTUnwrap(composer.voice)
    fixture.state.value.withLock { $0.failPolish = true }
    await voice.start()
    capture.speak(seconds: 1)
    await voice.finish()
    XCTAssertEqual(composer.text, "Notes: ")
    XCTAssertNotNil(voice.error)
    composer.close()
    unmount(window)

    fixture.state.value.withLock { $0.failPolish = false }
    let restored = fixture.composer(root: root, capture: VoiceCaptureFixture())
    defer { restored.close() }
    let restoredHost = UIHostingController(rootView: MentionComposerHarness(state: restored))
    let restoredWindow = try await mountMentionHost(restoredHost)
    defer { unmount(restoredWindow) }
    await restored.voice?.finish()
    XCTAssertEqual(restored.text, "Notes: spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 1)
    restored.close()
    let reopened = fixture.composer(root: root, capture: VoiceCaptureFixture())
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "Notes: spoken words")
    XCTAssertEqual(reopened.voice?.phase, .idle)
  }

  func testClosingDraftDuringTranscriptionKeepsRecordingOutOfReplacementDraft() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    composer.text = "Original draft"
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let gate = VoiceResponseGate(started: expectation(description: "Polish requested"))
    fixture.state.value.withLock { $0.gate = gate }
    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    capture.speak(seconds: 1)
    let finish = Task { await voice.finish() }
    addTeardownBlock { @MainActor in
      gate.release()
      finish.cancel()
      await finish.value
    }
    await fulfillment(of: [gate.started], timeout: 3)
    composer.close()
    let replacement = fixture.composer(
      root: root, capture: VoiceCaptureFixture(), agent: "another-agent")
    defer { replacement.close() }
    replacement.text = "Replacement draft"
    gate.release()
    await finish.value
    XCTAssertEqual(composer.text, "Original draft")
    XCTAssertEqual(replacement.text, "Replacement draft")
    let restored = fixture.composer(root: root, capture: VoiceCaptureFixture())
    defer { restored.close() }
    XCTAssertEqual(restored.voice?.phase, .saved)
  }

  func testMicrophoneConversionPreservesDurationAndAudibleSamples() throws {
    let format = try XCTUnwrap(
      AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false))
    let input = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000))
    input.frameLength = 48_000
    let channels = try XCTUnwrap(input.floatChannelData)
    for index in 0..<48_000 {
      let value = Float(sin(Double(index) * 2 * .pi * 440 / 48_000)) * 0.3
      channels[0][index] = value
      channels[1][index] = value
    }
    let encoder = try VoicePCMEncoder(format: format)
    let body = try encoder.convert(input)
    let tail = try encoder.convert(nil)
    let bytes = body.pcm.count + tail.pcm.count
    XCTAssertEqual(Double(bytes) / 32_000, 1, accuracy: 0.02)
    XCTAssertGreaterThan(body.level, 0.1)
  }

  func testSuspensionDrainsFinalAudioBeforeTheSavedRecordingCanBeUsed() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    capture.finalSeconds = 1
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    capture.speak(seconds: 1)
    voice.suspend()
    try await waitForBusinessResult { voice.phase == .saved }
    XCTAssertEqual(voice.duration, 2)
    await voice.finish()
    XCTAssertEqual(composer.text, "spoken words")
  }

  func testChangedDraftRetainsReadyTextForExplicitInsertionAtTheNewCursor() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    composer.text = "Before old after"
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let input = try XCTUnwrap(mentionInputs(in: host.view).first)
    try await focusMentionInput(input)
    input.selectedRange = NSRange(location: 7, length: 3)
    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    capture.speak(seconds: 1)
    try await focusMentionInput(input)
    input.selectedRange = NSRange(location: input.text.utf16.count, length: 0)
    input.insertText(" new notes")
    await voice.finish()
    XCTAssertEqual(composer.text, "Before old after new notes")
    XCTAssertNotNil(voice.error)
    fixture.state.value.withLock { $0.quotaAllowed = false }
    input.selectedRange = NSRange(location: 7, length: 3)
    await voice.finish()
    XCTAssertEqual(composer.text, "Before spoken words after new notes")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 1)
  }

  private func temporaryRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }

  private func temporaryRootWithTeardown() -> URL {
    let root = temporaryRoot()
    // XCTest runs this after the async teardown blocks registered by the caller.
    addTeardownBlock {
      if FileManager.default.fileExists(atPath: root.path) {
        try FileManager.default.removeItem(at: root)
      }
    }
    return root
  }

  func testVoiceQuotaUpgradeResponseReachesTheOwningCaller() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    fixture.state.value.withLock {
      $0.quotaFailure = ChatHTTPResponse(
        status: 426,
        body:
          #"{"error":{"code":"IOS_UPDATE_REQUIRED","message":"Update Okou"},"minimumSupportedVersion":"99.0.0"}"#
      )
    }
    let upgrade = expectation(description: "The caller must require an app update")
    let composer = fixture.composer(root: root, capture: VoiceCaptureFixture()) { failure in
      XCTAssertEqual((failure as? APIClientError)?.statusCode, 426)
      upgrade.fulfill()
    }
    defer { composer.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    await composer.voice?.start()
    await fulfillment(of: [upgrade], timeout: 3)
    XCTAssertEqual(composer.voice?.phase, .saved)
    XCTAssertFalse(fixture.state.value.withLock { $0.uploadedBeforeQuota })
  }

  func testSlowQuotaAllowsLocalCaptureAndTranscribesBufferedAudioAfterApproval() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRootWithTeardown()
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let gate = VoiceResponseGate(started: expectation(description: "Quota requested"))
    let upload = expectation(description: "Buffered audio transcribed after approval")
    fixture.state.value.withLock {
      $0.quotaGate = gate
      $0.transcriptionRequested = upload
    }
    let voice = try XCTUnwrap(composer.voice)
    let starting = Task { await voice.start() }
    addTeardownBlock { @MainActor in
      gate.release()
      starting.cancel()
      await voice.discard()
      await starting.value
    }
    await fulfillment(of: [gate.started], timeout: 3)
    try await waitForBusinessResult { voice.phase == .recording }
    capture.speak(seconds: 16)
    try await waitForBusinessResult { voice.duration == 16 }
    gate.release()
    await starting.value
    await fulfillment(of: [upload], timeout: 3)
    await voice.finish()
    XCTAssertEqual(composer.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.uploadedAudioBytes }, [480_000, 96_000])
    XCTAssertFalse(fixture.state.value.withLock { $0.uploadedBeforeQuota })
  }

  func testDeniedQuotaStopsAndDrainsCaptureWithoutLosingTheRecording() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRootWithTeardown()
    let capture = VoiceCaptureFixture()
    capture.finalSeconds = 1
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let gate = VoiceResponseGate(started: expectation(description: "Quota requested"))
    fixture.state.value.withLock {
      $0.quotaGate = gate
      $0.quotaAllowed = false
    }
    let voice = try XCTUnwrap(composer.voice)
    let starting = Task { await voice.start() }
    addTeardownBlock { @MainActor in
      gate.release()
      starting.cancel()
      await voice.discard()
      await starting.value
    }
    await fulfillment(of: [gate.started], timeout: 3)
    try await waitForBusinessResult { voice.phase == .recording }
    capture.speak(seconds: 15)
    try await waitForBusinessResult { voice.duration == 15 }
    gate.release()
    await starting.value
    XCTAssertEqual(voice.phase, .saved)
    XCTAssertEqual(voice.duration, 16)
    XCTAssertTrue(try XCTUnwrap(voice.error).contains("limit has been reached"))
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 0)
    fixture.state.value.withLock {
      $0.quotaGate = nil
      $0.quotaAllowed = true
    }
    await voice.finish()
    XCTAssertEqual(composer.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.uploadedAudioBytes }, [480_000, 96_000])
    XCTAssertFalse(fixture.state.value.withLock { $0.uploadedBeforeQuota })
  }

  func testFinishingWhileOfflineRetainsAudioForAnExplicitRetryAfterReopening() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRootWithTeardown()
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    composer.text = "Notes: "
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let gate = VoiceResponseGate(started: expectation(description: "Quota requested"))
    fixture.state.value.withLock {
      $0.quotaGate = gate
      $0.quotaError = URLError(.notConnectedToInternet)
    }
    let voice = try XCTUnwrap(composer.voice)
    let starting = Task { await voice.start() }
    addTeardownBlock { @MainActor in
      gate.release()
      starting.cancel()
      await voice.discard()
      await starting.value
    }
    await fulfillment(of: [gate.started], timeout: 3)
    try await waitForBusinessResult { voice.phase == .recording }
    capture.speak(seconds: 1)
    try await waitForBusinessResult { voice.duration == 1 }
    let finish = Task { await voice.finish() }
    addTeardownBlock { @MainActor in
      gate.release()
      finish.cancel()
      await voice.discard()
      await finish.value
    }
    try await waitForBusinessResult { voice.phase == .processing }
    gate.release()
    await starting.value
    await finish.value
    XCTAssertEqual(voice.phase, .saved)
    XCTAssertTrue(try XCTUnwrap(voice.error).contains("Your recording is saved"))
    XCTAssertEqual(composer.text, "Notes: ")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 0)
    composer.close()
    try await waitForBusinessResult { voice.phase == .saved }
    unmount(window)

    fixture.state.value.withLock {
      $0.quotaGate = nil
      $0.quotaError = nil
    }
    let restored = fixture.composer(root: root, capture: VoiceCaptureFixture())
    defer { restored.close() }
    addTeardownBlock { @MainActor in await restored.voice?.discard() }
    let restoredHost = UIHostingController(rootView: MentionComposerHarness(state: restored))
    let restoredWindow = try await mountMentionHost(restoredHost)
    defer { unmount(restoredWindow) }
    XCTAssertEqual(restored.voice?.duration, 1)
    await restored.voice?.finish()
    XCTAssertEqual(restored.text, "Notes: spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.uploadedAudioBytes }, [32_000])
    XCTAssertFalse(fixture.state.value.withLock { $0.uploadedBeforeQuota })
  }

  func testDiscardingBeforeQuotaReturnsCannotUploadAudioIntoTheNextRecording() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRootWithTeardown()
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture)
    defer { composer.close() }
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let gate = VoiceResponseGate(started: expectation(description: "Quota requested"))
    fixture.state.value.withLock { $0.quotaGate = gate }
    let voice = try XCTUnwrap(composer.voice)
    let starting = Task { await voice.start() }
    addTeardownBlock { @MainActor in
      gate.release()
      starting.cancel()
      await voice.discard()
      await starting.value
    }
    await fulfillment(of: [gate.started], timeout: 3)
    try await waitForBusinessResult { voice.phase == .recording }
    capture.speak(seconds: 16)
    try await waitForBusinessResult { voice.duration == 16 }
    await voice.discard()
    await starting.value
    XCTAssertEqual(voice.phase, .idle)
    fixture.state.value.withLock { $0.quotaGate = nil }
    await voice.start()
    capture.speak(seconds: 1)
    gate.release()
    await voice.finish()
    XCTAssertEqual(composer.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.uploadedAudioBytes }, [32_000])
    XCTAssertFalse(fixture.state.value.withLock { $0.uploadedBeforeQuota })
  }

  func testRemoteDraftConflictKeepsReadyVoiceTextRecoverableUntilTheUserChooses() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let composer = fixture.composer(root: root, capture: capture, syncDrafts: true)
    defer { composer.close() }
    await composer.synchronize()
    composer.text = "Local notes: "
    let host = UIHostingController(rootView: MentionComposerHarness(state: composer))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let gate = VoiceResponseGate(
      started: expectation(description: "Polish requested before conflict"))
    fixture.state.value.withLock { $0.gate = gate }
    let voice = try XCTUnwrap(composer.voice)
    await voice.start()
    capture.speak(seconds: 1)
    let finish = Task { await voice.finish() }
    addTeardownBlock { @MainActor in
      gate.release()
      finish.cancel()
      await finish.value
    }
    await fulfillment(of: [gate.started], timeout: 3)
    fixture.state.value.withLock {
      var document = ChatDraftDocument()
      document.replaceText("Other device notes")
      $0.remote = ComposerDraft(document: document)
    }
    await composer.synchronize()
    XCTAssertNotNil(composer.conflictingRemote)
    gate.release()
    await finish.value
    XCTAssertEqual(voice.phase, .saved)
    XCTAssertEqual(composer.text, "Local notes: ")
    fixture.state.value.withLock { $0.gate = nil }
    composer.keepLocal()
    await voice.finish()
    XCTAssertEqual(composer.text, "Local notes: spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 1)
  }

  func testLateMicrophonePermissionCannotStartRecordingInAReplacementDraft() async throws {
    let fixture = VoiceComposerFixture()
    let root = temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = VoiceCaptureFixture()
    let gate = VoiceResponseGate(
      started: expectation(description: "Microphone permission requested"))
    capture.startGate = gate
    let original = fixture.composer(root: root, capture: capture)
    defer { original.close() }
    original.text = "Original notes"
    let host = UIHostingController(rootView: MentionComposerHarness(state: original))
    let window = try await mountMentionHost(host)
    defer { unmount(window) }
    let starting = Task { await original.voice?.start() }
    addTeardownBlock { @MainActor in
      gate.release()
      starting.cancel()
      await starting.value
    }
    await fulfillment(of: [gate.started], timeout: 3)
    original.close()
    unmount(window)
    let replacementCapture = VoiceCaptureFixture()
    let replacement = fixture.composer(
      root: root, capture: replacementCapture, agent: "another-agent")
    defer { replacement.close() }
    let replacementHost = UIHostingController(rootView: MentionComposerHarness(state: replacement))
    let replacementWindow = try await mountMentionHost(replacementHost)
    defer { unmount(replacementWindow) }
    await replacement.voice?.start()
    replacementCapture.speak(seconds: 1)
    await replacement.voice?.finish()
    gate.release()
    await starting.value
    XCTAssertEqual(original.text, "Original notes")
    XCTAssertEqual(replacement.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 1)
    let reopened = fixture.composer(root: root, capture: VoiceCaptureFixture())
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "Original notes")
    XCTAssertEqual(reopened.voice?.phase, .idle)
  }
}

@MainActor
private final class VoiceCaptureFixture: VoiceAudioCapture {
  var finalSeconds = 0
  var startGate: VoiceResponseGate?
  private var continuation: AsyncThrowingStream<VoiceAudioChunk, Error>.Continuation?
  func start() async throws -> AsyncThrowingStream<VoiceAudioChunk, Error> {
    if let startGate { await startGate.wait() }
    let (stream, continuation) = AsyncThrowingStream<VoiceAudioChunk, Error>.makeStream()
    self.continuation = continuation
    return stream
  }
  func speak(seconds: Int) {
    record(Data(repeating: 32, count: seconds * 32_000))
  }
  func record(_ pcm: Data) {
    continuation?.yield(VoiceAudioChunk(pcm: pcm, level: 0.3))
  }
  func stop() {
    if finalSeconds > 0 { speak(seconds: finalSeconds) }
    continuation?.finish()
    continuation = nil
  }
}

private final class VoiceComposerState: Sendable {
  struct State: Sendable {
    var remote = ComposerDraft()
    var quotaFailure: ChatHTTPResponse?
    var quotaError: URLError?
    var quotaGate: VoiceResponseGate?
    var quotaAllowed = true
    var quotaApproved = false
    var audioUploads = 0
    var uploadedAudioBytes: [Int] = []
    var uploadedBeforeQuota = false
    var transcriptionRequested: XCTestExpectation?
    var sentMessages = 0
    var failPolish = false
    var polishRequests = 0
    var gate: VoiceResponseGate?
  }
  let value = Mutex(State())
}

private final class VoiceComposerFixture: Sendable {
  let state: VoiceComposerState
  let http: ChatHTTPFixture
  init() {
    let state = VoiceComposerState()
    self.state = state
    http = ChatHTTPFixture { request in
      switch request.url?.path {
      case let path? where path.hasPrefix("/api/agents/") && path.hasSuffix("/draft"):
        if request.httpMethod == "PATCH" {
          let remote = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
          state.value.withLock { $0.remote = remote }
          return ChatHTTPResponse(body: "{}")
        }
        let data = try JSONEncoder().encode(state.value.withLock { $0.remote })
        return ChatHTTPResponse(body: String(decoding: data, as: UTF8.self))
      case "/api/voice-io/quota":
        let quota = state.value.withLock { value in
          value.quotaApproved = false
          return (value.quotaGate, value.quotaError, value.quotaFailure, value.quotaAllowed)
        }
        if let gate = quota.0 { await gate.wait() }
        if let failure = quota.1 { throw failure }
        if let failure = quota.2 { return failure }
        state.value.withLock { $0.quotaApproved = quota.3 }
        return ChatHTTPResponse(body: "{\"allowed\":\(quota.3),\"count\":0,\"limit\":60}")
      case "/api/voice-io/transcribe/segment":
        let body = try chatRequestBody(request)
        let wav = try XCTUnwrap(body.range(of: Data("RIFF".utf8)))
        let byteCount = body[(wav.lowerBound + 40)..<(wav.lowerBound + 44)]
          .enumerated().reduce(0) { $0 | (Int($1.element) << ($1.offset * 8)) }
        let requested = state.value.withLock { value in
          value.audioUploads += 1
          value.uploadedAudioBytes.append(byteCount)
          if !value.quotaApproved { value.uploadedBeforeQuota = true }
          let requested = value.transcriptionRequested
          value.transcriptionRequested = nil
          return requested
        }
        requested?.fulfill()
        return ChatHTTPResponse(body: #"{"transcript":"spoken words","language":"en"}"#)
      case "/api/voice-io/polish/segments":
        state.value.withLock { $0.polishRequests += 1 }
        if let gate = state.value.withLock({ $0.gate }) { await gate.wait() }
        if state.value.withLock({ $0.failPolish }) {
          return ChatHTTPResponse(
            status: 503, body: #"{"error":{"code":"PROVIDER_UNAVAILABLE","message":"Busy"}}"#)
        }
        return ChatHTTPResponse(body: #"{"text":"spoken words"}"#)
      case "/api/chat/events":
        state.value.withLock { $0.sentMessages += 1 }
        return ChatHTTPResponse(status: 500, body: #"{"error":{"message":"No send requested"}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor func composer(
    root: URL, capture: VoiceCaptureFixture, agent: String = "voice-agent",
    syncDrafts: Bool = false,
    didFail: @escaping @MainActor (Error) -> Void = { XCTFail($0.localizedDescription) }
  )
    -> ComposerDraftStore
  {
    let client = http.client
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: http.baseURL, userID: "voice-user", workspaceID: "voice-org"),
      directory: root)
    return ComposerDraftStore(
      target: .agent(agent), commands: ChatCommands(client: client, sync: ChatSync(client: client)),
      repository: syncDrafts ? ChatDraftRepository(client: client) : nil,
      storage: storage, didFail: didFail, voiceCapture: capture)
  }
}

private final class VoiceResponseGate: Sendable {
  private struct State: Sendable {
    var released = false
    var continuation: CheckedContinuation<Void, Never>?
  }
  let started: XCTestExpectation
  private let state = Mutex(State())
  init(started: XCTestExpectation) { self.started = started }
  func wait() async {
    await withCheckedContinuation { value in
      let released = state.withLock { state in
        if state.released { return true }
        state.continuation = value
        return false
      }
      started.fulfill()
      if released { value.resume() }
    }
  }
  func release() {
    let continuation = state.withLock { state in
      state.released = true
      let continuation = state.continuation
      state.continuation = nil
      return continuation
    }
    continuation?.resume()
  }
}
