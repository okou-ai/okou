import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatModelConfigurationTests: XCTestCase {
  func testCatalogRouteNarrowsPreferredEffortWithoutDestroyingIt() async throws {
    let fixture = ChatHTTPFixture { request in
      try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let configuration = try await ChatModelService(client: fixture.client).load()
    let selection = configuration.defaultSelection
    XCTAssertEqual(selection.model, "codex-model")
    XCTAssertEqual(selection.modelSettings["codex-model"]?.effort, "ultra")
    XCTAssertEqual(
      configuration.efforts(for: selection), ["low", "medium", "high", "xhigh", "max"])
    XCTAssertEqual(configuration.effectiveEffort(for: selection), "medium")
    XCTAssertNil(configuration.requestedEffort(for: selection))
    XCTAssertEqual(configuration.catalog.fastMultiplier(selection.model), 3.75)
    var claude = selection
    claude.model = "claude-model"
    XCTAssertEqual(configuration.efforts(for: claude), ["low", "medium", "high", "extra", "max"])
    XCTAssertEqual(configuration.effectiveEffort(for: claude), "extra")
    XCTAssertFalse(configuration.canUseFast(claude))
    XCTAssertEqual(
      configuration.resolved(ChatModelSelection(model: "retired")).model, "codex-model")
    XCTAssertEqual(
      configuration.resolved(ChatModelSelection(model: "unavailable")).model, "unavailable")
  }

  func testNativeExecutionAndSubscriptionCapabilitiesBothConstrainEffort() async throws {
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/feature-switches" {
        return ChatHTTPResponse(
          body: ModelHTTPFixtures.features.replacingOccurrences(
            of: "\"_codexExecution\":false", with: "\"_codexExecution\":true"))
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let configuration = try await ChatModelService(client: fixture.client).load()
    XCTAssertEqual(configuration.effectiveEffort(for: configuration.defaultSelection), "ultra")
    XCTAssertEqual(configuration.requestedEffort(for: configuration.defaultSelection), "ultra")
  }

  func testMissingExecutionMetadataFailsClearlyAndAutoWritesExplicitNull() async throws {
    let requests = Mutex<[URLRequest]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request) }
      if request.httpMethod == "POST" { return ChatHTTPResponse(status: 204, body: "") }
      var response = try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
      if request.url?.path == "/api/model-catalog" {
        response.body = response.body.replacingOccurrences(
          of: ",\"piRuntimeCapable\":true", with: ""
        ).replacingOccurrences(of: ",\"piRuntimeCapable\":false", with: "")
      }
      return response
    }
    let service = ChatModelService(client: fixture.client)
    do {
      _ = try await service.load()
      XCTFail("The native panel requires canonical runtime metadata")
    } catch let error as APIClientError {
      if case .incompatibleData = error {} else { XCTFail("Unexpected contract error") }
    }
    try await service.save(ChatModelSelection(), effort: nil, threadID: ModelHTTPFixtures.threadID)
    let body = try XCTUnwrap(requests.withLock { $0.last }).bodyObject()
    XCTAssertTrue(body["model"] is NSNull)
    XCTAssertTrue(body["codexServiceTier"] is NSNull)
    XCTAssertNil(body["reasoningEffort"])
  }

  func testExplicitNewChatChoiceAndSendOptionsDoNotBorrowGlobalDefault() async throws {
    let requests = Mutex<[URLRequest]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request) }
      switch request.url!.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: "[{\"agentId\":\"\(ModelHTTPFixtures.agentID)\",\"isDefaultAgent\":true}]")
      case "/api/chat-threads":
        return ChatHTTPResponse(
          body:
            "{\"id\":\"\(ModelHTTPFixtures.threadID)\",\"createdAt\":\"2026-10-20T00:00:00Z\",\"selectedModel\":\"claude-model\"}"
        )
      case "/api/chat/events":
        return ChatHTTPResponse(body: "{\"threadId\":\"\(ModelHTTPFixtures.threadID)\"}")
      case "/api/chat-threads/\(ModelHTTPFixtures.threadID)/connector-selections":
        return ChatHTTPResponse(body: "{\"selections\":[]}")
      default: return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
      }
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let choice = ChatModelSelection(
      model: "claude-model", modelSettings: ["claude-model": .init(effort: "extra")])
    let thread = try await commands.createThread(modelSelection: choice, reasoningEffort: "extra")
    let creation = try XCTUnwrap(
      requests.withLock { $0.first { $0.url?.path == "/api/chat-threads" } }
    ).bodyObject()
    XCTAssertEqual(creation["model"] as? String, "claude-model")
    XCTAssertEqual(creation["reasoningEffort"] as? String, "extra")
    XCTAssertEqual(thread.modelSettings["claude-model"]?.effort, "extra")
    let fast = ChatModelSelection(model: "codex-model", serviceTier: "priority")
    _ = try await commands.send(
      thread: thread, text: "Example", modelSelection: fast, reasoningEffort: "max")
    let send = try XCTUnwrap(requests.withLock { $0.last }).bodyObject()
    XCTAssertEqual(send["model"] as? String, "codex-model")
    let options = try XCTUnwrap(send["runOptions"] as? [String: String])
    XCTAssertEqual(options, ["codexServiceTier": "fast", "reasoningEffort": "max"])
    XCTAssertFalse(requests.withLock { $0.contains { $0.httpMethod == "PUT" } })
  }

  func testSubscriptionWindowsAndAccountMutationsUseConcreteOwnedIdentity() async throws {
    let requests = Mutex<[URLRequest]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request) }
      if request.httpMethod == "GET" {
        return ChatHTTPResponse(body: ModelHTTPFixtures.subscriptions)
      }
      if request.url!.path.hasSuffix("subscription-reset") {
        return ChatHTTPResponse(body: "{\"outcome\":\"reset\"}")
      }
      return ChatHTTPResponse(status: 204, body: "")
    }
    let service = PersonalSubscriptionService(client: fixture.client)
    let accounts = try await service.list()
    let account = try XCTUnwrap(accounts.first)
    XCTAssertEqual(account.limitingWindow?.remaining, 30)
    XCTAssertEqual(account.subscriptionResetCredits, 2)
    try await service.activate(id: account.id)
    _ = try await service.reset(id: account.id, idempotencyKey: ModelHTTPFixtures.threadID)
    try await service.disconnect(id: account.id)
    XCTAssertEqual(
      requests.withLock { $0.suffix(3).map { $0.url!.path } },
      [
        "/api/me/model-provider-accounts/\(account.id)/activate",
        "/api/me/model-provider-accounts/\(account.id)/subscription-reset",
        "/api/me/model-provider-accounts/\(account.id)",
      ])
  }
}

extension URLRequest {
  fileprivate func bodyObject() throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: chatRequestBody(self)) as? [String: Any])
  }
}
