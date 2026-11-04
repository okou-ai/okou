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
    input.selectedRange = NSRange(location: 7, length: 3)
    await voice.finish()
    XCTAssertEqual(composer.text, "Before spoken words after new notes")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 1)
  }

  private func temporaryRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
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
    continuation?.yield(
      VoiceAudioChunk(pcm: Data(repeating: 32, count: seconds * 32_000), level: 0.3))
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
    var audioUploads = 0
    var sentMessages = 0
    var failPolish = false
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
        return ChatHTTPResponse(body: #"{"allowed":true,"count":0,"limit":60}"#)
      case "/api/voice-io/transcribe/segment":
        state.value.withLock { $0.audioUploads += 1 }
        return ChatHTTPResponse(body: #"{"transcript":"spoken words","language":"en"}"#)
      case "/api/voice-io/polish/segments":
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
    root: URL, capture: VoiceCaptureFixture, agent: String = "voice-agent", syncDrafts: Bool = false
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
      storage: storage, didFail: { XCTFail($0.localizedDescription) }, voiceCapture: capture)
  }
}

private final class VoiceResponseGate: Sendable {
  let started: XCTestExpectation
  private let continuation = Mutex<CheckedContinuation<Void, Never>?>(nil)
  init(started: XCTestExpectation) { self.started = started }
  func wait() async {
    await withCheckedContinuation { value in
      continuation.withLock { $0 = value }
      started.fulfill()
    }
  }
  func release() {
    continuation.withLock { value in
      value?.resume()
      value = nil
    }
  }
}
