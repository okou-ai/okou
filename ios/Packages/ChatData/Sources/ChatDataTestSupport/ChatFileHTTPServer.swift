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
  private let listener: NWListener
  private let handler: @Sendable (URLRequest) -> Response
  private let queue = DispatchQueue(label: "ai.okou.tests.file-http")
  private let connections = Mutex<[NWConnection]>([])
  private let startup = Mutex<CheckedContinuation<URL, Error>?>(nil)

  public init(handler: @escaping @Sendable (URLRequest) -> Response) throws {
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
          finish(.success(URL(string: "http://127.0.0.1:\(port.rawValue)")!))
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
    listener.cancel()
    finish(.failure(CancellationError()))
    let active = connections.withLock { values in
      let active = values
      values.removeAll()
      return active
    }
    for connection in active { connection.cancel() }
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
      guard bytes.count < 65_536, error == nil else {
        close(connection)
        return
      }
      if let text = String(data: bytes, encoding: .utf8), text.contains("\r\n\r\n"),
        let target = text.components(separatedBy: "\r\n").first?.split(separator: " ").dropFirst()
          .first,
        let port = listener.port,
        let url = URL(string: "http://127.0.0.1:\(port.rawValue)" + target)
      {
        var request = URLRequest(url: url)
        for line in text.components(separatedBy: "\r\n").dropFirst() {
          guard let colon = line.firstIndex(of: ":") else { continue }
          request.setValue(
            String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces),
            forHTTPHeaderField: String(line[..<colon]))
        }
        let result = handler(request)
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
      } else if complete {
        close(connection)
      } else {
        receive(connection, bytes: bytes)
      }
    }
  }

  private func close(_ connection: NWConnection) {
    connection.cancel()
    connections.withLock { $0.removeAll { $0 === connection } }
  }
}
