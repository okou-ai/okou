import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceStoreTests: XCTestCase {
  func testRefreshDuringOldHistoryReadRendersFinalAnswer() async throws {
    let oldReadStarted = expectation(description: "The old history response is in flight")
    let releaseOldResponse = HTTPResponseGate()
    defer { releaseOldResponse.open() }
    let historyReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let firstRead = historyReads.withLock {
          $0 += 1
          return $0 == 1
        }
        if firstRead {
          oldReadStarted.fulfill()
          await releaseOldResponse.wait()
          return historyPage(
            rows: [
              historyEvent(
                sequence: 1, type: "input.prompt",
                payload: """
                  {"userMessage":{"version":1,"parts":[{"type":"text","text":"Hello"}]}}
                  """)
            ],
            lastSequence: 1)
        }
        return historyPage(
          rows: [
            historyEvent(
              sequence: 2, type: "output.message", payload: "{\"content\":\"Final answer\"}"),
            historyEvent(sequence: 3, type: "run.completed"),
          ], lastSequence: 3)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Existing chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    store.path = [storeThreadID]
    let initialRead = Task { await store.loadHistory(storeThreadID) }
    await fulfillment(of: [oldReadStarted], timeout: 2)

    // A final-result invalidation enters refresh while the detail view's old read is pending.
    // Awaiting the reconciler makes the ordering deterministic without a live Ably connection.
    await store.refresh()
    releaseOldResponse.open()
    await initialRead.value

    XCTAssertEqual(store.messages(for: storeThreadID).map(\.text), ["Hello", "Final answer"])
    XCTAssertEqual(store.messages(for: storeThreadID).last?.role, .assistant)
    XCTAssertEqual(store.histories[storeThreadID]?.executionState, .completed)
    XCTAssertNil(store.threadErrors[storeThreadID])
  }

  func testRefreshDuringOldListReadRendersLatestTitle() async throws {
    let oldReadStarted = expectation(description: "The old chat list response is in flight")
    let releaseOldResponse = HTTPResponseGate()
    defer { releaseOldResponse.open() }
    let snapshotReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        let firstRead = snapshotReads.withLock {
          $0 += 1
          return $0 == 1
        }
        if firstRead {
          oldReadStarted.fulfill()
          await releaseOldResponse.wait()
          return threadSnapshot(title: "Original title")
        }
        return threadSnapshot(title: "Latest title")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    let initialRead = Task { await store.refresh() }
    await fulfillment(of: [oldReadStarted], timeout: 2)

    await store.refresh()
    releaseOldResponse.open()
    await initialRead.value

    XCTAssertEqual(store.threads.map(\.id), [storeThreadID])
    XCTAssertEqual(store.threads.map(\.title), ["Latest title"])
    XCTAssertNil(store.error)
  }

  func testDelayedCreateResponsePreservesOneLatestThreadFromList() async throws {
    let createStarted = expectation(description: "Create has committed but its response is delayed")
    let releaseCreateResponse = HTTPResponseGate()
    defer { releaseCreateResponse.open() }
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"ownerId":"test-user","description":null,"displayName":"Okou","sound":null,"avatarUrl":null,"visibility":"private"}]
            """)
      case "/api/user-model-preference":
        return ChatHTTPResponse(
          body: """
            {"selectedModel":null,"serviceTier":null,"modelSettings":{},"selectedVideoModel":null,"selectedImageModel":null,"updatedAt":null}
            """)
      case "/api/model-policies":
        return ChatHTTPResponse(
          body: """
            {"revision":"test","writePreconditionRequired":true,"policies":[],"workspaceDefaultModel":"gpt-5.6-sol","workspaceDefaultPolicyId":null}
            """)
      case "/api/chat-threads":
        guard request.httpMethod == "POST" else { throw URLError(.unsupportedURL) }
        createStarted.fulfill()
        await releaseCreateResponse.wait()
        return ChatHTTPResponse(
          status: 201,
          body: """
            {"id":"\(storeThreadID)","title":null,"createdAt":"\(storeDate)","selectedModel":"gpt-5.6-sol","serviceTier":null}
            """)
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Latest title")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    let creation = Task { await store.createChat() }
    await fulfillment(of: [createStarted], timeout: 2)

    await store.refresh()
    XCTAssertEqual(store.threads.map(\.title), ["Latest title"])
    releaseCreateResponse.open()
    await creation.value

    XCTAssertEqual(store.threads.map(\.id), [storeThreadID])
    XCTAssertEqual(store.threads.map(\.title), ["Latest title"])
    XCTAssertEqual(store.path, [storeThreadID])
    XCTAssertNil(store.error)
  }

  func testHistoryMarksReadOnlyForVisibleForegroundThread() async throws {
    let unread = Mutex(true)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Unread reply")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        let indicators = unread.withLock { $0 ? "\"\(storeThreadID)\":\"unread\"" : "" }
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{\(indicators)}}")
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value
        let rows =
          cursor == "0"
          ? [
            historyEvent(
              sequence: 1, type: "output.message", payload: "{\"content\":\"Unread answer\"}"),
            historyEvent(sequence: 2, type: "run.completed"),
          ] : []
        return historyPage(rows: rows, lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/\(storeThreadID)/mark-read":
        guard request.httpMethod == "POST" else { throw URLError(.unsupportedURL) }
        unread.withLock { $0 = false }
        return ChatHTTPResponse(status: 204, body: "")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.refresh()

    store.path = [storeThreadID]
    store.setForeground(false)
    await store.loadHistory(storeThreadID)
    XCTAssertEqual(store.messages(for: storeThreadID).map(\.text), ["Unread answer"])
    XCTAssertEqual(store.threads.first?.indicator, .unread)
    XCTAssertTrue(unread.withLock { $0 })

    store.setForeground(true)
    store.path = ["40000000-0000-4000-8000-000000000004"]
    await store.loadHistory(storeThreadID)
    XCTAssertEqual(store.threads.first?.indicator, .unread)
    XCTAssertTrue(unread.withLock { $0 })

    store.path = [storeThreadID]
    await store.loadHistory(storeThreadID)
    XCTAssertNil(store.threads.first?.indicator)
    XCTAssertNil(store.threadErrors[storeThreadID])

    // Reloading the list verifies the cleared badge reflects the HTTP mark-read result.
    store.path = []
    await store.refresh()
    XCTAssertNil(store.threads.first?.indicator)
    XCTAssertNil(store.error)
  }

  func testClosedStoreIgnoresDelayedHistoryAndDoesNotAffectFreshStore() async throws {
    let oldReadStarted = expectation(description: "Old store is waiting for history")
    let releaseOldResponse = HTTPResponseGate()
    defer { releaseOldResponse.open() }
    let oldMarkReadRequests = Mutex<[String]>([])
    let oldFixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Old workspace chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"threads\":{\"\(storeThreadID)\":\"unread\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        oldReadStarted.fulfill()
        await releaseOldResponse.wait()
        return historyPage(
          rows: [
            historyEvent(
              sequence: 1, type: "output.message", payload: "{\"content\":\"Old workspace answer\"}"
            ),
            historyEvent(sequence: 2, type: "run.completed"),
          ], lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      case "/api/chat-threads/\(storeThreadID)/mark-read":
        oldMarkReadRequests.withLock { $0.append(request.httpMethod ?? "") }
        return ChatHTTPResponse(status: 204, body: "")
      default: throw URLError(.unsupportedURL)
      }
    }
    let oldStore = WorkspaceStore(client: oldFixture.client, webURL: oldFixture.baseURL)
    defer { oldStore.close() }
    await oldStore.refresh()
    oldStore.setForeground(true)
    oldStore.path = [storeThreadID]
    let oldRead = Task { await oldStore.loadHistory(storeThreadID) }
    await fulfillment(of: [oldReadStarted], timeout: 2)
    oldStore.close()

    let freshFixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Fresh workspace chat")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators": return ChatHTTPResponse(body: "{\"threads\":{}}")
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"No snapshot\"}}")
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        return historyPage(
          rows: [
            historyEvent(
              sequence: 1, type: "output.message",
              payload: "{\"content\":\"Fresh workspace answer\"}"),
            historyEvent(sequence: 2, type: "run.completed"),
          ], lastSequence: 2)
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    // The same thread identity deliberately verifies that history caches belong to each store.
    let freshStore = WorkspaceStore(client: freshFixture.client, webURL: freshFixture.baseURL)
    defer { freshStore.close() }
    freshStore.setForeground(true)
    freshStore.path = [storeThreadID]
    await freshStore.refresh()
    XCTAssertEqual(freshStore.messages(for: storeThreadID).map(\.text), ["Fresh workspace answer"])

    releaseOldResponse.open()
    await oldRead.value

    XCTAssertTrue(oldStore.messages(for: storeThreadID).isEmpty)
    XCTAssertTrue(oldMarkReadRequests.withLock { $0.isEmpty })
    XCTAssertEqual(freshStore.messages(for: storeThreadID).map(\.text), ["Fresh workspace answer"])
    XCTAssertEqual(freshStore.threads.map(\.title), ["Fresh workspace chat"])
    XCTAssertNil(freshStore.error)
    XCTAssertNil(freshStore.threadErrors[storeThreadID])
  }

  func testRetryReconcilesPersistedInputIncludingRevokedInputWithoutResending() async throws {
    struct SentInput: Decodable, Sendable {
      let clientEventId: String
      let prompt: String
    }
    for revoked in [false, true] {
      let sentInputs = Mutex<[SentInput]>([])
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/chat-threads/snapshot": return threadSnapshot(title: "Existing chat")
        case "/api/chat-threads/events":
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        case "/api/indicators": return ChatHTTPResponse(body: "{\"threads\":{}}")
        case "/api/chat-threads/\(storeThreadID)/connector-selections":
          return ChatHTTPResponse(body: "{\"selections\":[],\"selectedConnections\":[]}")
        case "/api/chat-threads/\(storeThreadID)/metadata":
          return ChatHTTPResponse(
            body: """
              {"id":"\(storeThreadID)","agentId":"\(storeAgentID)","title":"Existing chat","selectedModel":"gpt-5.6-sol","computerUseHostId":null,"cloudBrowserEnabled":false}
              """)
        case "/api/chat/events":
          guard request.httpMethod == "POST" else { throw URLError(.unsupportedURL) }
          let input = try JSONDecoder().decode(SentInput.self, from: chatRequestBody(request))
          sentInputs.withLock { $0.append(input) }
          // The server accepted this identity, but the response never reaches the client.
          throw URLError(.networkConnectionLost)
        case "/api/chat-threads/\(storeThreadID)/event-snapshot":
          return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"No snapshot\"}}")
        case "/api/chat-threads/\(storeThreadID)/event-rows":
          guard let input = sentInputs.withLock({ $0.first }) else {
            throw URLError(.badServerResponse)
          }
          var rows = [
            historyEvent(
              sequence: 1, type: "input.prompt",
              payload: """
                {"userMessage":{"version":1,"parts":[{"type":"text","text":"\(input.prompt)"}]}}
                """,
              id: input.clientEventId, runID: revoked ? nil : storeRunID)
          ]
          if revoked {
            rows.append(
              historyEvent(
                sequence: 2, type: "control.revoke", runID: nil,
                revokesEventID: input.clientEventId))
          } else {
            rows.append(
              historyEvent(
                sequence: 2, type: "output.message", payload: "{\"content\":\"Received\"}"))
            rows.append(historyEvent(sequence: 3, type: "run.completed"))
          }
          return historyPage(rows: rows, lastSequence: revoked ? 2 : 3)
        case "/api/chat-threads/\(storeThreadID)":
          return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
        default: throw URLError(.unsupportedURL)
        }
      }
      let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
      defer { store.close() }
      await store.refresh()
      let thread = try XCTUnwrap(store.threads.first)
      store.drafts[thread.id] = "Check status"
      await store.send(in: thread)
      let pending = try XCTUnwrap(store.pending[thread.id]?.first)
      XCTAssertTrue(pending.needsRetry)
      XCTAssertEqual(store.messages(for: thread.id).map(\.text), ["Check status"])
      XCTAssertEqual(sentInputs.withLock { $0.map(\.clientEventId) }, [pending.id])

      await store.retry(pending, in: thread)

      XCTAssertEqual(
        store.messages(for: thread.id).map(\.text),
        revoked ? [] : ["Check status", "Received"], "Revoked input: \(revoked)")
      XCTAssertTrue(store.pending[thread.id]?.isEmpty == true, "Revoked input: \(revoked)")
      XCTAssertNil(store.threadErrors[thread.id])
      XCTAssertEqual(
        sentInputs.withLock { $0.map(\.clientEventId) }, [pending.id],
        "An accepted identity must not be submitted again after history reconciliation")
    }
  }
}

/// Releases a suspended HTTP response without blocking URLProtocol's delivery queue.
private final class HTTPResponseGate: Sendable {
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

  func wait() async {
    for await _ in stream { return }
  }
}

private let storeThreadID = "40000000-0000-4000-8000-000000000001"
private let storeAgentID = "40000000-0000-4000-8000-000000000002"
private let storeRunID = "40000000-0000-4000-8000-000000000003"
private let storeDate = "2026-09-17T10:00:00.000Z"

private func historyEvent(
  sequence: Int, type: String, payload: String = "null", id: String? = nil,
  runID: String? = storeRunID, revokesEventID: String? = nil
) -> String {
  """
  {"id":"\(id ?? storeEventID(sequence))","chatThreadId":"\(storeThreadID)","runId":\(runID.map { "\"\($0)\"" } ?? "null"),"revokesEventId":\(revokesEventID.map { "\"\($0)\"" } ?? "null"),"contextType":null,"contextId":null,"runEventSequenceNumber":null,"runEventId":null,"seqId":\(sequence),"createdAt":"\(storeDate)","eventType":"\(type)","payload":\(payload)}
  """
}

private func historyPage(rows: [String], lastSequence: Int) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body: """
      {"rows":[\(rows.joined(separator: ","))],"cursor":{"lastEventId":"\(storeEventID(lastSequence))","lastSeqId":\(lastSequence)},"hasMore":false}
      """)
}

private func storeEventID(_ sequence: Int) -> String {
  String(format: "50000000-0000-4000-8000-%012d", sequence)
}

private func threadSnapshot(title: String) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body: """
      {"chatThreads":[{"id":"\(storeThreadID)","agentId":"\(storeAgentID)","title":"\(title)","sortAt":"\(storeDate)","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","pinnedAt":null,"renamedAt":null,"selectedModel":"gpt-5.6-sol","serviceTier":null,"computerUseHostId":null,"cloudBrowserEnabled":false,"selectedVideoModel":null}],"latestEventId":null,"latestSeqId":null}
      """)
}
