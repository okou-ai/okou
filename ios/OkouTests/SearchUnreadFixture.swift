import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Observation
import Synchronization
import XCTest

@testable import Okou

@MainActor
func nativeCollection(_ view: UIView) -> UICollectionView? {
  if let collection = view as? UICollectionView { return collection }
  for child in view.subviews { if let collection = nativeCollection(child) { return collection } }
  return nil
}

func query(_ request: URLRequest, _ name: String) -> String? {
  request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
    .queryItems?.first { $0.name == name }?.value
}

/// Search also lists workflows and asks the artifact catalog; the fixtures answer both with
/// nothing, so each test exercises only the message search it is about.
func emptySearchResources(_ request: URLRequest) -> ChatHTTPResponse? {
  switch request.url?.path {
  case "/api/workflows": ChatHTTPResponse(body: "[]")
  case "/api/artifacts/catalog": ChatHTTPResponse(body: "{\"artifacts\":[],\"nextCursor\":null}")
  default: nil
  }
}

func searchResponse(content: String) -> ChatHTTPResponse {
  let range = (content as NSString).range(of: "needle")
  let start = range.location == NSNotFound ? 0 : range.location
  let end = range.location == NSNotFound ? min(3, content.utf16.count) : NSMaxRange(range)
  let text = try! JSONEncoder().encodeString(content)
  return ChatHTTPResponse(
    body: """
      {"results":[{"chatThreadId":"\(SearchUnreadFixture.id(2))","matchedMessage":{"chatThreadId":"\(SearchUnreadFixture.id(2))","role":"assistant","content":\(text),"createdAt":"2026-10-19T12:00:00Z","seqId":5,"runId":null},"matchedRanges":[{"start":\(start),"end":\(end)}]}]}
      """)
}

final class SearchResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation
  init() {
    let pair = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    stream = pair.stream
    continuation = pair.continuation
  }
  func wait() async { for await _ in stream { break } }
  func open() {
    continuation.yield()
    continuation.finish()
  }
}

final class SearchUnreadFixture: Sendable {
  static let agent = "61000000-0000-4000-8000-000000000001"
  static let otherAgent = "61000000-0000-4000-8000-000000000002"
  static let timestamp = "2026-10-19T12:00:00Z"
  struct State {
    var unread: Set<Int> = [1, 2, 3, 5]
    var marker = SearchUnreadFixture.timestamp
    var bulkAgent: String?
    var failWrites = false
    var failNextRead = false
    var omitThreadIndicators = false
    var dropUnreadResponse = false
    var writes: [String] = []
    var bulkReadGate: SearchResponseGate?
    var bulkReadStarted: (@Sendable () -> Void)?
    var readGate: SearchResponseGate?
    var readStarted: (@Sendable () -> Void)?
    var readCancelled: (@Sendable () -> Void)?
    var readFinished: (@Sendable () -> Void)?
    var indicatorsGate: SearchResponseGate?
    var indicatorsStarted: (@Sendable () -> Void)?
    var recoveryGate: SearchResponseGate?
    var recoveryStarted: (@Sendable () -> Void)?
  }
  final class LockedState: Sendable { let value = Mutex(State()) }
  let state: LockedState
  let http: ChatHTTPFixture
  init() {
    let state = LockedState()
    self.state = state
    http = ChatHTTPFixture { [state] request in
      if request.httpMethod == "GET", let empty = emptySearchResources(request) { return empty }
      let path = request.url?.path ?? ""
      switch (request.httpMethod, path) {
      case ("GET", "/api/agents"):
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(Self.agent)","displayName":"Okou","isDefaultAgent":true},{"agentId":"\(Self.otherAgent)","displayName":"Research","isDefaultAgent":false}]
            """)

      case ("GET", "/api/feature-switches"):
        return ChatHTTPResponse(body: "{\"effectiveSwitches\":{}}")
      case ("GET", "/api/chat/search"):
        return searchResponse(content: "A matching needle in another agent's conversation")
      case ("GET", "/api/chat-threads/snapshot"):
        let threads = (1...40).map { index in
          """
          {"id":"\(Self.id(index))","agentId":"\(index.isMultiple(of: 2) ? Self.otherAgent : Self.agent)","title":"Chat \(index)","createdAt":"\(Self.timestamp)","updatedAt":"\(Self.timestamp)","sortAt":"\(Self.timestamp)","muted":\(index == 3),"archived":\(index == 5)}
          """
        }.joined(separator: ",")
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(threads)],\"latestEventId\":null,\"latestSeqId\":null}")
      case ("GET", "/api/chat-threads/events"):
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case ("GET", "/api/indicators"):
        let gate = state.value.withLock { value -> SearchResponseGate? in
          let gate = value.indicatorsGate
          value.indicatorsGate = nil
          value.indicatorsStarted?()
          value.indicatorsStarted = nil
          return gate
        }
        if let gate { await gate.wait() }
        return state.value.withLock { value in
          let indicators = value.unread.filter { $0 != 1 }.sorted().map {
            "\"\(Self.id($0))\":\"unread\""
          }
          let timestamps = value.unread.sorted().map { "\"\(Self.id($0))\":\"\(value.marker)\"" }
            .joined(separator: ",")
          let unreadAgents = Set(
            value.unread.filter { $0 != 3 }.map {
              $0.isMultiple(of: 2) ? Self.otherAgent : Self.agent
            })
          let agents = unreadAgents.sorted().map { "\"\($0)\":\"unread\"" }.joined(separator: ",")
          if value.omitThreadIndicators {
            return ChatHTTPResponse(body: "{\"agents\":{\(agents)},\"threads\":{},\"unreadAt\":{}}")
          }
          return ChatHTTPResponse(
            body:
              "{\"agents\":{\(agents)},\"threads\":{\((["\"\(Self.id(1))\":\"active\""] + indicators).joined(separator: ","))},\"unreadAt\":{\(timestamps)}}"
          )
        }
      case ("POST", "/api/chat-thread-unreads/mark-read"):
        let gate = state.value.withLock { value -> SearchResponseGate? in
          let gate = value.bulkReadGate
          value.bulkReadGate = nil
          value.bulkReadStarted?()
          value.bulkReadStarted = nil
          return gate
        }
        if let gate { await gate.wait() }
        let body = try JSONDecoder().decode([String: String].self, from: chatRequestBody(request))
        return state.value.withLock { value in
          if value.failWrites {
            return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Try later\"}}")
          }
          value.bulkAgent = body["agentId"]
          value.unread = value.unread.filter {
            ($0.isMultiple(of: 2) ? Self.otherAgent : Self.agent) != body["agentId"]
          }
          return ChatHTTPResponse(status: 204, body: "")
        }
      default:
        return try await Self.threadResponse(request, path: path, state: state)
      }
    }
  }
  private static func threadResponse(
    _ request: URLRequest, path: String, state: LockedState
  ) async throws -> ChatHTTPResponse {
    guard path.hasPrefix("/api/chat-threads/") else { throw URLError(.unsupportedURL) }
    let id = String(path.dropFirst("/api/chat-threads/".count).prefix(36))
    guard let number = Int(id.suffix(12)), (1...40).contains(number), id == Self.id(number)
    else { throw URLError(.unsupportedURL) }
    let threadPath = "/api/chat-threads/\(id)"
    switch (request.httpMethod, path) {
    case ("POST", threadPath + "/mark-read"), ("POST", threadPath + "/mark-unread"):
      let read = path == threadPath + "/mark-read"
      let (gate, cancelled, finished) = state.value.withLock { value in
        let gate = read ? value.readGate : nil
        let cancelled = read ? value.readCancelled : nil
        let finished = read ? value.readFinished : nil
        if read {
          value.readGate = nil
          value.readCancelled = nil
          value.readFinished = nil
          value.readStarted?()
          value.readStarted = nil
        }
        return (gate, cancelled, finished)
      }
      defer { finished?() }
      if let gate {
        await withTaskCancellationHandler {
          await gate.wait()
        } onCancel: {
          cancelled?()
        }
      }
      let response = state.value.withLock { value in
        if read && value.failNextRead {
          value.failNextRead = false
          return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Try later\"}}")
        }
        if value.failWrites {
          return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Try later\"}}")
        }
        value.writes.append(read ? "read" : "unread")
        if read { value.unread.remove(number) } else { value.unread.insert(number) }
        return ChatHTTPResponse(
          body: "{\"lastReadAt\":\(read ? "\"\(value.marker)\"" : "null")}")
      }
      if !read && state.value.withLock({ $0.dropUnreadResponse }) {
        throw URLError(.networkConnectionLost)
      }
      return response
    case ("GET", threadPath + "/event-snapshot"):
      return ChatHTTPResponse(
        status: 404,
        body:
          "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}"
      )
    case ("GET", threadPath + "/event-rows"):
      let after = Int(query(request, "sinceSeqId") ?? "0") ?? 0
      let last = min(161, after + 50)
      let rows =
        after < last
        ? ((after + 1)...last).map { sequence in
          let terminal = sequence == 161
          return """
            {"id":"\(Self.rowID(sequence))","chatThreadId":"\(id)","seqId":\(sequence),"runId":\(terminal ? "\"62000000-0000-4000-8000-999999999999\"" : "null"),"createdAt":"\(Self.timestamp)","eventType":"\(terminal ? "run.completed" : "output.message")","payload":\(terminal ? "null" : "{\"content\":\"History message \(sequence)\"}")}
            """
        }.joined(separator: ",") : ""
      return ChatHTTPResponse(
        body:
          "{\"rows\":[\(rows)],\"cursor\":{\"lastEventId\":\"\(Self.rowID(last))\",\"lastSeqId\":\(last)},\"hasMore\":\(last < 161)}"
      )
    case ("GET", threadPath):
      let gate = state.value.withLock { value -> SearchResponseGate? in
        let gate = value.recoveryGate
        value.recoveryGate = nil
        value.recoveryStarted?()
        value.recoveryStarted = nil
        return gate
      }
      if let gate { await gate.wait() }
      return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
    default: throw URLError(.unsupportedURL)
    }
  }

  @MainActor func workspace() -> WorkspaceStore {
    WorkspaceStore(client: http.client, webURL: http.baseURL)
  }
  static func id(_ index: Int) -> String { String(format: "62000000-0000-4000-8000-%012d", index) }
  static func rowID(_ index: Int) -> String {
    String(format: "63000000-0000-4000-8000-%012d", index)
  }
}
