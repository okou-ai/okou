import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatCommandContractTests: XCTestCase {
  func testNativeThreadActionsUseCanonicalEndpoints() async throws {
    struct Request {
      let method: String
      let path: String
      let body: String
    }
    let requests = Mutex<[Request]>([])
    let queries = Mutex<[[URLQueryItem]]>([])
    let pinEventID = UUID().uuidString
    let unpinEventID = UUID().uuidString
    let muteEventID = UUID().uuidString
    let unmuteEventID = UUID().uuidString
    let archiveEventID = UUID().uuidString
    let renameEventID = UUID().uuidString
    let fixture = ChatHTTPFixture { request in
      queries.withLock {
        $0.append(
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? [])
      }
      try requests.withLock {
        $0.append(
          Request(
            method: request.httpMethod ?? "", path: request.url?.path ?? "",
            body: try XCTUnwrap(String(data: chatRequestBody(request), encoding: .utf8))))
      }
      return ChatHTTPResponse(status: 204, body: "")
    }
    let service = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    try await service.setPinned(
      threadID: fixtureThread, pinned: true, eventID: pinEventID, pinOrder: "a0")
    try await service.setPinned(threadID: fixtureThread, pinned: false, eventID: unpinEventID)
    try await service.setArchived(threadID: fixtureThread, archived: true, eventID: archiveEventID)
    try await service.setArchived(threadID: fixtureThread, archived: false)
    try await service.setMuted(threadID: fixtureThread, muted: true, eventID: muteEventID)
    try await service.setMuted(threadID: fixtureThread, muted: false, eventID: unmuteEventID)
    try await service.rename(threadID: fixtureThread, title: "Renamed", eventID: renameEventID)

    XCTAssertEqual(requests.withLock { $0.map(\.method) }, Array(repeating: "POST", count: 7))
    XCTAssertEqual(
      requests.withLock { $0.map(\.path) },
      [
        "/api/chat-threads/\(fixtureThread)/pin",
        "/api/chat-threads/\(fixtureThread)/unpin",
        "/api/chat-threads/\(fixtureThread)/archive",
        "/api/chat-threads/\(fixtureThread)/unarchive",
        "/api/chat-threads/\(fixtureThread)/mute",
        "/api/chat-threads/\(fixtureThread)/unmute",
        "/api/chat-threads/\(fixtureThread)/rename"
      ])
    let renameBody = try XCTUnwrap(requests.withLock { $0.last?.body })
    XCTAssertEqual(
      try JSONDecoder().decode([String: String].self, from: Data(renameBody.utf8)),
      ["title": "Renamed", "eventId": renameEventID])
    XCTAssertEqual(
      queries.withLock { $0[0] },
      [
        URLQueryItem(name: "eventId", value: pinEventID),
        URLQueryItem(name: "pinOrder", value: "a0")
      ])
    XCTAssertEqual(queries.withLock { $0[1] }, [URLQueryItem(name: "eventId", value: unpinEventID)])
    XCTAssertEqual(
      queries.withLock { $0[2] }, [URLQueryItem(name: "eventId", value: archiveEventID)])
    XCTAssertEqual(queries.withLock { $0[4] }, [URLQueryItem(name: "eventId", value: muteEventID)])
    XCTAssertEqual(
      queries.withLock { $0[5] }, [URLQueryItem(name: "eventId", value: unmuteEventID)])
  }

  func testCreateUsesSavedModelWithoutAgentLookup() async throws {
    struct CreatedRequest: Decodable, Sendable {

      let model: String
      let reasoningEffort: String?
    }
    let createdRequests = Mutex<[CreatedRequest]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
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
    XCTAssertEqual(created.selectedModel, "gpt-5.6-sol")
    XCTAssertEqual(createdRequests.withLock { $0.map(\.model) }, ["gpt-5.6-sol"])
    XCTAssertEqual(createdRequests.withLock { $0.map(\.reasoningEffort) }, ["high"])
  }

  func testCreateWithoutSavedModelSendsAutoAsExplicitNull() async throws {
    for selectedModelJSON in ["null", #""auto""#, #""okou-1.0""#] {
      let explicitNullModels = Mutex<[Bool]>([])
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/user-model-preference":
          return ChatHTTPResponse(
            body:
              "{\"selectedModel\":\(selectedModelJSON),\"serviceTier\":null,\"modelSettings\":{},\"selectedImageModel\":null,\"updatedAt\":null}"
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
  }

  func testCreateResolvesRetiredSavedModelThroughCatalog() async throws {
    struct CreatedRequest: Decodable, Sendable {
      let model: String
      let reasoningEffort: String?
    }
    let createdRequests = Mutex<[CreatedRequest]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
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
    struct Selection {
      let availability: String
      let offeredTier: String?
      let savedTier: String
      let expectedTier: String?
    }
    let cases = [
      Selection(
        availability: "available", offeredTier: "priority", savedTier: "priority",
        expectedTier: "priority"),
      Selection(
        availability: "reconnect_required", offeredTier: "priority", savedTier: "priority",
        expectedTier: "priority"),
      Selection(
        availability: "plan_restricted", offeredTier: "priority", savedTier: "priority",
        expectedTier: "priority"),
      Selection(
        availability: "available", offeredTier: nil, savedTier: "priority", expectedTier: nil),
      Selection(
        availability: "available", offeredTier: "priority", savedTier: "unsupported",
        expectedTier: nil)
    ]
    for selection in cases {
      let createdRequests = Mutex<[CreatedRequest]>([])
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
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

  func testAPIRequestsAdvertiseIOSClientIdentity() async throws {
    struct ClientHeaders: Sendable {
      let type, version, sessionID, requestID: String?
    }
    let observed = Mutex<[ClientHeaders]>([])
    let handler: ChatHTTPFixture.Handler = { request in
      observed.withLock {
        $0.append(
          ClientHeaders(
            type: request.value(forHTTPHeaderField: "X-Client-Type"),
            version: request.value(forHTTPHeaderField: "X-Client-Version"),
            sessionID: request.value(forHTTPHeaderField: "X-Client-Session-Id"),
            requestID: request.value(forHTTPHeaderField: "X-Client-Request-Id")))
      }
      return ChatHTTPResponse(status: 204, body: "")
    }
    let fixture = ChatHTTPFixture(clientVersion: "4.5.6", handler: handler)
    let otherFixture = ChatHTTPFixture(clientVersion: "4.5.6", handler: handler)
    let client = fixture.client
    try await client.data("/api/indicators")
    try await client.data("/api/chat-threads/\(fixtureThread)/pin", method: "POST")
    try await otherFixture.client.data("/api/indicators")

    let headers = observed.withLock { $0 }
    XCTAssertEqual(headers.map(\.type), ["iOS", "iOS", "iOS"])
    XCTAssertEqual(headers.map(\.version), ["4.5.6", "4.5.6", "4.5.6"])
    let sessionID = try XCTUnwrap(headers.first?.sessionID)
    XCTAssertNotNil(UUID(uuidString: sessionID))
    XCTAssertEqual(sessionID, sessionID.lowercased())
    XCTAssertEqual(headers.map(\.sessionID).dropLast(), [sessionID, sessionID])
    XCTAssertNotEqual(headers.last?.sessionID, sessionID)
    XCTAssertEqual(Set(headers.compactMap(\.requestID)).count, 3)
  }

  func testSendPreservesConnectorSelectionsAndBrowserWithoutModelOverride() async throws {
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
      if path == "/api/chat/events" {
        let body = try JSONDecoder().decode(CapturedSend.self, from: chatRequestBody(request))
        state.withLock { $0.sends.append(body) }
        return ChatHTTPResponse(
          status: 201, body: "{\"threadId\":\"\(fixtureThread)\"}")
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
    XCTAssertFalse(sent.hasAgentId)
    XCTAssertEqual(sent.prompt, "Steer this task")
    XCTAssertFalse(sent.hasModelOverride)
    XCTAssertTrue(sent.hostIsExplicitNull)
    XCTAssertTrue(sent.cloudBrowserEnabled)
    XCTAssertTrue(state.withLock { $0.overridden })
  }

  func testSendPreservesTheSelectedComputerUseHost() async throws {
    struct Sent: Decodable, Sendable {
      let computerUseHostId: String
      let cloudBrowserEnabled: Bool
    }
    let sent = Mutex<Sent?>(nil)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/metadata") {
        return ChatHTTPResponse(
          body: metadataJSON(browser: false).replacingOccurrences(
            of: "\"computerUseHostId\":null", with: "\"computerUseHostId\":\"\(fixtureRun)\""))
      }
      if request.url!.path == "/api/chat/events" {
        let body = try JSONDecoder().decode(Sent.self, from: chatRequestBody(request))
        sent.withLock { $0 = body }
        return ChatHTTPResponse(status: 201, body: "{\"threadId\":\"\(fixtureThread)\"}")
      }
      throw URLError(.unsupportedURL)
    }
    _ = try await ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
      .send(thread: sampleThread(), text: "Use my computer")
    let request = try XCTUnwrap(sent.withLock { $0 })
    XCTAssertEqual(request.computerUseHostId, fixtureRun)
    XCTAssertFalse(request.cloudBrowserEnabled)
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
          status: 201, body: "{\"threadId\":\"\(fixtureThread)\"}")
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
              "{\"rows\":[\(eventJSON(seq: 1, type: "input.prompt", payload: userPayload("First"))),\(eventJSON(seq: 2, type: "input.prompt", run: nil, payload: userPayload("Follow-up"))),\(eventJSON(seq: 3, type: "input.automation", run: nil))],\"cursor\":{\"lastEventId\":\"\(eventIdentity(3))\",\"lastSeqId\":3},\"hasMore\":false}"
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
          status: 201, body: "{\"threadId\":\"\(fixtureThread)\"}")
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
