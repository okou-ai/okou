import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceStartupModelTests: XCTestCase {
  func testUnavailableRealtimeDoesNotBlockHTTPAndRestartRevalidatesTheWorkspace() async throws {
    let deadline = ModelResponseGate()
    let fixture = WorkspaceStartupFixture()
    let workspace = fixture.workspace(
      modelBootstrap: WorkspaceModelBootstrap {
        await deadline.wait()
      })
    let models = Task.immediate { await workspace.newModelSelection.open() }
    let startup = Task.immediate {
      await workspace.start(userID: "startup-user", workspaceID: "startup-workspace")
    }
    addTeardownBlock { @MainActor in
      workspace.close()
      deadline.open()
      models.cancel()
      startup.cancel()
      await models.value
      await startup.value
    }
    await startup.value
    await models.value
    XCTAssertEqual(workspace.newModelSelection.selection.model, "codex-model")
    XCTAssertTrue(workspace.newModelSelection.canSend)
    XCTAssertEqual(fixture.modelRequests, fixture.expectedModelRequests(rounds: 1))

    fixture.setRemoteModel("claude-model")
    await workspace.start(userID: "startup-user", workspaceID: "startup-workspace")
    XCTAssertEqual(workspace.newModelSelection.selection.model, "claude-model")
    XCTAssertEqual(fixture.modelRequests, fixture.expectedModelRequests(rounds: 2))
  }

  func testStartupReadsSettingsChangedWhileNavigationWasPending() async throws {
    let release = ModelResponseGate()
    defer { release.open() }
    let navigation = expectation(
      description: "Navigation is pending while startup resources refresh")
    let fixture = WorkspaceStartupFixture(beforeNavigationRead: {
      navigation.fulfill()
      await release.wait()
    })
    let workspace = fixture.workspace()
    defer { workspace.close() }
    await workspace.newModelSelection.open()
    let startup = Task {
      await workspace.start(userID: "startup-user", workspaceID: "startup-workspace")
    }
    addTeardownBlock { @MainActor in
      release.open()
      startup.cancel()
      workspace.close()
      await startup.value
    }
    await fulfillment(of: [navigation], timeout: 3)
    fixture.setRemoteModel("claude-model")
    workspace.requestRefresh(.modelPreference)
    try await waitForBusinessResult {
      workspace.newModelSelection.selection.model == "claude-model"
    }
    release.open()
    await startup.value

    XCTAssertEqual(workspace.newModelSelection.selection.model, "claude-model")
  }

  func testStartupPresentsMessagesWhileInitialModelReadIsPending() async throws {
    let release = ModelResponseGate()
    defer { release.open() }
    let began = expectation(description: "The initial model read is pending")
    let modelReads = Mutex(0)
    let fixture = WorkspaceStartupFixture(beforeModelRead: { path in
      guard path == "/api/model-catalog" else { return }
      let count = modelReads.withLock { value in
        value += 1
        return value
      }
      if count == 1 {
        began.fulfill()
        await release.wait()
      }
    })
    let workspace = fixture.workspace(modelBootstrap: WorkspaceModelBootstrap())
    workspace.selectedThreadID = ConversationHistoryFixture.threadID
    let models = Task.immediate { await workspace.newModelSelection.open() }
    let startup = Task {
      await workspace.start(userID: "startup-user", workspaceID: "startup-workspace")
    }
    addTeardownBlock { @MainActor in
      release.open()
      startup.cancel()
      workspace.close()
      models.cancel()
      await startup.value
      await models.value
    }
    await fulfillment(of: [began], timeout: 3)
    try await waitForBusinessResult {
      workspace.selectedConversation?.messages.count == 2
    }
    XCTAssertEqual(workspace.list.threads.map(\.id), [ConversationHistoryFixture.threadID])
    release.open()
    await startup.value
    await models.value
    XCTAssertEqual(workspace.newModelSelection.selection.model, "codex-model")
  }

  func testSubscriptionCatchUpStillReadsAChangeMissedDuringStartup() async throws {
    let fixture = WorkspaceStartupFixture()
    let workspace = fixture.workspace()
    defer { workspace.close() }
    await workspace.newModelSelection.open()
    await workspace.start(userID: "startup-user", workspaceID: "startup-workspace")
    fixture.setRemoteModel("claude-model")

    await workspace.refresh([.reconnected])

    XCTAssertEqual(workspace.newModelSelection.selection.model, "claude-model")
    XCTAssertEqual(fixture.modelRequests, fixture.expectedModelRequests(rounds: 3))
  }

  func testRestartRevalidatesAnExistingWorkspaceConfiguration() async throws {
    let fixture = WorkspaceStartupFixture()
    let workspace = fixture.workspace()
    defer { workspace.close() }
    await workspace.newModelSelection.open()
    await workspace.start(userID: "startup-user", workspaceID: "startup-workspace")
    fixture.setRemoteModel("claude-model")

    await workspace.start(userID: "startup-user", workspaceID: "startup-workspace")

    XCTAssertEqual(workspace.newModelSelection.selection.model, "claude-model")
    XCTAssertEqual(fixture.modelRequests, fixture.expectedModelRequests(rounds: 3))
  }
}

/// Canonical HTTP responses for the real workspace startup and composer consumers.
final class WorkspaceStartupFixture: Sendable {
  let history: ConversationHistoryFixture
  private let state = WorkspaceStartupState()

  init(
    beforeModelRead: (@Sendable (String) async throws -> Void)? = nil,
    beforeNavigationRead: (@Sendable () async throws -> Void)? = nil
  ) {
    let state = state
    history = ConversationHistoryFixture(
      count: 2,
      additional: { request in
        let path = request.url!.path
        if var response = ModelHTTPFixtures.response(path) {
          state.requests.withLock { $0[path, default: 0] += 1 }
          try await beforeModelRead?(path)
          if path == "/api/user-model-preference" {
            response.body = response.body.replacingOccurrences(
              of: "\"selectedModel\":\"codex-model\"",
              with: "\"selectedModel\":\"\(state.remoteModel.withLock { $0 })\"")
          }
          return response
        }
        switch path {
        case "/api/agents":
          try await beforeNavigationRead?()
          return ChatHTTPResponse(
            body:
              "[{\"agentId\":\"\(ConversationHistoryFixture.agentID)\",\"displayName\":\"Startup fixture\",\"isDefaultAgent\":true}]"
          )
        case "/api/indicators":
          return ChatHTTPResponse(body: #"{"agents":{},"unreadAt":{},"threads":{}}"#)
        case "/api/agents/\(ConversationHistoryFixture.agentID)/draft",
          "/api/chat-threads/\(ConversationHistoryFixture.threadID)/draft":
          return ChatHTTPResponse(
            body: #"{"revision":"0","document":null,"clientMutationId":null}"#)
        case "/api/realtime/token":
          // Exercise startup's HTTP fallback without connecting the SDK to a live service.
          return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Fixture offline"}}"#)
        default: throw URLError(.unsupportedURL)
        }
      })
  }

  @MainActor
  func workspace(modelBootstrap: WorkspaceModelBootstrap? = nil) -> WorkspaceStore {
    WorkspaceStore(
      client: history.http.client, webURL: history.http.baseURL, modelBootstrap: modelBootstrap)
  }

  var modelRequests: [String: Int] { state.requests.withLock { $0 } }

  func setRemoteModel(_ value: String) { state.remoteModel.withLock { $0 = value } }

  func expectedModelRequests(rounds: Int) -> [String: Int] {
    [
      "/api/user-model-preference": rounds, "/api/run-models": rounds,
      "/api/model-catalog": rounds, "/api/feature-switches": rounds,
    ]
  }
}

private final class WorkspaceStartupState: Sendable {
  let remoteModel = Mutex("codex-model")
  let requests = Mutex<[String: Int]>([:])
}
