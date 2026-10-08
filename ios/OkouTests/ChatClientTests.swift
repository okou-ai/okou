import Foundation
import Synchronization
import XCTest

@testable import Okou

private let fixtureThread = "10000000-0000-4000-8000-000000000001"
private let fixtureAgent = "10000000-0000-4000-8000-000000000002"
private let fixtureRun = "10000000-0000-4000-8000-000000000003"
private let deletedThread = "10000000-0000-4000-8000-000000000004"
private let newThread = "10000000-0000-4000-8000-000000000005"
private let fixtureDate = "2026-09-17T10:00:00.000Z"

@MainActor
final class ChatClientTests: XCTestCase {
  func testNativeThreadActionsUseCanonicalEndpoints() async throws {
    let requests = Mutex<[(String, String, String)]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock {
        $0.append(
          (
            request.httpMethod ?? "", request.url?.path ?? "",
            String(decoding: chatRequestBody(request), as: UTF8.self)
          ))
      }
      return ChatHTTPResponse(status: 204, body: "")
    }
    let service = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    try await service.setPinned(threadID: fixtureThread, pinned: true)
    try await service.setPinned(threadID: fixtureThread, pinned: false)
    try await service.setArchived(threadID: fixtureThread, archived: true)
    try await service.setArchived(threadID: fixtureThread, archived: false)
    try await service.rename(threadID: fixtureThread, title: "Renamed")

    XCTAssertEqual(requests.withLock { $0.map(\.0) }, Array(repeating: "POST", count: 5))
    XCTAssertEqual(
      requests.withLock { $0.map(\.1) },
      [
        "/api/chat-threads/\(fixtureThread)/pin",
        "/api/chat-threads/\(fixtureThread)/unpin",
        "/api/chat-threads/\(fixtureThread)/archive",
        "/api/chat-threads/\(fixtureThread)/unarchive",
        "/api/chat-threads/\(fixtureThread)/rename",
      ])
    XCTAssertEqual(requests.withLock { $0.last?.2 }, "{\"title\":\"Renamed\"}")
  }

  func testCreateUsesSelectedAgentAndSavedModelWithoutOnboardingBootstrap() async throws {
    struct CreatedRequest: Decodable, Sendable {
      let agentId: String
      let model: String
      let reasoningEffort: String?
    }
    let secondaryAgent = "10000000-0000-4000-8000-000000000006"
    let createdRequests = Mutex<[CreatedRequest]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body:
            "[{\"agentId\":\"\(fixtureAgent)\",\"isDefaultAgent\":true,\"displayName\":\"Okou\"},{\"agentId\":\"\(secondaryAgent)\",\"isDefaultAgent\":false,\"displayName\":\"Second\"}]"
        )
      case "/api/user-model-preference":
        return ChatHTTPResponse(
          body:
            "{\"selectedModel\":\"gpt-5.6-sol\",\"serviceTier\":null,\"modelSettings\":{\"gpt-5.6-sol\":{\"effort\":\"high\"}},\"selectedImageModel\":null,\"updatedAt\":null}"
        )
      case "/api/run-models":
        return runModelsResponse([
          SubscriptionRunModel(model: "gpt-5.6-sol", providerType: "codex-oauth-token")
        ])
      case "/api/model-catalog": return modelCatalogResponse()
      case "/api/chat-threads":
        let body = try JSONDecoder().decode(CreatedRequest.self, from: chatRequestBody(request))
        createdRequests.withLock { $0.append(body) }
        return ChatHTTPResponse(
          status: 201,
          body:
            "{\"id\":\"\(newThread)\",\"title\":null,\"createdAt\":\"\(fixtureDate)\",\"selectedModel\":\"gpt-5.6-sol\",\"serviceTier\":null}"
        )
      default: throw URLError(.unsupportedURL)
      }
    }
    let created = try await ChatCommands(
      client: fixture.client, sync: ChatSync(client: fixture.client)
    ).createThread()
    XCTAssertEqual(created.agentID, fixtureAgent)
    XCTAssertEqual(created.selectedModel, "gpt-5.6-sol")
    let selected = try await ChatCommands(
      client: fixture.client, sync: ChatSync(client: fixture.client)
    ).createThread(
      agentID: secondaryAgent)
    XCTAssertEqual(selected.agentID, secondaryAgent)
    XCTAssertEqual(createdRequests.withLock { $0.map(\.agentId) }, [fixtureAgent, secondaryAgent])
    XCTAssertEqual(createdRequests.withLock { $0.map(\.model) }, ["gpt-5.6-sol", "gpt-5.6-sol"])
    XCTAssertEqual(createdRequests.withLock { $0.map(\.reasoningEffort) }, ["high", "high"])
  }

  func testCreateWithoutSavedModelSendsAutoAsExplicitNull() async throws {
    let explicitNullModels = Mutex<[Bool]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body:
            "[{\"agentId\":\"\(fixtureAgent)\",\"isDefaultAgent\":true,\"displayName\":\"Okou\"}]"
        )
      case "/api/user-model-preference":
        return ChatHTTPResponse(
          body:
            "{\"selectedModel\":null,\"serviceTier\":null,\"modelSettings\":{},\"selectedImageModel\":null,\"updatedAt\":null}"
        )
      case "/api/run-models":
        return runModelsResponse([
          SubscriptionRunModel(model: "gpt-5.6-sol", providerType: "codex-oauth-token")
        ])
      case "/api/model-catalog": return modelCatalogResponse()
      case "/api/chat-threads":
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        let isExplicitNull = body["model"] is NSNull
        explicitNullModels.withLock { $0.append(isExplicitNull) }
        return ChatHTTPResponse(
          status: 201,
          body:
            "{\"id\":\"\(newThread)\",\"title\":null,\"createdAt\":\"\(fixtureDate)\",\"selectedModel\":null,\"serviceTier\":null}"
        )
      default: throw URLError(.unsupportedURL)
      }
    }
    let created = try await ChatCommands(
      client: fixture.client, sync: ChatSync(client: fixture.client)
    ).createThread()
    XCTAssertNil(created.selectedModel)
    XCTAssertEqual(explicitNullModels.withLock { $0 }, [true])
  }

  func testCreateResolvesRetiredSavedModelThroughCatalog() async throws {
    struct CreatedRequest: Decodable, Sendable {
      let model: String
      let reasoningEffort: String?
    }
    let createdRequests = Mutex<[CreatedRequest]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(fixtureAgent)","isDefaultAgent":true,"displayName":"Okou"}]
            """)
      case "/api/user-model-preference":
        return ChatHTTPResponse(
          body: """
            {"selectedModel":"claude-opus-4-8","serviceTier":"priority",\
            "modelSettings":{"claude-opus-5-5":{"effort":"high"}},\
            "selectedImageModel":null,"updatedAt":null}
            """)
      case "/api/run-models":
        return runModelsResponse([
          SubscriptionRunModel(model: "claude-opus-5-5", providerType: "claude-code-oauth-token")
        ])
      case "/api/model-catalog": return modelCatalogResponse()
      case "/api/chat-threads":
        let body = try JSONDecoder().decode(CreatedRequest.self, from: chatRequestBody(request))
        createdRequests.withLock { $0.append(body) }
        return ChatHTTPResponse(
          status: 201,
          body: """
            {"id":"\(newThread)","title":null,"createdAt":"\(fixtureDate)",\
            "selectedModel":"claude-opus-5-5","serviceTier":null}
            """)
      default: throw URLError(.unsupportedURL)
      }
    }
    let created = try await ChatCommands(
      client: fixture.client, sync: ChatSync(client: fixture.client)
    ).createThread()
    XCTAssertEqual(created.selectedModel, "claude-opus-5-5")
    XCTAssertEqual(createdRequests.withLock { $0.map(\.model) }, ["claude-opus-5-5"])
    XCTAssertEqual(createdRequests.withLock { $0.map(\.reasoningEffort) }, ["high"])
  }

  func testCreateReplacesUnknownOrUnavailableSavedModelWithAuto() async throws {
    struct CreatedRequest: Decodable, Sendable {
      let model: String?
      let serviceTier: String?
    }
    for savedModel in ["unknown-model", "gpt-5.6-sol"] {
      let createdRequests = Mutex<[CreatedRequest]>([])
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/agents":
          return ChatHTTPResponse(
            body: """
              [{"agentId":"\(fixtureAgent)","isDefaultAgent":true,"displayName":"Okou"}]
              """)
        case "/api/user-model-preference":
          return ChatHTTPResponse(
            body: """
              {"selectedModel":"\(savedModel)","serviceTier":"priority","modelSettings":{}}
              """)
        // gpt-5.6-sol is in the catalog but the member has no connected subscription row.
        case "/api/run-models": return runModelsResponse()
        case "/api/model-catalog": return modelCatalogResponse()
        case "/api/chat-threads":
          let body = try JSONDecoder().decode(CreatedRequest.self, from: chatRequestBody(request))
          createdRequests.withLock { $0.append(body) }
          return ChatHTTPResponse(
            status: 201,
            body: """
              {"id":"\(newThread)","title":null,"createdAt":"\(fixtureDate)","selectedModel":null}
              """)
        default: throw URLError(.unsupportedURL)
        }
      }
      let created = try await ChatCommands(
        client: fixture.client, sync: ChatSync(client: fixture.client)
      ).createThread()
      XCTAssertNil(created.selectedModel)
      XCTAssertEqual(createdRequests.withLock { $0.map(\.model) }, [nil])
      XCTAssertNil(createdRequests.withLock { $0.first?.serviceTier })
    }
  }

  func testCreatePreservesServiceTierOnlyWhenSupportedBySelectedModel() async throws {
    struct CreatedRequest: Decodable, Sendable {
      let model: String
      let serviceTier: String?
      let reasoningEffort: String?
    }
    let cases:
      [(availability: String, offeredTier: String?, savedTier: String, expectedTier: String?)] = [
        ("available", "priority", "priority", "priority"),
        ("reconnect_required", "priority", "priority", "priority"),
        ("plan_restricted", "priority", "priority", "priority"),
        ("available", nil, "priority", nil),
        ("available", "priority", "unsupported", nil),
      ]
    for selection in cases {
      let createdRequests = Mutex<[CreatedRequest]>([])
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/agents":
          return ChatHTTPResponse(
            body: """
              [{"agentId":"\(fixtureAgent)","isDefaultAgent":true,"displayName":"Okou"}]
              """)
        case "/api/user-model-preference":
          return ChatHTTPResponse(
            body: """
              {"selectedModel":"gpt-5.6-sol","serviceTier":"\(selection.savedTier)",\
              "modelSettings":{"gpt-5.6-sol":{"effort":"high"}}}
              """)
        case "/api/run-models":
          return runModelsResponse([
            SubscriptionRunModel(
              model: "gpt-5.6-sol", providerType: "codex-oauth-token",
              serviceTier: selection.offeredTier, availability: selection.availability)
          ])
        case "/api/model-catalog": return modelCatalogResponse()
        case "/api/chat-threads":
          let body = try JSONDecoder().decode(CreatedRequest.self, from: chatRequestBody(request))
          createdRequests.withLock { $0.append(body) }
          return ChatHTTPResponse(
            status: 201,
            body: """
              {"id":"\(newThread)","title":null,"createdAt":"\(fixtureDate)",\
              "selectedModel":"gpt-5.6-sol"}
              """)
        default: throw URLError(.unsupportedURL)
        }
      }
      _ = try await ChatCommands(
        client: fixture.client, sync: ChatSync(client: fixture.client)
      ).createThread()
      let context =
        "\(selection.availability), offered: \(selection.offeredTier ?? "none"), saved: \(selection.savedTier)"
      XCTAssertEqual(createdRequests.withLock { $0.map(\.model) }, ["gpt-5.6-sol"], context)
      XCTAssertEqual(
        createdRequests.withLock { $0.map(\.serviceTier) }, [selection.expectedTier], context)
      XCTAssertEqual(createdRequests.withLock { $0.map(\.reasoningEffort) }, ["high"], context)
    }
  }

  func testUpgradeRequiredBlocksHistory() async throws {
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(
        status: 426, body: "{\"error\":{\"message\":\"Client update required\"}}")
    }
    do {
      _ = try await ChatSync(client: fixture.client).history(threadID: fixtureThread)
      XCTFail("Expected upgrade-required response")
    } catch let error as APIClientError {
      XCTAssertEqual(error.statusCode, 426)
      XCTAssertEqual(error.errorDescription, "Update Okou in TestFlight to continue.")
    }
  }

  func testMissingThreadSnapshotDoesNotBecomeEmptyHistory() async throws {
    let tailReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: "{\"error\":{\"code\":\"CHAT_THREAD_NOT_FOUND\",\"message\":\"Chat not found\"}}")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        tailReads.withLock { $0 += 1 }
        throw URLError(.unsupportedURL)
      default: throw URLError(.unsupportedURL)
      }
    }

    do {
      _ = try await ChatSync(client: fixture.client).history(threadID: fixtureThread)
      XCTFail("A missing thread must not render as empty history")
    } catch let error as APIClientError {
      XCTAssertEqual(error.statusCode, 404)
    }
    XCTAssertEqual(tailReads.withLock { $0 }, 0)
  }

  func testListReplaysRenameDeletionAndNewThreadAfterSnapshot() async throws {
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[\(threadJSON(id: fixtureThread, date: "2026-09-17T10:00:00.123456")),\(threadJSON(id: deletedThread, date: "2026-09-17T10:00:00"))],"latestEventId":"\(eventIdentity(10))","latestSeqId":10}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(
          body: """
            {"events":[\(threadEventJSON(seq:11, kind:"renamed", thread:fixtureThread, title:"Latest title")),\(threadEventJSON(seq:12, kind:"deleted", thread:deletedThread)),\(threadEventJSON(seq:13, kind:"created", thread:newThread))],"hasMore":false}
            """)
      case "/api/indicators":
        return ChatHTTPResponse(
          body: "{\"agents\":{},\"threads\":{\"\(fixtureThread)\":\"unread\"}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let threads = try await ChatSync(client: fixture.client).threads()
    XCTAssertEqual(Set(threads.map(\.id)), [fixtureThread, newThread])
    XCTAssertEqual(threads.first(where: { $0.id == fixtureThread })?.title, "Latest title")
    XCTAssertEqual(threads.first(where: { $0.id == fixtureThread })?.indicator, .unread)
    let snapshotThread = try XCTUnwrap(threads.first(where: { $0.id == fixtureThread }))
    XCTAssertEqual(
      snapshotThread.createdAt.timeIntervalSince1970, 1_789_639_200.123456, accuracy: 0.000001)
  }

  func testListKeepsArchivedSnapshotAndReplaysUnarchive() async throws {
    let archivedThread = threadJSON(id: fixtureThread)
      .replacingOccurrences(of: "\"renamedAt\":null", with: "\"archived\":true,\"renamedAt\":null")
    let snapshotOnly = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(archivedThread)],\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let archived = try await ChatSync(client: snapshotOnly.client).threads()
    XCTAssertEqual(archived.first?.isArchived, true)

    let unarchivedEvent = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(archivedThread)],\"latestSeqId\":10}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(
          body:
            "{\"events\":[\(threadEventJSON(seq: 11, kind: "unarchived", thread: fixtureThread))],\"hasMore\":false}"
        )
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let unarchived = try await ChatSync(client: unarchivedEvent.client).threads()
    XCTAssertEqual(unarchived.first?.isArchived, false)
  }

  func testRestartReadsCachedListAndHistoryBeforeIncrementalCatchUp() async throws {
    let directory = try temporaryChatCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let requests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let since = chatQueryValue("sinceSeqId", in: request)
      requests.withLock { $0.append("\(path)?\(since ?? "")") }
      switch path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/list-snapshot","latestEventId":"\(eventIdentity(10))","latestSeqId":10}
            """)
      case "/list-snapshot":
        return ChatHTTPResponse(body: "{\"chatThreads\":[\(threadJSON(id: fixtureThread))]}")
      case "/api/chat-threads/events":
        if since == "10" {
          return ChatHTTPResponse(
            body:
              "{\"events\":[\(threadEventJSON(seq: 11, kind: "renamed", thread: fixtureThread, title: "Synced title"))],\"hasMore\":false}"
          )
        }
        guard since == "11" else { throw URLError(.badServerResponse) }
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/history-snapshot","lastEventId":"\(eventIdentity(1))","lastSeqId":1}
            """)
      case "/history-snapshot":
        return ChatHTTPResponse(
          body: eventJSON(seq: 1, type: "input.prompt", payload: userPayload("Hello")) + "\n")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        if since == "1" {
          return ChatHTTPResponse(
            body: """
              {"rows":[\(eventJSON(seq: 2, type: "output.message", payload: "{\"content\":\"Answer\"}")),\(eventJSON(seq: 3, type: "run.completed"))],"cursor":{"lastEventId":"\(eventIdentity(3))","lastSeqId":3},"hasMore":false}
              """)
        }
        guard since == "3" else { throw URLError(.badServerResponse) }
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(eventIdentity(3))\",\"lastSeqId\":3},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "warm-cache-user", workspaceID: "warm-cache-workspace")
    let first = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let firstThreads = try await first.threads()
    let firstHistory = try await first.history(threadID: fixtureThread)
    XCTAssertEqual(firstThreads.first?.title, "Synced title")
    XCTAssertEqual(firstHistory.messages.map(\.text), ["Hello", "Answer"])

    let requestsBeforeRestart = requests.withLock { $0.count }
    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let cachedThreads = await restarted.cachedThreads()
    let cachedHistory = await restarted.cachedHistory(threadID: fixtureThread)
    XCTAssertEqual(cachedThreads?.first?.title, "Synced title")
    XCTAssertEqual(cachedHistory?.messages.map(\.text), ["Hello", "Answer"])
    XCTAssertEqual(requests.withLock { $0.count }, requestsBeforeRestart)

    let restartedThreads = try await restarted.threads()
    let restartedHistory = try await restarted.history(threadID: fixtureThread)
    XCTAssertEqual(restartedThreads.first?.title, "Synced title")
    XCTAssertEqual(restartedHistory.messages.map(\.text), ["Hello", "Answer"])
    let paths = requests.withLock { $0 }
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/snapshot?" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/list-snapshot?" }.count, 1)
    XCTAssertEqual(
      paths.filter { $0 == "/api/chat-threads/\(fixtureThread)/event-snapshot?" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/history-snapshot?" }.count, 1)
    XCTAssertTrue(paths.contains("/api/chat-threads/events?11"))
    XCTAssertTrue(paths.contains("/api/chat-threads/\(fixtureThread)/event-rows?3"))
  }

  func testExpiredListAndHistoryCursorsReplacePersistedCacheAfterRestart() async throws {
    let directory = try temporaryChatCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let generation = Mutex(1)
    let requests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let since = chatQueryValue("sinceSeqId", in: request)
      let current = generation.withLock { $0 }
      requests.withLock { $0.append("\(path)?\(since ?? "")") }
      switch path {
      case "/api/chat-threads/snapshot":
        let sequence = current == 1 ? 10 : 20
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/list-snapshot","latestEventId":"\(eventIdentity(sequence))","latestSeqId":\(sequence)}
            """)
      case "/list-snapshot":
        let title = current == 1 ? "Old title" : "Rebased title"
        let thread = threadJSON(id: fixtureThread)
          .replacingOccurrences(of: "Original title", with: title)
        return ChatHTTPResponse(body: "{\"chatThreads\":[\(thread)]}")
      case "/api/chat-threads/events":
        if current == 2 && since == "10" {
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        }
        if current == 2 && since == "20" {
          return ChatHTTPResponse(
            body:
              "{\"events\":[\(threadEventJSON(seq: 21, kind: "renamed", thread: fixtureThread, title: "Current title"))],\"hasMore\":false}"
          )
        }
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        let sequence = current == 1 ? 1 : 3
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/history-snapshot","lastEventId":"\(eventIdentity(sequence))","lastSeqId":\(sequence)}
            """)
      case "/history-snapshot":
        if current == 1 {
          return ChatHTTPResponse(
            body: eventJSON(seq: 1, type: "input.prompt", payload: userPayload("Old question"))
              + "\n")
        }
        return ChatHTTPResponse(
          body: [
            eventJSON(seq: 1, type: "input.prompt", payload: userPayload("New question")),
            eventJSON(seq: 3, type: "output.message", payload: "{\"content\":\"New answer\"}"),
          ].joined(separator: "\n") + "\n")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        if current == 2 && since == "1" {
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        }
        if current == 2 && since == "3" {
          return ChatHTTPResponse(
            body: """
              {"rows":[\(eventJSON(seq: 4, type: "run.completed"))],"cursor":{"lastEventId":"\(eventIdentity(4))","lastSeqId":4},"hasMore":false}
              """)
        }
        let cursor = current == 1 ? 1 : 4
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(eventIdentity(cursor))\",\"lastSeqId\":\(cursor)},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "rebase-user", workspaceID: "rebase-workspace")
    let first = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let firstThreads = try await first.threads()
    let firstHistory = try await first.history(threadID: fixtureThread)
    XCTAssertEqual(firstThreads.first?.title, "Old title")
    XCTAssertEqual(firstHistory.messages.map(\.text), ["Old question"])

    generation.withLock { $0 = 2 }
    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let oldThreads = await restarted.cachedThreads()
    let oldHistory = await restarted.cachedHistory(threadID: fixtureThread)
    XCTAssertEqual(oldThreads?.first?.title, "Old title")
    XCTAssertEqual(oldHistory?.messages.map(\.text), ["Old question"])
    let rebuiltThreads = try await restarted.threads()
    let rebuiltHistory = try await restarted.history(threadID: fixtureThread)
    XCTAssertEqual(rebuiltThreads.first?.title, "Current title")
    XCTAssertEqual(rebuiltHistory.messages.map(\.text), ["New question", "New answer"])
    let rebuiltCachedThreads = await restarted.cachedThreads()
    let rebuiltCachedHistory = await restarted.cachedHistory(threadID: fixtureThread)
    XCTAssertEqual(rebuiltCachedThreads?.first?.title, "Current title")
    XCTAssertEqual(rebuiltCachedHistory?.messages.map(\.text), ["New question", "New answer"])
    let paths = requests.withLock { $0 }
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/snapshot?" }.count, 2)
    XCTAssertEqual(paths.filter { $0 == "/list-snapshot?" }.count, 2)
    XCTAssertEqual(
      paths.filter { $0 == "/api/chat-threads/\(fixtureThread)/event-snapshot?" }.count, 2)
    XCTAssertTrue(paths.contains("/api/chat-threads/events?10"))
    XCTAssertTrue(paths.contains("/api/chat-threads/events?20"))
    XCTAssertTrue(paths.contains("/api/chat-threads/\(fixtureThread)/event-rows?1"))
    XCTAssertTrue(paths.contains("/api/chat-threads/\(fixtureThread)/event-rows?3"))
  }

  func testExpiredSecondListPageRebasesWithoutSavingAbandonedTail() async throws {
    let directory = try temporaryChatCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let requests = Mutex<[String]>([])
    let snapshotReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let since = chatQueryValue("sinceSeqId", in: request)
      requests.withLock { $0.append("\(path)?\(since ?? "")") }
      switch path {
      case "/api/chat-threads/snapshot":
        let count = snapshotReads.withLock {
          $0 += 1
          return $0
        }
        guard count <= 2 else { throw URLError(.badServerResponse) }
        let sequence = count == 1 ? 10 : 20
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/list-snapshot-\(count)","latestEventId":"\(eventIdentity(sequence))","latestSeqId":\(sequence)}
            """)
      case "/list-snapshot-1":
        return ChatHTTPResponse(body: "{\"chatThreads\":[\(threadJSON(id: fixtureThread))]}")
      case "/list-snapshot-2":
        let thread = threadJSON(id: fixtureThread)
          .replacingOccurrences(of: "Original title", with: "Rebased title")
        return ChatHTTPResponse(body: "{\"chatThreads\":[\(thread)]}")
      case "/api/chat-threads/events":
        switch since {
        case "10":
          return ChatHTTPResponse(
            body:
              "{\"events\":[\(threadEventJSON(seq: 11, kind: "renamed", thread: fixtureThread, title: "Abandoned title"))],\"hasMore\":true}"
          )
        case "11":
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        case "20":
          return ChatHTTPResponse(
            body:
              "{\"events\":[\(threadEventJSON(seq: 21, kind: "renamed", thread: fixtureThread, title: "Final title"))],\"hasMore\":false}"
          )
        case "21":
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        default: throw URLError(.badServerResponse)
        }
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "paged-rebase-user",
      workspaceID: "paged-rebase-workspace")
    let first = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let resolved = try await first.threads()
    XCTAssertEqual(resolved.map(\.title), ["Final title"])
    let cached = await first.cachedThreads()
    XCTAssertEqual(cached?.map(\.title), ["Final title"])

    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let restored = await restarted.cachedThreads()
    XCTAssertEqual(restored?.map(\.title), ["Final title"])
    let caughtUp = try await restarted.threads()
    XCTAssertEqual(caughtUp.map(\.title), ["Final title"])
    XCTAssertEqual(snapshotReads.withLock { $0 }, 2)
    let paths = requests.withLock { $0 }
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/events?10" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/events?11" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/events?20" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/events?21" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/list-snapshot-1?" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/list-snapshot-2?" }.count, 1)
  }

  func testHistoryRecoversExpiredCursorAndNeverSendsBearerToSnapshot() async throws {
    struct State: Sendable {
      var snapshotCount = 0
      var tailCount = 0
      var snapshotAuthorization: String?
    }
    let state = Mutex(State())
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        let count = state.withLock {
          $0.snapshotCount += 1
          return $0.snapshotCount
        }
        let sequence = count == 1 ? 2 : 4
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/snapshot","expiresInSeconds":60,"lastEventId":"\(eventIdentity(sequence))","lastSeqId":\(sequence)}
            """)
      case "/snapshot":
        let count = state.withLock {
          $0.snapshotAuthorization = request.value(forHTTPHeaderField: "Authorization")
          return $0.snapshotCount
        }
        let rows =
          count == 1
          ? [
            eventJSON(seq: 1, type: "input.prompt", payload: userPayload("Hello")),
            eventJSON(seq: 2, type: "output.message", payload: "{\"content\":\"First answer\"}"),
          ]
          : [
            eventJSON(seq: 1, type: "input.prompt", payload: userPayload("Hello")),
            eventJSON(seq: 2, type: "output.message", payload: "{\"content\":\"First answer\"}"),
            eventJSON(seq: 4, type: "run.completed"),
          ]
        return ChatHTTPResponse(body: rows.joined(separator: "\n") + "\n")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        let count = state.withLock {
          $0.tailCount += 1
          return $0.tailCount
        }
        if count == 3 {
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        }
        let sequence = count <= 3 ? 2 : 4
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(eventIdentity(sequence))\",\"lastSeqId\":\(sequence)},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let service = ChatSync(client: fixture.client)
    let first = try await service.history(threadID: fixtureThread)
    XCTAssertEqual(first.messages.map(\.text), ["Hello", "First answer"])
    XCTAssertEqual(first.executionState, .running)
    let second = try await service.history(threadID: fixtureThread)
    XCTAssertEqual(second.messages.map(\.text), ["Hello", "First answer"])
    XCTAssertEqual(second.executionState, .completed)
    XCTAssertEqual(state.withLock { $0.snapshotCount }, 2)
    XCTAssertNil(state.withLock { $0.snapshotAuthorization })
  }

  func testOldHistoryPreservesAgentMentionNamesAndOtherPartLabels() async throws {
    let mixedMessage = """
      {"userMessage":{"version":1,"parts":[
        {"type":"text","text":"Ask"},
        {"type":"agent","agentId":"\(fixtureAgent)","nameSnapshot":"Release Scout"},
        {"type":"chat_thread","threadId":"\(fixtureThread)","titleSnapshot":"Release chat"},
        {"type":"source","kind":"agent","runId":"\(fixtureRun)","threadId":"\(fixtureThread)","agentId":"\(fixtureAgent)","titleSnapshot":"Earlier run","href":"https://app.okou.ai/chats/\(fixtureThread)"},
        {"type":"automation","workflowName":"Nightly review"},
        {"type":"file","fileId":"historical-file","filenameSnapshot":"plan.md","contentType":"text/markdown"}
      ]}}
      """.replacingOccurrences(of: "\n", with: "")
    let mentionOnlyMessage = """
      {"userMessage":{"version":1,"parts":[{"type":"agent","agentId":"\(fixtureAgent)","nameSnapshot":"Planner"}]}}
      """
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/snapshot","expiresInSeconds":60,"lastEventId":"\(eventIdentity(3))","lastSeqId":3}
            """)
      case "/snapshot":
        let rows = [
          eventJSON(seq: 1, type: "input.prompt", payload: mixedMessage),
          eventJSON(seq: 2, type: "input.prompt", payload: mentionOnlyMessage),
          eventJSON(seq: 3, type: "run.completed"),
        ]
        return ChatHTTPResponse(body: rows.joined(separator: "\n") + "\n")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        return ChatHTTPResponse(
          body: """
            {"rows":[],"cursor":{"lastEventId":"\(eventIdentity(3))","lastSeqId":3},"hasMore":false}
            """)
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }

    let history = try await ChatSync(client: fixture.client).history(threadID: fixtureThread)

    XCTAssertEqual(
      history.messages.map(\.text),
      [
        "Ask\nRelease Scout\nRelease chat\nEarlier run\nNightly review\nAttachment: plan.md (open this chat on the website to view)",
        "Planner",
      ])
    XCTAssertEqual(history.messages.map(\.role), [.user, .user])
  }

  func testSendResetsSharedOverridesAndUsesOriginalAgentWithoutModelOverride() async throws {
    struct State: Sendable {
      var overridden = true
      var browserEnabled = true
      var sends: [CapturedSend] = []
    }
    let state = Mutex(State())
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/connector-selections") {
        if request.httpMethod == "DELETE" {
          state.withLock { $0.overridden = false }
          return ChatHTTPResponse(status: 204, body: "")
        }
        return ChatHTTPResponse(
          body: state.withLock {
            $0.overridden
              ? "{\"selections\":[{\"connectionId\":\"\(fixtureRun)\",\"target\":{\"kind\":\"builtin\",\"connectorSlug\":\"github\"}}],\"selectedConnections\":[]}"
              : "{\"selections\":[],\"selectedConnections\":[]}"
          })
      }
      if path.hasSuffix("/metadata") {
        return ChatHTTPResponse(body: metadataJSON(browser: state.withLock { $0.browserEnabled }))
      }
      if path.hasSuffix("/computer-use-host") {
        let access = try JSONDecoder().decode(
          CapturedComputerAccess.self, from: chatRequestBody(request))
        guard access.hostIsExplicitNull && !access.cloudBrowserEnabled else {
          throw URLError(.badServerResponse)
        }
        state.withLock { $0.browserEnabled = false }
        return ChatHTTPResponse(status: 204, body: "")
      }
      if path == "/api/chat/events" {
        let body = try JSONDecoder().decode(CapturedSend.self, from: chatRequestBody(request))
        state.withLock { $0.sends.append(body) }
        return ChatHTTPResponse(
          status: 201, body: "{\"threadId\":\"\(fixtureThread)\",\"runId\":null}")
      }
      throw URLError(.unsupportedURL)
    }
    let receipt = try await ChatCommands(
      client: fixture.client, sync: ChatSync(client: fixture.client)
    ).send(
      thread: sampleThread(), text: "Steer this task", clientEventID: fixtureRun)
    XCTAssertEqual(receipt.clientEventID, fixtureRun)
    XCTAssertEqual(receipt.threadID, fixtureThread)
    let sent = try XCTUnwrap(state.withLock { $0.sends.first })
    XCTAssertEqual(sent.agentId, fixtureAgent)
    XCTAssertEqual(sent.prompt, "Steer this task")
    XCTAssertFalse(sent.hasModelOverride)
    XCTAssertTrue(sent.hostIsExplicitNull)
    XCTAssertFalse(sent.cloudBrowserEnabled)
    XCTAssertFalse(state.withLock { $0.overridden })
  }

  func testAmbiguousSendIsNotResubmittedAndExplicitRetryReusesIdentity() async throws {
    let attempts = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      if request.url?.path.hasSuffix("/connector-selections") == true {
        return ChatHTTPResponse(body: "{\"selections\":[],\"selectedConnections\":[]}")
      }
      if request.url?.path.hasSuffix("/metadata") == true {
        return ChatHTTPResponse(body: metadataJSON(browser: false))
      }
      if request.url?.path == "/api/chat/events" {
        let body = try JSONDecoder().decode(CapturedSend.self, from: chatRequestBody(request))
        let count = attempts.withLock {
          $0.append(body.clientEventId)
          return $0.count
        }
        if count == 1 { throw URLError(.networkConnectionLost) }
        return ChatHTTPResponse(
          status: 201, body: "{\"threadId\":\"\(fixtureThread)\",\"runId\":null}")
      }
      throw URLError(.unsupportedURL)
    }
    let service = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    do {
      _ = try await service.send(thread: sampleThread(), text: "Hello", clientEventID: fixtureRun)
      XCTFail("Expected an ambiguous network failure")
    } catch ChatError.sendUncertain {}
    XCTAssertEqual(attempts.withLock { $0 }, [fixtureRun])
    _ = try await service.send(thread: sampleThread(), text: "Hello", clientEventID: fixtureRun)
    XCTAssertEqual(attempts.withLock { $0 }, [fixtureRun, fixtureRun])
  }

  func testStopRecallsPendingUserInputAndInterruptsActiveRun() async throws {
    let commands = Mutex<[CapturedControl]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        if chatQueryValue("sinceSeqId", in: request) == "0" {
          return ChatHTTPResponse(
            body:
              "{\"rows\":[\(eventJSON(seq:1,type:"input.prompt",payload:userPayload("First"))),\(eventJSON(seq:2,type:"input.prompt",run:nil,payload:userPayload("Follow-up"))),\(eventJSON(seq:3,type:"input.automation",run:nil))],\"cursor\":{\"lastEventId\":\"\(eventIdentity(3))\",\"lastSeqId\":3},\"hasMore\":false}"
          )
        }
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(eventIdentity(3))\",\"lastSeqId\":3},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      case "/api/chat/events":
        let control = try JSONDecoder().decode(CapturedControl.self, from: chatRequestBody(request))
        commands.withLock { $0.append(control) }
        return ChatHTTPResponse(
          status: 201, body: "{\"threadId\":\"\(fixtureThread)\",\"runId\":null}")
      default: throw URLError(.unsupportedURL)
      }
    }
    try await ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client)).stop(
      thread: sampleThread())
    XCTAssertEqual(
      commands.withLock { $0.compactMap(\.revokesEventId) }, [eventIdentity(2), eventIdentity(3)])
    XCTAssertEqual(commands.withLock { $0.compactMap(\.interruptsRunId) }, [fixtureRun])
  }
}

private struct CapturedSend: Decodable, Sendable {
  let agentId: String
  let prompt: String
  let clientEventId: String
  let cloudBrowserEnabled: Bool
  let hostIsExplicitNull: Bool
  let hasModelOverride: Bool
  enum Keys: String, CodingKey {
    case agentId, prompt, clientEventId, cloudBrowserEnabled, computerUseHostId, model
  }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    agentId = try c.decode(String.self, forKey: .agentId)
    prompt = try c.decode(String.self, forKey: .prompt)
    clientEventId = try c.decode(String.self, forKey: .clientEventId)
    cloudBrowserEnabled = try c.decode(Bool.self, forKey: .cloudBrowserEnabled)
    hostIsExplicitNull =
      try c.contains(.computerUseHostId) && c.decodeNil(forKey: .computerUseHostId)
    hasModelOverride = c.contains(.model)
  }
}

private struct CapturedComputerAccess: Decodable {
  let cloudBrowserEnabled: Bool
  let hostIsExplicitNull: Bool
  enum Keys: String, CodingKey { case cloudBrowserEnabled, computerUseHostId }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    cloudBrowserEnabled = try c.decode(Bool.self, forKey: .cloudBrowserEnabled)
    hostIsExplicitNull =
      try c.contains(.computerUseHostId) && c.decodeNil(forKey: .computerUseHostId)
  }
}

private struct CapturedControl: Decodable, Sendable {
  let revokesEventId: String?
  let interruptsRunId: String?
}

private func sampleThread() -> ChatThread {
  ChatThread(
    id: fixtureThread, agentID: fixtureAgent, title: "Existing chat",
    selectedModel: "claude-opus-5-5",
    createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0),
    sortAt: Date(timeIntervalSince1970: 0),
    pinnedAt: nil, pinOrder: nil, indicator: nil)
}

private func threadJSON(id: String, date: String = fixtureDate) -> String {
  "{\"id\":\"\(id)\",\"agentId\":\"\(fixtureAgent)\",\"title\":\"Original title\",\"sortAt\":\"\(date)\",\"createdAt\":\"\(date)\",\"updatedAt\":\"\(date)\",\"pinnedAt\":null,\"renamedAt\":null,\"selectedModel\":\"gpt-5.6-sol\",\"serviceTier\":null,\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
}

private func threadEventJSON(seq: Int, kind: String, thread: String, title: String = "New chat")
  -> String
{
  "{\"id\":\"\(eventIdentity(seq))\",\"seqId\":\(seq),\"kind\":\"\(kind)\",\"chatThreadId\":\"\(thread)\",\"agentId\":\"\(fixtureAgent)\",\"title\":\"\(title)\",\"selectedModel\":\"gpt-5.6-sol\",\"createdAt\":\"\(fixtureDate)\"}"
}

private func eventJSON(seq: Int, type: String, run: String? = fixtureRun, payload: String = "null")
  -> String
{
  "{\"id\":\"\(eventIdentity(seq))\",\"chatThreadId\":\"\(fixtureThread)\",\"runId\":\(run.map { "\"\($0)\"" } ?? "null"),\"revokesEventId\":null,\"contextType\":null,\"contextId\":null,\"runEventSequenceNumber\":null,\"runEventId\":null,\"seqId\":\(seq),\"createdAt\":\"\(fixtureDate)\",\"eventType\":\"\(type)\",\"payload\":\(payload)}"
}

private func eventIdentity(_ sequence: Int) -> String {
  String(format: "20000000-0000-4000-8000-%012d", sequence)
}

private func chatQueryValue(_ name: String, in request: URLRequest) -> String? {
  guard let url = request.url else { return nil }
  return URLComponents(url: url, resolvingAgainstBaseURL: false)?
    .queryItems?.first(where: { $0.name == name })?.value
}

private func temporaryChatCacheDirectory() throws -> URL {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("okou-chat-cache-tests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  return directory
}

private func userPayload(_ text: String) -> String {
  "{\"userMessage\":{\"version\":1,\"parts\":[{\"type\":\"text\",\"text\":\"\(text)\"}]}}"
}

private func metadataJSON(browser: Bool) -> String {
  "{\"id\":\"\(fixtureThread)\",\"agentId\":\"\(fixtureAgent)\",\"title\":\"Existing chat\",\"selectedModel\":\"claude-opus-5-5\",\"modelSettings\":{},\"serviceTier\":null,\"pinnedAt\":null,\"computerUseHostId\":null,\"cloudBrowserEnabled\":\(browser),\"selectedImageModel\":null}"
}
