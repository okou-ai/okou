import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatModelStoreTests: XCTestCase {
  func testNewChatKeepsEachModelsEffortAndSavesDefaultOnlyOnExplicitAction() async throws {
    let writes = Mutex<[URLRequest]>([])
    let savedPreference = Mutex<String?>(nil)
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "PUT" {
        writes.withLock { $0.append(request) }
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        XCTAssertEqual(body["selectedModel"] as? String, "codex-model")
        XCTAssertEqual(body["serviceTier"] as? String, "priority")
        XCTAssertEqual((body["modelSettingsPatch"] as? [String: String])?["effort"], "max")
        let preference = ModelHTTPFixtures.preference.replacingOccurrences(
          of: "\"ultra\"", with: "\"max\""
        ).replacingOccurrences(of: "\"serviceTier\":null", with: "\"serviceTier\":\"priority\"")
        savedPreference.withLock { $0 = preference }
        return ChatHTTPResponse(body: preference)
      }
      if request.url?.path == "/api/user-model-preference",
        let saved = savedPreference.withLock({ $0 })
      {
        return ChatHTTPResponse(body: saved)
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: resource)
    defer {
      resource.close()
      selection.close()
    }
    await selection.open()
    XCTAssertEqual(selection.effectiveEffort, "medium")
    await selection.choose(effort: "max")
    await selection.setFast(true)
    await selection.choose(model: "claude-model")
    XCTAssertEqual(selection.effectiveEffort, "extra")
    await selection.choose(effort: "high")
    await selection.choose(model: "codex-model")
    XCTAssertEqual(selection.effectiveEffort, "max")
    await selection.setFast(true)
    XCTAssertEqual(selection.selection.modelSettings["claude-model"]?.effort, "high")
    XCTAssertTrue(writes.withLock { $0.isEmpty })
    await selection.open()
    XCTAssertTrue(writes.withLock { $0.isEmpty })
    await selection.saveForFutureChats()
    XCTAssertEqual(writes.withLock { $0.count }, 1)
    XCTAssertTrue(selection.savedDefault)
    selection.resetNewChat()
    XCTAssertEqual(selection.selection.serviceTier, "priority")
    XCTAssertEqual(selection.effectiveEffort, "max")
  }

  func testFirstMessageKeepsItsChoiceWhenDefaultsChangeDuringCreation() async throws {
    for explicit in [false, true] {
      let model = explicit ? "claude-model" : "codex-model"
      let nextDefault = explicit ? "codex-model" : "claude-model"
      let gate = ModelResponseGate()
      let creationStarted = expectation(description: "Creation captured \(model)")
      let changed = Mutex(false)
      let sends = Mutex<[Data]>([])
      let creations = Mutex<[Data]>([])
      let fixture = ChatHTTPFixture { request in
        let path = request.url!.path
        switch path {
        case "/api/agents":
          return ChatHTTPResponse(
            body: "[{\"agentId\":\"\(ModelHTTPFixtures.agentID)\",\"isDefaultAgent\":true}]")
        case "/api/chat-threads":
          creations.withLock { $0.append(chatRequestBody(request)) }
          creationStarted.fulfill()
          await gate.wait()
          return ChatHTTPResponse(
            body:
              "{\"id\":\"\(ModelHTTPFixtures.threadID)\",\"createdAt\":\"2026-10-20T00:00:00Z\",\"selectedModel\":\"\(model)\"}"
          )
        case "/api/chat-threads/snapshot":
          return ChatHTTPResponse(
            body: """
              {"chatThreads":[{"id":"\(ModelHTTPFixtures.threadID)","agentId":"\(ModelHTTPFixtures.agentID)","title":null,"selectedModel":"\(model)","createdAt":"2026-10-20T00:00:00Z","updatedAt":"2026-10-20T00:00:00Z","sortAt":"2026-10-20T00:00:00Z"}],"latestEventId":null,"latestSeqId":null}
              """)
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        case "/api/indicators":
          return ChatHTTPResponse(body: "{\"threads\":{}}")
        case "/api/chat/events":
          sends.withLock { $0.append(chatRequestBody(request)) }
          return ChatHTTPResponse(body: "{\"threadId\":\"\(ModelHTTPFixtures.threadID)\"}")
        case "/api/chat-threads/\(ModelHTTPFixtures.threadID)/connector-selections":
          return ChatHTTPResponse(body: "{\"selections\":[]}")
        case "/api/chat-threads/\(ModelHTTPFixtures.threadID)/event-snapshot":
          return ChatHTTPResponse(
            status: 404,
            body:
              "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}"
          )
        case "/api/chat-threads/\(ModelHTTPFixtures.threadID)/event-rows":
          return ChatHTTPResponse(
            body:
              "{\"rows\":[],\"cursor\":{\"lastEventId\":null,\"lastSeqId\":0},\"hasMore\":false}")
        case "/api/chat-threads/\(ModelHTTPFixtures.threadID)":
          return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
        default:
          var response = try XCTUnwrap(
            ModelHTTPFixtures.response(path), "Unhandled request: \(path)")
          if path == "/api/user-model-preference", changed.withLock({ $0 }) {
            response.body = response.body.replacingOccurrences(
              of: "\"selectedModel\":\"codex-model\"", with: "\"selectedModel\":\"\(nextDefault)\"")
          }
          return response
        }
      }
      let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
      defer {
        gate.open()
        workspace.close()
      }
      await workspace.newModelSelection.open()
      if explicit {
        await workspace.newModelSelection.choose(model: model)
        await workspace.newModelSelection.choose(effort: "extra")
      }
      workspace.newChatDraft = "Use this selection for the very first message"
      let sendTask = Task { await workspace.sendNewChat() }
      await fulfillment(of: [creationStarted], timeout: 3)
      changed.withLock { $0 = true }
      await workspace.modelStore.refresh()
      XCTAssertEqual(workspace.newModelSelection.selection.model, model)
      gate.open()
      await sendTask.value
      XCTAssertTrue(workspace.newChatDraft.isEmpty)
      XCTAssertEqual(workspace.selectedThreadID, ModelHTTPFixtures.threadID)
      let creation = try XCTUnwrap(
        JSONSerialization.jsonObject(with: XCTUnwrap(creations.withLock { $0.first }))
          as? [String: Any])
      let send = try XCTUnwrap(
        JSONSerialization.jsonObject(with: XCTUnwrap(sends.withLock { $0.first })) as? [String: Any]
      )
      XCTAssertEqual(creation["model"] as? String, model)
      XCTAssertEqual(creation["reasoningEffort"] as? String, explicit ? "extra" : nil)
      XCTAssertEqual(send["model"] as? String, model)
      XCTAssertEqual(
        (send["runOptions"] as? [String: String])?["reasoningEffort"], explicit ? "extra" : nil)
      XCTAssertEqual(workspace.modelStore.configuration?.preference.selectedModel, nextDefault)
      workspace.startNewChat()
      XCTAssertEqual(workspace.newModelSelection.selection.model, nextDefault)
    }
  }

  func testInFlightAndUncertainSaveBlockSendsUntilAuthoritativeRefresh() async throws {
    let gate = ModelResponseGate()
    let saveStarted = expectation(description: "Save reached HTTP")
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("model-selection") {
        saveStarted.fulfill()
        await gate.wait()
        return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Save unavailable\"}}")
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: resource, thread: thread())
    defer {
      gate.open()
      resource.close()
      selection.close()
    }
    await selection.open()
    XCTAssertTrue(selection.canSend)
    let save = Task { await selection.choose(model: "claude-model") }
    await fulfillment(of: [saveStarted], timeout: 3)
    XCTAssertFalse(selection.canSend)
    XCTAssertEqual(selection.selection.model, "codex-model")
    let sync = ChatSync(client: fixture.client)
    let conversation = ConversationStore(
      thread: thread(), sync: sync,
      commands: ChatCommands(client: fixture.client, sync: sync), webURL: fixture.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: fixture.baseURL), isVisible: { false },
      didMarkRead: {}, didSend: {}, didFail: { _ in }, didSettle: {}, modelSelection: selection)
    defer { conversation.close() }
    conversation.draft = "Keep this draft until model settings are confirmed"
    await conversation.send()
    XCTAssertEqual(conversation.draft, "Keep this draft until model settings are confirmed")
    XCTAssertTrue(conversation.pending.isEmpty)
    gate.open()
    await save.value
    XCTAssertFalse(selection.canSend)
    XCTAssertTrue(selection.uncertain)
    XCTAssertNotNil(selection.error)
    await conversation.send()
    XCTAssertTrue(conversation.pending.isEmpty)
    XCTAssertFalse(conversation.draft.isEmpty)
    await selection.refresh()
    XCTAssertTrue(selection.canSend)
    XCTAssertEqual(selection.selection.model, "codex-model")
  }

  func testRemoteInvalidationDuringSaveReadsAgainAfterItsStaleConfirmation() async throws {
    let gate = ModelResponseGate()
    let confirmationStarted = expectation(description: "Confirmation captured before remote update")
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("model-selection") {
        return ChatHTTPResponse(status: 204, body: "")
      }
      if request.url!.path.hasSuffix("metadata") {
        let count = reads.withLock {
          $0 += 1
          return $0
        }
        if count == 2 {
          confirmationStarted.fulfill()
          await gate.wait()
        }
        let body =
          count < 3
          ? ModelHTTPFixtures.metadata
          : ModelHTTPFixtures.metadata.replacingOccurrences(
            of: "\"selectedModel\":\"codex-model\"", with: "\"selectedModel\":\"claude-model\"")
        return ChatHTTPResponse(body: body)
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: resource, thread: thread())
    defer {
      gate.open()
      resource.close()
      selection.close()
    }
    await selection.open()
    let save = Task { await selection.choose(model: "claude-model") }
    await fulfillment(of: [confirmationStarted], timeout: 3)
    await selection.refresh()
    XCTAssertFalse(selection.canSend)
    gate.open()
    await save.value
    XCTAssertEqual(selection.selection.model, "claude-model")
    XCTAssertTrue(selection.canSend)
    XCTAssertEqual(reads.withLock { $0 }, 3)
  }

  func testCrossDeviceThreadAndPreferenceInvalidationRemainSeparateAndDoNotReadUsage() async throws
  {
    let changed = Mutex(false)
    let quotaReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      if path == "/api/me/3rd-party-subscriptions" { quotaReads.withLock { $0 += 1 } }
      var response = try XCTUnwrap(ModelHTTPFixtures.response(path))
      if changed.withLock({ $0 })
        && (path.hasSuffix("metadata") || path == "/api/user-model-preference")
      {
        response.body = response.body.replacingOccurrences(
          of: "\"selectedModel\":\"codex-model\"", with: "\"selectedModel\":\"claude-model\"")
      }
      return response
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    await workspace.modelStore.refresh()
    let existing = ChatModelSelectionStore(models: workspace.modelStore, thread: thread())
    defer { existing.close() }
    await existing.refresh()
    await workspace.newModelSelection.choose(effort: "max")
    changed.withLock { $0 = true }
    XCTAssertEqual(ChatInvalidation(notification: "userPreferenceChanged"), .modelPreference)
    XCTAssertEqual(ChatInvalidation(notification: "runModelsChanged"), .runModels)
    await workspace.refresh([.runModels, .modelPreference])
    XCTAssertEqual(existing.selection.model, "codex-model")
    XCTAssertEqual(workspace.newModelSelection.selection.model, "codex-model")
    await existing.refresh()
    XCTAssertEqual(existing.selection.model, "claude-model")
    workspace.newModelSelection.resetNewChat()
    XCTAssertEqual(workspace.newModelSelection.selection.model, "claude-model")
    XCTAssertEqual(quotaReads.withLock { $0 }, 0)
  }

  func testClosedWorkspaceCannotPublishLateModelOrSubscriptionReads() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "Old model read")
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/model-catalog" {
        began.fulfill()
        await gate.wait()
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let old = ChatModelStore(client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let refresh = Task { await old.refresh() }
    await fulfillment(of: [began], timeout: 3)
    old.close()
    gate.open()
    await refresh.value
    XCTAssertNil(old.configuration)
    XCTAssertTrue(old.subscriptions.accounts.isEmpty)
    let currentFixture = ChatHTTPFixture { request in
      try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let current = ChatModelStore(
      client: currentFixture.client, webURL: currentFixture.baseURL, didFail: { _ in })
    defer { current.close() }
    await current.refresh()
    XCTAssertEqual(current.configuration?.defaultSelection.model, "codex-model")
  }

  func testPlanRestrictionsAndMissingRoutesStayVisibleButCannotSend() async throws {
    let fixture = ChatHTTPFixture { request in
      var response = try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
      if request.url?.path == "/api/run-models" {
        response.body = response.body.replacingOccurrences(
          of: "\"availability\":\"available\",\"providerType\":\"codex-oauth-token\"",
          with: "\"availability\":\"plan_restricted\",\"providerType\":\"codex-oauth-token\"")
      }
      return response
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: resource)
    defer {
      resource.close()
      selection.close()
    }
    await selection.open()
    XCTAssertEqual(selection.selection.model, "codex-model")
    XCTAssertFalse(selection.canSend)
    XCTAssertTrue(resource.configuration?.efforts(for: selection.selection).isEmpty == true)
    await selection.choose(model: nil)
    XCTAssertNil(selection.selection.model)
    XCTAssertTrue(selection.canSend)
  }

  func testFailedDefaultSaveKeepsCurrentChoiceAndPersonalDefaultSeparate() async throws {
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "PUT" {
        return ChatHTTPResponse(
          status: 503, body: "{\"error\":{\"message\":\"Preference save unavailable\"}}")
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: resource)
    defer {
      resource.close()
      selection.close()
    }
    await selection.open()
    await selection.choose(model: "claude-model")
    await selection.saveForFutureChats()
    XCTAssertNotNil(selection.error)
    XCTAssertFalse(selection.savedDefault)
    XCTAssertEqual(selection.selection.model, "claude-model")
    XCTAssertEqual(resource.configuration?.defaultSelection.model, "codex-model")
    selection.resetNewChat()
    XCTAssertEqual(selection.selection.model, "codex-model")
  }

  private func thread() -> ChatThread {
    ChatThread(
      id: ModelHTTPFixtures.threadID, agentID: ModelHTTPFixtures.agentID,
      title: "Example", selectedModel: "codex-model", createdAt: Date(), updatedAt: Date(),
      sortAt: Date())
  }
}

final class ModelResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation
  init() {
    let pair = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    stream = pair.stream
    continuation = pair.continuation
  }
  func open() {
    continuation.yield(())
    continuation.finish()
  }
  func wait() async { for await _ in stream { return } }
}
