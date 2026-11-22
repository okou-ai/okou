import AVFoundation
import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

struct VoiceFocusHarness: View {
  let composer: ComposerDraftStore
  let recordingPresented: XCTestExpectation

  var body: some View {
    MentionComposerHarness(state: composer)
      .onChange(of: composer.voice?.phase) { _, phase in
        if phase == .recording { recordingPresented.fulfill() }
      }
  }
}

@MainActor
final class VoiceCaptureFixture: VoiceAudioCapture {
  var finalSeconds = 0
  var startGate: VoiceResponseGate?
  var startFailure: Error?
  private var continuation: AsyncThrowingStream<VoiceAudioChunk, Error>.Continuation?
  func start() async throws -> AsyncThrowingStream<VoiceAudioChunk, Error> {
    if let startGate { await startGate.wait() }
    if let startFailure { throw startFailure }
    let (stream, continuation) = AsyncThrowingStream<VoiceAudioChunk, Error>.makeStream()
    self.continuation = continuation
    return stream
  }
  func speak(seconds: Int, attenuation: Int16 = 1, sampleLimit: Int? = nil) {
    guard
      let url = Bundle(for: ComposerVoiceInputTests.self)
        .url(forResource: "voice-speech", withExtension: "wav"),
      let wav = try? Data(contentsOf: url)
    else {
      XCTFail("The recorded speech fixture is missing")
      return
    }
    var pcm = Data(wav.dropFirst(44))
    pcm.withUnsafeMutableBytes { bytes in
      for offset in stride(from: 0, to: bytes.count, by: 2) {
        let sample = Int16(
          littleEndian: bytes.loadUnaligned(fromByteOffset: offset, as: Int16.self))
        bytes.storeBytes(
          of: (sample / attenuation).littleEndian, toByteOffset: offset, as: Int16.self)
      }
    }
    var audio = Data()
    for _ in 0..<seconds { audio.append(pcm) }
    record(sampleLimit.map { Data(audio.prefix($0 * 2)) } ?? audio)
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

final class VoiceComposerState: Sendable {
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

final class VoiceComposerFixture: Sendable {
  let state: VoiceComposerState
  let http: ChatHTTPFixture
  init() {
    let state = VoiceComposerState()
    self.state = state
    http = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-drafts/composer":
        if request.httpMethod == "PATCH" {
          let remote = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
          state.value.withLock { $0.remote = remote }
          return ChatHTTPResponse(body: "{}")
        }
        let data = try JSONEncoder().encode(state.value.withLock { $0.remote })
        return ChatHTTPResponse(body: String(data: data, encoding: .utf8)!)
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
      target: .legacyWorkspace(agent),
      commands: ChatCommands(client: client, sync: ChatSync(client: client)),
      repository: syncDrafts ? ChatDraftRepository(client: client) : nil,
      storage: storage, didFail: didFail, voiceCapture: capture)
  }
}

final class VoiceResponseGate: Sendable {
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
