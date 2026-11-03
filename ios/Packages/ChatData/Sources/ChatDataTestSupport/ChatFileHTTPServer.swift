import Foundation
import Network
import Synchronization

/// Real loopback HTTP for disk downloads, binary media, redirects, and cancellation tests.
public final class ChatFileHTTPServer: Sendable {
  public struct Response: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
    public init(status: Int = 200, headers: [String: String] = [:], body: Data = Data()) {
      self.status = status
      self.headers = headers
      self.body = body
    }
  }
  private static let origins = Mutex<Set<String>>([])
  static func owns(_ url: URL) -> Bool {
    guard let scheme = url.scheme, let host = url.host, let port = url.port else { return false }
    return origins.withLock { $0.contains("\(scheme)://\(host):\(port)") }
  }
  private let listener: NWListener
  private let handler: @Sendable (URLRequest) async -> Response
  private let queue = DispatchQueue(label: "ai.okou.tests.file-http")
  private struct State: Sendable {
    var closed = false
    var origin: String?
    var connections: [NWConnection] = []
    var tasks: [Task<Void, Never>] = []
    var startup: CheckedContinuation<URL, Error>?
  }
  private let state = Mutex(State())

  public init(handler: @escaping @Sendable (URLRequest) async -> Response) throws {
    self.handler = handler
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    listener.stateUpdateHandler = { [weak self] status in
      guard let self else { return }
      switch status {
      case .ready:
        guard let port = listener.port else { return }
        let origin = "http://127.0.0.1:\(port.rawValue)"
        let registered = state.withLock { value in
          guard !value.closed else { return false }
          value.origin = origin
          _ = Self.origins.withLock { $0.insert(origin) }
          return true
        }
        if registered { finish(.success(URL(string: origin)!)) }
      case .failed(let error), .waiting(let error): finish(.failure(error))
      case .cancelled: finish(.failure(CancellationError()))
      default: break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else {
        connection.cancel()
        return
      }
      let accepted = state.withLock { value in
        guard !value.closed else { return false }
        value.connections.append(connection)
        return true
      }
      guard accepted else {
        connection.cancel()
        return
      }
      connection.start(queue: queue)
      receive(connection, bytes: Data())
    }
  }

  public func start() async throws -> URL {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        state.withLock { value in
          guard !value.closed else {
            continuation.resume(throwing: CancellationError())
            return
          }
          value.startup = continuation
          listener.start(queue: queue)
        }
      }
    } onCancel: {
      self.cancel()
    }
  }

  public func stop() async {
    cancel()
    let pending = state.withLock { $0.tasks }
    for task in pending { await task.value }
    state.withLock { $0.tasks.removeAll() }
  }

  private func cancel() {
    let pending = state.withLock { value in
      value.closed = true
      let pending = (
        origin: value.origin, startup: value.startup,
        connections: value.connections, tasks: value.tasks
      )
      value.origin = nil
      value.startup = nil
      value.connections.removeAll()
      return pending
    }
    if let origin = pending.origin { _ = Self.origins.withLock { $0.remove(origin) } }
    listener.cancel()
    pending.startup?.resume(throwing: CancellationError())
    for connection in pending.connections { connection.cancel() }
    for task in pending.tasks { task.cancel() }
  }

  private func finish(_ result: Result<URL, Error>) {
    let pending = state.withLock { value in
      let pending = value.startup
      value.startup = nil
      return pending
    }
    pending?.resume(with: result)
  }

  private func receive(_ connection: NWConnection, bytes: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) {
      [weak self] data, _, complete, error in
      guard let self else {
        connection.cancel()
        return
      }
      guard !state.withLock({ $0.closed }) else {
        close(connection)
        return
      }
      var bytes = bytes
      if let data { bytes.append(data) }
      guard bytes.count < 16_777_216, error == nil else {
        close(connection)
        return
      }
      guard let separator = bytes.range(of: Data("\r\n\r\n".utf8)),
        let headers = String(data: bytes[..<separator.lowerBound], encoding: .utf8),
        let first = headers.components(separatedBy: "\r\n").first
      else {
        if complete { close(connection) } else { receive(connection, bytes: bytes) }
        return
      }
      let parts = first.split(separator: " ")
      guard parts.count >= 2, let port = listener.port,
        let url = URL(string: "http://127.0.0.1:\(port.rawValue)" + parts[1])
      else {
        close(connection)
        return
      }
      var request = URLRequest(url: url)
      request.httpMethod = String(parts[0])
      for line in headers.components(separatedBy: "\r\n").dropFirst() {
        guard let colon = line.firstIndex(of: ":") else { continue }
        request.setValue(
          String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces),
          forHTTPHeaderField: String(line[..<colon]))
      }
      let body = Data(bytes[separator.upperBound...])
      let length = Int(request.value(forHTTPHeaderField: "Content-Length") ?? "0") ?? 0
      guard body.count >= length else {
        receive(connection, bytes: bytes)
        return
      }
      request.httpBody = body.prefix(length)
      let received = request
      let accepted = state.withLock { value in
        guard !value.closed else { return false }
        let task = Task { @Sendable [self] in
          guard !Task.isCancelled else {
            close(connection)
            return
          }
          let result = await handler(received)
          guard !Task.isCancelled else {
            close(connection)
            return
          }
          var headers = result.headers
          if headers["Content-Length"] == nil {
            headers["Content-Length"] = String(result.body.count)
          }
          headers["Connection"] = "close"
          let header = headers.map { "\($0.key): \($0.value)\r\n" }.joined()
          var response = Data("HTTP/1.1 \(result.status) Response\r\n\(header)\r\n".utf8)
          response.append(result.body)
          connection.send(
            content: response, contentContext: .finalMessage, isComplete: true,
            completion: .contentProcessed { [weak self] _ in
              if let self { close(connection) } else { connection.cancel() }
            })
        }
        value.tasks.append(task)
        return true
      }
      if !accepted { close(connection) }
    }
  }

  private func close(_ connection: NWConnection) {
    connection.cancel()
    state.withLock { $0.connections.removeAll { $0 === connection } }
  }
}
