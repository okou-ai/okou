import Foundation
import Network
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class SnapshotHTTPTests: XCTestCase {
  func testRealHTTPGzipSnapshotDecodesThroughChatService() async throws {
    let server = try SnapshotLoopbackServer()
    defer { server.stop() }
    let baseURL = try await server.start()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 5
    configuration.timeoutIntervalForResource = 10
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let client = APIClient(baseURL: baseURL, session: session) { "local-gzip-test-session" }

    let history = try await ChatService(client: client).history(
      threadID: SnapshotLoopbackServer.threadID)

    XCTAssertEqual(history.messages.map(\.text), ["Gzip history works."])
    XCTAssertEqual(history.messages.first?.role, .assistant)
    XCTAssertEqual(history.executionState, .completed)
    XCTAssertEqual(history.persistedEventIDs.count, 2)
    let snapshotRequest = try XCTUnwrap(server.requests.first { $0.path == "/snapshot.ndjson" })
    XCTAssertNil(snapshotRequest.authorization)
    XCTAssertTrue(snapshotRequest.acceptEncoding?.contains("gzip") == true)
    XCTAssertTrue(
      server.requests.filter { $0.path.hasPrefix("/api/") }.allSatisfy {
        $0.authorization == "Bearer local-gzip-test-session"
      })
  }
}

/// Binds an ephemeral TCP port on loopback and serves one actual gzip HTTP response.
/// Network.framework owns sockets; Mutex protects callback-observed test state.
private final class SnapshotLoopbackServer: Sendable {
  static let threadID = "30000000-0000-4000-8000-000000000001"
  private static let lastEventID = "30000000-0000-4000-8000-000000000004"
  // Two canonical schema-7 rows, gzip-compressed once with mtime=0.
  private static let compressedSnapshot = Data(
    base64Encoded:
      "H4sIAAAAAAAC/91QsW7CMBDd+YrIM4mcgCiwMVQVCwuZurnJiUQktrHPgTTKv3MmrUBMESMn66Sz33v3/DpW5mzNZnyo8Nbmvi3/x7+asSnLCoFpYUDk25GsmFjGybHwxMOhUUewnw1I9DzpqopWK4lwwbTV8HR1x9CiG2sPJwcyg52rf8A8v97xFk5+iEmK/oSQb5BsJjxZhHwVxh9pzNfcn4isfZM18PzBAlMOtcOoBmvFAehRi7ZSgvS6wZn0Yl+/pQ6K0qIybXBW5mgj1veTbnTs87eNPXkpdpKLMlXrCoj4mLrX7idXS9t9i9ACAAA="
  )!

  struct Request: Sendable {
    let path: String
    let authorization: String?
    let acceptEncoding: String?
  }

  private let listener: NWListener
  private let queue = DispatchQueue(label: "io.okou.tests.snapshot-http")
  private let observedRequests = Mutex<[Request]>([])
  private let connections = Mutex<[NWConnection]>([])
  private let startup = Mutex<CheckedContinuation<URL, Error>?>(nil)

  var requests: [Request] { observedRequests.withLock { $0 } }

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }

  func start() async throws -> URL {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        startup.withLock { $0 = continuation }
        listener.stateUpdateHandler = { [weak self] state in
          guard let self else { return }
          switch state {
          case .ready:
            guard let port = self.listener.port,
              let url = URL(string: "http://127.0.0.1:\(port.rawValue)")
            else {
              self.finishStarting(.failure(URLError(.cannotConnectToHost)))
              return
            }
            self.finishStarting(.success(url))
          case .failed(let error), .waiting(let error): self.finishStarting(.failure(error))
          case .cancelled: self.finishStarting(.failure(CancellationError()))
          default: break
          }
        }
        listener.newConnectionHandler = { [weak self] connection in
          guard let self else {
            connection.cancel()
            return
          }
          self.connections.withLock { $0.append(connection) }
          connection.start(queue: self.queue)
          self.receive(connection, buffer: Data())
        }
        listener.start(queue: queue)
      }
    } onCancel: {
      self.stop()
    }
  }

  func stop() {
    finishStarting(.failure(CancellationError()))
    listener.cancel()
    let active = connections.withLock { connections in
      let active = connections
      connections.removeAll()
      return active
    }
    for connection in active { connection.cancel() }
  }

  private func finishStarting(_ result: Result<URL, Error>) {
    let continuation = startup.withLock { continuation in
      let pending = continuation
      continuation = nil
      return pending
    }
    continuation?.resume(with: result)
  }

  private func receive(_ connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) {
      [weak self] data, _, complete, error in
      guard let self else {
        connection.cancel()
        return
      }
      var bytes = buffer
      if let data { bytes.append(data) }
      guard bytes.count < 65_536, error == nil else {
        self.close(connection)
        return
      }
      if let text = String(data: bytes, encoding: .utf8), text.contains("\r\n\r\n") {
        self.respond(to: text, on: connection)
      } else if complete {
        self.close(connection)
      } else {
        self.receive(connection, buffer: bytes)
      }
    }
  }

  private func respond(to request: String, on connection: NWConnection) {
    let lines = request.components(separatedBy: "\r\n")
    guard let target = lines.first?.split(separator: " ").dropFirst().first,
      let requestURL = URL(string: "http://127.0.0.1" + target),
      let port = listener.port
    else {
      close(connection)
      return
    }
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { continue }
      headers[String(line[..<colon]).lowercased()] = line[line.index(after: colon)...]
        .trimmingCharacters(in: .whitespaces)
    }
    observedRequests.withLock {
      $0.append(
        Request(
          path: requestURL.path, authorization: headers["authorization"],
          acceptEncoding: headers["accept-encoding"]))
    }
    let body: Data
    let contentHeaders: String
    switch requestURL.path {
    case "/api/chat-threads/\(Self.threadID)/event-snapshot":
      body = Data(
        """
        {"url":"http://127.0.0.1:\(port.rawValue)/snapshot.ndjson","expiresInSeconds":60,"lastEventId":"\(Self.lastEventID)","lastSeqId":2}
        """.utf8)
      contentHeaders = "Content-Type: application/json\r\nX-Chat-Event-Schema-Version: 7\r\n"
    case "/snapshot.ndjson":
      body = Self.compressedSnapshot
      contentHeaders = "Content-Type: application/x-ndjson\r\nContent-Encoding: gzip\r\n"
    case "/api/chat-threads/\(Self.threadID)/event-rows":
      body = Data(
        """
        {"rows":[],"cursor":{"lastEventId":"\(Self.lastEventID)","lastSeqId":2},"hasMore":false}
        """.utf8)
      contentHeaders = "Content-Type: application/json\r\nX-Chat-Event-Schema-Version: 7\r\n"
    case "/api/chat-threads/\(Self.threadID)":
      body = Data("{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}".utf8)
      contentHeaders = "Content-Type: application/json\r\n"
    default:
      close(connection)
      return
    }
    var response = Data(
      "HTTP/1.1 200 OK\r\n\(contentHeaders)Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        .utf8)
    response.append(body)
    connection.send(
      content: response, contentContext: .finalMessage, isComplete: true,
      completion: .contentProcessed { [weak self] _ in
        if let self { self.close(connection) } else { connection.cancel() }
      })
  }

  private func close(_ connection: NWConnection) {
    connection.cancel()
    connections.withLock { $0.removeAll { $0 === connection } }
  }
}
