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
final class ChatServiceTests: XCTestCase {
  func testCreateUsesDefaultAgentAndSavedModelWithoutOnboardingBootstrap() async throws {
    struct CreatedRequest: Decodable, Sendable {
      let agentId: String
      let model: String
      let reasoningEffort: String?
    }
    let createdRequest = Mutex<CreatedRequest?>(nil)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body:
            "[{\"agentId\":\"\(fixtureAgent)\",\"isDefaultAgent\":true,\"ownerId\":\"test-user\",\"description\":null,\"displayName\":\"Okou\",\"sound\":null,\"avatarUrl\":null,\"visibility\":\"private\"}]"
        )
      case "/api/user-model-preference":
        return ChatHTTPResponse(
          body:
            "{\"selectedModel\":\"gpt-5.6-sol\",\"serviceTier\":null,\"modelSettings\":{\"gpt-5.6-sol\":{\"effort\":\"high\"}},\"selectedVideoModel\":null,\"selectedImageModel\":null,\"updatedAt\":null}"
        )
      case "/api/model-policies":
        return ChatHTTPResponse(
          body:
            "{\"revision\":\"test\",\"writePreconditionRequired\":true,\"policies\":[],\"workspaceDefaultModel\":\"claude-sonnet-5\",\"workspaceDefaultPolicyId\":null}"
        )
      case "/api/chat-threads":
        let body = try JSONDecoder().decode(CreatedRequest.self, from: chatRequestBody(request))
        createdRequest.withLock { $0 = body }
        return ChatHTTPResponse(
          status: 201,
          body:
            "{\"id\":\"\(newThread)\",\"title\":null,\"createdAt\":\"\(fixtureDate)\",\"selectedModel\":\"gpt-5.6-sol\",\"serviceTier\":null}"
        )
      default: throw URLError(.unsupportedURL)
      }
    }
    let created = try await ChatService(client: fixture.client).createThread()
    XCTAssertEqual(created.agentID, fixtureAgent)
    XCTAssertEqual(created.selectedModel, "gpt-5.6-sol")
    XCTAssertEqual(createdRequest.withLock { $0?.agentId }, fixtureAgent)
    XCTAssertEqual(createdRequest.withLock { $0?.model }, "gpt-5.6-sol")
    XCTAssertEqual(createdRequest.withLock { $0?.reasoningEffort }, "high")
  }

  func testUnsupportedEventSchemaRequiresAnUpdate() async throws {
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(
        status: 426, body: "{\"error\":{\"message\":\"Unsupported Chat Event schema version\"}}")
    }
    do {
      _ = try await ChatService(client: fixture.client).history(threadID: fixtureThread)
      XCTFail("Expected upgrade-required response")
    } catch let error as APIClientError {
      XCTAssertEqual(error.statusCode, 426)
      XCTAssertEqual(error.errorDescription, "Update Okou in TestFlight to continue.")
    }
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
    let threads = try await ChatService(client: fixture.client).threads()
    XCTAssertEqual(Set(threads.map(\.id)), [fixtureThread, newThread])
    XCTAssertEqual(threads.first(where: { $0.id == fixtureThread })?.title, "Latest title")
    XCTAssertEqual(threads.first(where: { $0.id == fixtureThread })?.indicator, .unread)
    let snapshotThread = try XCTUnwrap(threads.first(where: { $0.id == fixtureThread }))
    XCTAssertEqual(
      snapshotThread.createdAt.timeIntervalSince1970, 1_789_639_200.123456, accuracy: 0.000001)
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
        if count == 2 {
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        }
        let sequence = count == 1 ? 2 : 4
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(eventIdentity(sequence))\",\"lastSeqId\":\(sequence)},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let service = ChatService(client: fixture.client)
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

    let history = try await ChatService(client: fixture.client).history(threadID: fixtureThread)

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
    let receipt = try await ChatService(client: fixture.client).send(
      thread: sampleThread(), text: "Steer this task", clientEventID: fixtureRun)
    XCTAssertEqual(receipt.clientEventID, fixtureRun)
    XCTAssertNil(receipt.runID)
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
          status: 201, body: "{\"threadId\":\"\(fixtureThread)\",\"runId\":\"\(fixtureRun)\"}")
      }
      throw URLError(.unsupportedURL)
    }
    let service = ChatService(client: fixture.client)
    do {
      _ = try await service.send(thread: sampleThread(), text: "Hello", clientEventID: fixtureRun)
      XCTFail("Expected an ambiguous network failure")
    } catch ChatServiceError.sendUncertain {}
    XCTAssertEqual(attempts.withLock { $0 }, [fixtureRun])
    _ = try await service.send(thread: sampleThread(), text: "Hello", clientEventID: fixtureRun)
    XCTAssertEqual(attempts.withLock { $0 }, [fixtureRun, fixtureRun])
  }

  func testStopRecallsPendingUserInputAndInterruptsActiveRun() async throws {
    let commands = Mutex<[CapturedControl]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        return ChatHTTPResponse(
          body:
            "{\"rows\":[\(eventJSON(seq:1,type:"input.prompt",payload:userPayload("First"))),\(eventJSON(seq:2,type:"input.prompt",run:nil,payload:userPayload("Follow-up")))],\"cursor\":{\"lastEventId\":\"\(eventIdentity(2))\",\"lastSeqId\":2},\"hasMore\":false}"
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
    try await ChatService(client: fixture.client).stop(thread: sampleThread())
    XCTAssertEqual(commands.withLock { $0.compactMap(\.revokesEventId) }, [eventIdentity(2)])
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
    selectedModel: "claude-sonnet-5",
    createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0),
    sortAt: Date(timeIntervalSince1970: 0),
    pinnedAt: nil, pinOrder: nil, indicator: nil)
}

private func threadJSON(id: String, date: String = fixtureDate) -> String {
  "{\"id\":\"\(id)\",\"agentId\":\"\(fixtureAgent)\",\"title\":\"Original title\",\"sortAt\":\"\(date)\",\"createdAt\":\"\(date)\",\"updatedAt\":\"\(date)\",\"pinnedAt\":null,\"renamedAt\":null,\"selectedModel\":\"gpt-5.6-sol\",\"serviceTier\":null,\"computerUseHostId\":null,\"cloudBrowserEnabled\":false,\"selectedVideoModel\":null}"
}

private func threadEventJSON(seq: Int, kind: String, thread: String, title: String = "New chat")
  -> String
{
  "{\"id\":\"\(eventIdentity(seq))\",\"seqId\":\(seq),\"kind\":\"\(kind)\",\"chatThreadId\":\"\(thread)\",\"agentId\":\"\(fixtureAgent)\",\"title\":\"\(title)\",\"selectedModel\":\"gpt-5.6-sol\",\"selectedVideoModel\":null,\"createdAt\":\"\(fixtureDate)\"}"
}

private func eventJSON(seq: Int, type: String, run: String? = fixtureRun, payload: String = "null")
  -> String
{
  "{\"id\":\"\(eventIdentity(seq))\",\"chatThreadId\":\"\(fixtureThread)\",\"runId\":\(run.map { "\"\($0)\"" } ?? "null"),\"revokesEventId\":null,\"contextType\":null,\"contextId\":null,\"runEventSequenceNumber\":null,\"runEventId\":null,\"seqId\":\(seq),\"createdAt\":\"\(fixtureDate)\",\"eventType\":\"\(type)\",\"payload\":\(payload)}"
}

private func eventIdentity(_ sequence: Int) -> String {
  String(format: "20000000-0000-4000-8000-%012d", sequence)
}

private func userPayload(_ text: String) -> String {
  "{\"userMessage\":{\"version\":1,\"parts\":[{\"type\":\"text\",\"text\":\"\(text)\"}]}}"
}

private func metadataJSON(browser: Bool) -> String {
  "{\"id\":\"\(fixtureThread)\",\"agentId\":\"\(fixtureAgent)\",\"title\":\"Existing chat\",\"selectedModel\":\"claude-sonnet-5\",\"modelSettings\":{},\"serviceTier\":null,\"pinnedAt\":null,\"computerUseHostId\":null,\"cloudBrowserEnabled\":\(browser),\"selectedVideoModel\":null,\"selectedImageModel\":null}"
}
