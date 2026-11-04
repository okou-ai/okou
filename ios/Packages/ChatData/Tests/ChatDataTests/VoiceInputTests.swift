import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import ChatData

final class VoiceInputTests: XCTestCase {
  func testIncrementalWavRequestsResumeAfterFailureAndPolishAllSpeech() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let state = Mutex((requests: 0, failTail: true))
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
      XCTAssertEqual(
        request.value(forHTTPHeaderField: "Authorization"), "Bearer local-test-session")
      switch request.url?.path {
      case "/api/voice-io/quota":
        return ChatHTTPResponse(body: #"{"allowed":true,"count":0,"limit":60}"#)
      case "/api/voice-io/transcribe/segment":
        let number = state.withLock { value in
          value.requests += 1
          return value.requests
        }
        let options = try JSONDecoder().decode(
          SegmentOptions.self, from: voicePart("options", request: request))
        let context = try JSONDecoder().decode(
          VoiceEditorContext.self, from: voicePart("editorContext", request: request))
        XCTAssertEqual(context.before, "Existing notes ")
        let wav = try voicePart("file", request: request)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(wav[22], 1)
        XCTAssertEqual(Array(wav[24..<28]), [0x80, 0x3e, 0, 0])
        XCTAssertEqual(wav[34], 16)
        if number == 1 {
          XCTAssertEqual(wav.count, 44 + 15 * 16_000 * 2)
          XCTAssertEqual(options.previousTranscript, "")
          XCTAssertEqual(options.overlapDurationSeconds, 0)
          return ChatHTTPResponse(body: #"{"transcript":"First sentence.","language":"en"}"#)
        }
        XCTAssertEqual(wav.count, 44 + 3 * 16_000 * 2)
        XCTAssertEqual(options.previousTranscript, "First sentence.")
        XCTAssertEqual(options.overlapDurationSeconds, 2)
        XCTAssertEqual(options.totalDurationSeconds, 16)
        if state.withLock({ $0.failTail }) {
          return ChatHTTPResponse(
            status: 503,
            body: #"{"error":{"code":"PROVIDER_UNAVAILABLE","message":"Try again"}}"#)
        }
        return ChatHTTPResponse(body: #"{"transcript":"Second sentence.","language":"en"}"#)
      case "/api/voice-io/polish/segments":
        let body = try JSONDecoder().decode(PolishRequest.self, from: chatRequestBody(request))
        XCTAssertEqual(body.segments, ["First sentence.", "Second sentence."])
        return ChatHTTPResponse(body: #"{"text":"First sentence. Second sentence."}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let client = VoiceInputClient(client: fixture.client)
    let quota = try await client.quota()
    XCTAssertTrue(quota.allowed)
    let storage = VoiceDraftStorage(directory: root)
    let session = try VoiceDraftSession(client: client, storage: storage)
    let id = try await session.begin(
      context: VoiceEditorContext(before: "Existing notes ", selected: "", after: ""))
    _ = try await session.append(Data(repeating: 1, count: 16 * 16_000 * 2), recordingID: id)
    try await session.transcribeAvailable(recordingID: id)
    do {
      _ = try await session.finish(recordingID: id)
      XCTFail("The provider failure must retain the recording")
    } catch let error as APIClientError { XCTAssertEqual(error.serverCode, "PROVIDER_UNAVAILABLE") }
    state.withLock { $0.failTail = false }
    let reopened = try VoiceDraftSession(client: client, storage: storage)
    let text = try await reopened.finish(recordingID: id)
    XCTAssertEqual(text, "First sentence. Second sentence.")
    let retained = try VoiceDraftSession(client: client, storage: storage)
    let savedText = try await retained.finish(recordingID: id)
    XCTAssertEqual(savedText, text)
    XCTAssertEqual(state.withLock { $0.requests }, 3)
    try await retained.discard()
    XCTAssertFalse(storage.hasRecording)
  }

  func testSilenceAndUnicodeContextUseTheExistingProtocol() async throws {
    let context = VoiceEditorContext(
      before: String(repeating: "🌷", count: 800), selected: "中英 mixed",
      after: String(repeating: "😀", count: 800))
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url?.path, "/api/voice-io/transcribe/segment")
      let sent = try JSONDecoder().decode(
        VoiceEditorContext.self, from: voicePart("editorContext", request: request))
      XCTAssertLessThanOrEqual(sent.before.utf16.count, 1_000)
      XCTAssertLessThanOrEqual(sent.after.utf16.count, 1_000)
      XCTAssertEqual(sent.selected, "中英 mixed")
      return ChatHTTPResponse(status: 204, body: "")
    }
    let text = try await VoiceInputClient(client: fixture.client).transcribe(
      pcm: Data(repeating: 0, count: 32_000), previousTranscript: "", overlapSeconds: 0,
      totalSeconds: 1, context: context)
    XCTAssertEqual(text, "")
  }

  func testRecordingStorageSeparatesOriginsUsersWorkspacesAndTargets() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/voice-io/transcribe/segment":
        return ChatHTTPResponse(body: #"{"transcript":"Owner speech","language":"en"}"#)
      case "/api/voice-io/polish/segments":
        return ChatHTTPResponse(body: #"{"text":"Owner speech"}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    func storage(origin: String = "https://one.invalid", user: String = "one", org: String = "one")
      -> ChatDraftStorage
    {
      ChatDraftStorage(
        scope: ChatCacheScope(apiBaseURL: URL(string: origin)!, userID: user, workspaceID: org),
        directory: root)
    }
    let client = VoiceInputClient(client: fixture.client)
    let original = try VoiceDraftSession(
      client: client, storage: storage().voiceDraft(for: .agent("one")))
    let context = VoiceEditorContext(before: "", selected: "", after: "")
    let originalID = try await original.begin(context: context)
    _ = try await original.append(Data(repeating: 1, count: 32_000), recordingID: originalID)
    let others = [
      storage(origin: "https://two.invalid").voiceDraft(for: .agent("one")),
      storage(user: "two").voiceDraft(for: .agent("one")),
      storage(org: "two").voiceDraft(for: .agent("one")),
      storage().voiceDraft(for: .agent("two")),
      storage().voiceDraft(for: .thread("one")),
    ]
    for other in others {
      let independent = try VoiceDraftSession(client: client, storage: other)
      _ = try await independent.begin(context: context)
      try await independent.discard()
    }
    let reopened = try VoiceDraftSession(
      client: client, storage: storage().voiceDraft(for: .agent("one")))
    let text = try await reopened.finish(recordingID: originalID)
    XCTAssertEqual(text, "Owner speech")
  }
}

private struct SegmentOptions: Decodable {
  let previousTranscript: String
  let overlapDurationSeconds: Double
  let totalDurationSeconds: Double
}
private struct PolishRequest: Decodable { let segments: [String] }

private func voicePart(_ name: String, request: URLRequest) throws -> Data {
  let type = try XCTUnwrap(request.value(forHTTPHeaderField: "Content-Type"))
  let boundary = try XCTUnwrap(type.components(separatedBy: "boundary=").last)
  let data = chatRequestBody(request)
  let nameRange = try XCTUnwrap(data.range(of: Data("name=\"\(name)\"".utf8)))
  let header = try XCTUnwrap(
    data.range(of: Data("\r\n\r\n".utf8), in: nameRange.upperBound..<data.endIndex))
  let end = try XCTUnwrap(
    data.range(of: Data("\r\n--\(boundary)".utf8), in: header.upperBound..<data.endIndex))
  return data.subdata(in: header.upperBound..<end.lowerBound)
}
