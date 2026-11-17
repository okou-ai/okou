import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

/// Releases a suspended HTTP response without blocking URLProtocol's delivery queue.
final class HTTPResponseGate: Sendable {
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

let storeThreadID = "40000000-0000-4000-8000-000000000001"
let storeAgentID = "40000000-0000-4000-8000-000000000002"
let storeRunID = "40000000-0000-4000-8000-000000000003"
let storeDate = "2026-09-17T10:00:00.000Z"

func historyEvent(
  sequence: Int, type: String, payload: String = "null", id: String? = nil,
  runID: String? = storeRunID, revokesEventID: String? = nil
) -> String {
  """
  {"id":"\(id ?? storeEventID(sequence))","chatThreadId":"\(storeThreadID)","runId":\(runID.map { "\"\($0)\"" } ?? "null"),"revokesEventId":\(revokesEventID.map { "\"\($0)\"" } ?? "null"),"contextType":null,"contextId":null,"runEventSequenceNumber":null,"runEventId":null,"seqId":\(sequence),"createdAt":"\(storeDate)","eventType":"\(type)","payload":\(payload)}
  """
}

func historyPage(rows: [String], lastSequence: Int) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body: """
      {"rows":[\(rows.joined(separator: ","))],"cursor":{"lastEventId":"\(storeEventID(lastSequence))","lastSeqId":\(lastSequence)},"hasMore":false}
      """)
}

func storeEventID(_ sequence: Int) -> String {
  String(format: "50000000-0000-4000-8000-%012d", sequence)
}

func threadSnapshot(title: String, threadIDs: [String] = [storeThreadID])
  -> ChatHTTPResponse
{
  let threads = threadIDs.map { id in
    """
    {"id":"\(id)","agentId":"\(storeAgentID)","title":"\(title)","sortAt":"\(storeDate)","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","pinnedAt":null,"renamedAt":null,"selectedModel":"gpt-5.6-sol","serviceTier":null,"computerUseHostId":null,"cloudBrowserEnabled":false}
    """
  }
  return ChatHTTPResponse(
    body: """
      {"chatThreads":[\(threads.joined(separator: ","))],"latestEventId":null,"latestSeqId":null}
      """)
}

func missingHistorySnapshot() -> ChatHTTPResponse {
  ChatHTTPResponse(
    status: 404,
    body: "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
}
