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
  private let registeredOrigin = Mutex<String?>(nil)
  static func owns(_ url: URL) -> Bool {
    guard let scheme = url.scheme, let host = url.host, let port = url.port else { return false }
    return origins.withLock { $0.contains("\(scheme)://\(host):\(port)") }
  }
  private let listener: NWListener
  private let handler: @Sendable (URLRequest) async -> Response
  private let queue = DispatchQueue(label: "ai.okou.tests.file-http")
  private let connections = Mutex<[NWConnection]>([])
  private let tasks = Mutex<[Task<Void, Never>]>([])
  private let startup = Mutex<CheckedContinuation<URL, Error>?>(nil)

  public init(handler: @escaping @Sendable (URLRequest) async -> Response) throws {
    self.handler = handler
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
  }

  public func start() async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      startup.withLock { $0 = continuation }
      listener.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .ready:
          guard let port = listener.port else { return }
          let origin = "http://127.0.0.1:\(port.rawValue)"
          registeredOrigin.withLock { $0 = origin }
          _ = Self.origins.withLock { $0.insert(origin) }
          finish(.success(URL(string: origin)!))
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
        connections.withLock { $0.append(connection) }
        connection.start(queue: queue)
        receive(connection, bytes: Data())
      }
      listener.start(queue: queue)
    }
  }

  public func stop() {
    if let origin = registeredOrigin.withLock({ value in
      let origin = value
      value = nil
      return origin
    }) {
      _ = Self.origins.withLock { $0.remove(origin) }
    }
    listener.cancel()
    finish(.failure(CancellationError()))
    let active = connections.withLock { values in
      let active = values
      values.removeAll()
      return active
    }
    for connection in active { connection.cancel() }
    let pending = tasks.withLock { values in
      let pending = values
      values.removeAll()
      return pending
    }
    for task in pending { task.cancel() }
  }

  private func finish(_ result: Result<URL, Error>) {
    let pending = startup.withLock { value in
      let pending = value
      value = nil
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
      let task = Task { @Sendable [self] in
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
      tasks.withLock { $0.append(task) }
    }
  }

  private func close(_ connection: NWConnection) {
    connection.cancel()
    connections.withLock { $0.removeAll { $0 === connection } }
  }
}
