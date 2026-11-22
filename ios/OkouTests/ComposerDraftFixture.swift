import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

final class DraftServer: Sendable {
  struct State: Sendable {
    var remote = ComposerDraft()
    var networkError: URLError.Code?
    var rejection: ChatHTTPResponse?
    var remainingRejections: Int?
    var missingFile = false
    var paths: [String] = []
    var writes = 0
  }
  let state: DraftServerState
  let http: ChatHTTPFixture
  let directory: URL
  init(
    remote: ComposerDraft = ComposerDraft(), onRead: @escaping @Sendable () async -> Void = {},
    onWrite: @escaping @Sendable (Int) async -> Void = { _ in }
  ) {
    let state = DraftServerState(remote: remote)
    self.state = state
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    http = ChatHTTPFixture { request in
      let path = request.url!.path
      let failure = state.value.withLock { value in
        value.paths.append(request.httpMethod! + " " + path)
        return value.networkError
      }
      if let failure { throw URLError(failure) }
      let rejection = state.value.withLock { value -> ChatHTTPResponse? in
        if let remaining = value.remainingRejections {
          guard remaining > 0 else { return nil }
          value.remainingRejections = remaining - 1
        }
        return value.rejection
      }
      if let rejection { return rejection }
      if path == "/api/web/file-url" {
        return ChatHTTPResponse(
          status: state.value.withLock { $0.missingFile } ? 404 : 200, body: "{}")
      }
      if path == "/api/uploads/prepare" {
        return ChatHTTPResponse(
          status: 503, body: #"{"error":{"message":"Upload unavailable for the interrupted file"}}"#
        )
      }
      let draftPaths = [
        "/api/chat-drafts/composer", "/api/chat-threads/\(draftThreadID)/draft",
        "/api/chat-threads/\(draftThreadID)"
      ]
      guard draftPaths.contains(path) else { throw URLError(.unsupportedURL) }
      if request.httpMethod == "PATCH" {
        let index = state.value.withLock { value in
          value.writes += 1
          return value.writes
        }
        await onWrite(index)
        let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
        state.value.withLock { $0.remote = draft }
        return ChatHTTPResponse(status: 204, body: "")
      }
      let remote = state.value.withLock { $0.remote }
      await onRead()
      return try ChatHTTPResponse(
        json: remote)
    }
  }
  deinit { try? FileManager.default.removeItem(at: directory) }
  func storage() -> ChatDraftStorage {
    ChatDraftStorage(
      scope: ChatCacheScope(apiBaseURL: http.baseURL, userID: "user", workspaceID: "org"),
      directory: directory)
  }
  @MainActor func composer(
    storage: ChatDraftStorage? = nil, target: ChatDraftTarget = .workspace
  ) -> ComposerDraftStore {
    ComposerDraftStore(
      target: target,
      commands: ChatCommands(client: http.client, sync: ChatSync(client: http.client)),
      repository: ChatDraftRepository(client: http.client), storage: storage, didFail: { _ in },
      syncSleep: { _ in })
  }
}

final class DraftServerState: Sendable {
  let value: Mutex<DraftServer.State>
  init(remote: ComposerDraft) { value = Mutex(DraftServer.State(remote: remote)) }
}

let draftThreadID = "43000000-0000-4000-8000-000000000003"

final class DraftGate: Sendable {
  let stream: AsyncStream<Void>
  let continuation: AsyncStream<Void>.Continuation
  init() { (stream, continuation) = AsyncStream.makeStream() }
  func wait() async { for await _ in stream { return } }
  func open() { continuation.finish() }
}

final class DraftReadCount: Sendable { let value = Mutex(0) }
