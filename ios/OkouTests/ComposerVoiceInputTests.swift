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
  func testStartingVoiceInputPreservesExistingEditorFocus() async throws {
    for initiallyFocused in [false, true] {
      let fixture = VoiceComposerFixture()
      let root = temporaryRoot()
      defer { try? FileManager.default.removeItem(at: root) }
      let capture = VoiceCaptureFixture()
      let composer = fixture.composer(root: root, capture: capture)
      defer { composer.close() }
      composer.text = "Keep these notes"
      let voice = try XCTUnwrap(composer.voice)
      let recordingPresented = expectation(description: "Composer observed recording")
      let host = UIHostingController(
        rootView: VoiceFocusHarness(composer: composer, recordingPresented: recordingPresented))
      let window = try await mountMentionHost(host)
      defer { unmount(window) }
      let input = try XCTUnwrap(mentionInputs(in: host.view).first)
      if initiallyFocused { try await focusMentionInput(input) }
      XCTAssertEqual(input.isFirstResponder, initiallyFocused)

      await voice.start()
      await fulfillment(of: [recordingPresented], timeout: 3)

      XCTAssertEqual(input.isFirstResponder, initiallyFocused)
      XCTAssertEqual(composer.text, "Keep these notes")
      await voice.discard()
    }
  }

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
    // Nonzero microphone offset exercises the system classifier, rather than only
    // the exact-digital-silence shortcut.
    // The duration also leaves an incomplete final classifier window.
    capture.record(Data(repeating: 1, count: 35_200))
    await voice.finish()
    XCTAssertEqual(voice.duration, 1.1, accuracy: 0.0001)
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

  func testQuietRecordedSpeechIsPreservedForRecognition() async throws {
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
    // Reduce the recorded voice by 24 dB, preserving its waveform and duration.
    capture.speak(seconds: 1, attenuation: 16)
    let started = ContinuousClock.now
    await voice.finish()
    print("SoundAnalysis quiet speech finish: \(started.duration(to: .now))")
    XCTAssertEqual(composer.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.uploadedAudioBytes }, [32_000])
  }

  func testQuietWordInTheIncompleteFinalWindowIsPreserved() async throws {
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
    capture.record(Data(repeating: 0, count: 64_000))
    capture.speak(seconds: 1, attenuation: 16, sampleLimit: 4_000)
    await voice.finish()
    XCTAssertEqual(composer.text, "spoken words")
    XCTAssertEqual(fixture.state.value.withLock { $0.uploadedAudioBytes }, [72_000])
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
      "nameSnapshot": .string("Planner")
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
    XCTAssertEqual(voice.phase, .saved)
    XCTAssertNotNil(voice.error)
    fixture.state.value.withLock { $0.quotaAllowed = false }
    // Explicit insertion needs a focused editor; an unfocused selection means append.
    // Recreate focus loss so this does not depend on recording-phase render timing.
    input.resignFirstResponder()
    try await focusMentionInput(input)
    input.selectedRange = NSRange(location: 7, length: 3)
    await voice.finish()
    XCTAssertEqual(composer.text, "Before spoken words after new notes")
    XCTAssertEqual(fixture.state.value.withLock { $0.audioUploads }, 1)
    XCTAssertEqual(fixture.state.value.withLock { $0.polishRequests }, 1)
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
    let root = temporaryRootWithTeardown()
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
