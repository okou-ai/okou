import CryptoKit
import Foundation
import Network
import Synchronization

/// Owns the SDK's HTTP token exchange and RFC 6455 connection on loopback only.
final class RealtimeHTTPFixture: Sendable {
  private let listener: NWListener
  private let clientID: String
  private let queue = DispatchQueue(label: "ai.okou.tests.realtime-http")
  private let onProtocol: @Sendable (Int, String) -> Void
  private struct State {
    var closed = false
    var connections: [NWConnection] = []
    var sockets: [NWConnection] = []
    var channels: [String: NWConnection] = [:]
    var startup: CheckedContinuation<UInt16, Error>?
    var errors: [String] = []
    var autoAttach = false
  }
  private let state = Mutex(State())
  var errors: [String] { state.withLock { $0.errors } }

  init(clientID: String, onProtocol: @escaping @Sendable (Int, String) -> Void) throws {
    self.clientID = clientID
    self.onProtocol = onProtocol
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    listener.stateUpdateHandler = { [weak self] status in
      guard let self else { return }
      switch status {
      case .ready:
        guard let port = listener.port else { return }
        let continuation = state.withLock { value in
          let pending = value.startup
          value.startup = nil
          return pending
        }
        continuation?.resume(returning: port.rawValue)
      case .failed(let error), .waiting(let error):
        let continuation = state.withLock { value in
          let pending = value.startup
          value.startup = nil
          return pending
        }
        continuation?.resume(throwing: error)
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
      receive(connection, buffer: Data(), websocket: false)
    }
  }

  func start() async throws -> UInt16 {
    try await withCheckedThrowingContinuation { continuation in
      state.withLock { $0.startup = continuation }
      listener.start(queue: queue)
    }
  }

  func stop() {
    let resources = state.withLock { value in
      value.closed = true
      let result = (value.connections, value.startup)
      value.connections.removeAll()
      value.sockets.removeAll()
      value.channels.removeAll()
      value.startup = nil
      return result
    }
    resources.1?.resume(throwing: CancellationError())
    listener.cancel()
    for connection in resources.0 { connection.cancel() }
  }

  func attached(_ name: String) throws {
    try send(["action": 11, "channel": name], channel: name)
  }

  func attachAutomatically() { state.withLock { $0.autoAttach = true } }

  func fail(_ name: String) throws {
    try send(
      [
        "action": 9, "channel": name,
        "error": ["code": 40160, "statusCode": 403, "message": "Fixture channel unavailable"],
      ],
      channel: name)
  }

  func disconnect() throws {
    let sockets = state.withLock { $0.sockets }
    guard !sockets.isEmpty else { throw URLError(.notConnectedToInternet) }
    for connection in sockets {
      // RFC 6455 Going Away closes this fixture transport, not the SDK client.
      connection.send(
        content: Data([0x88, 2, 0x03, 0xE9]),
        completion: .contentProcessed { _ in
          connection.cancel()
        })
    }
  }

  private func send(_ message: [String: Any], channel: String) throws {
    guard let connection = state.withLock({ $0.channels[channel] }) else {
      throw URLError(.notConnectedToInternet)
    }
    try send(message, connection: connection)
  }

  private func send(_ message: [String: Any], connection: NWConnection) throws {
    let payload = try JSONSerialization.data(withJSONObject: message)
    var frame = Data([0x81])
    if payload.count < 126 {
      frame.append(UInt8(payload.count))
    } else {
      frame.append(126)
      frame.append(UInt8((payload.count >> 8) & 255))
      frame.append(UInt8(payload.count & 255))
    }
    frame.append(payload)
    connection.send(content: frame, completion: .contentProcessed { _ in })
  }

  private func receive(_ connection: NWConnection, buffer: Data, websocket: Bool) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) {
      [weak self] data, _, complete, error in
      guard let self, !state.withLock({ $0.closed }) else {
        connection.cancel()
        return
      }
      var bytes = buffer
      if let data { bytes.append(data) }
      do {
        if websocket {
          while let frame = Self.frame(bytes) {
            bytes.removeFirst(frame.consumed)
            // Ably's JSON encoder sends NSData, which SocketRocket frames as binary.
            if frame.opcode == 1 || frame.opcode == 2 {
              try protocolMessage(frame.payload, connection: connection)
            } else if frame.opcode == 8 {
              connection.cancel()
              return
            } else if frame.opcode == 9 {
              var pong = Data([0x8A, UInt8(frame.payload.count)])
              pong.append(frame.payload)
              connection.send(content: pong, completion: .contentProcessed { _ in })
            }
          }
        } else if let end = bytes.range(of: Data("\r\n\r\n".utf8)) {
          let header = String(decoding: bytes[..<end.upperBound], as: UTF8.self)
          if let key = header.components(separatedBy: "\r\n").first(where: {
            $0.lowercased().hasPrefix("sec-websocket-key:")
          })?.components(separatedBy: ":").dropFirst().joined(separator: ":")
            .trimmingCharacters(in: .whitespaces)
          {
            let hash = Insecure.SHA1.hash(
              data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
            let accept = Data(hash).base64EncodedString()
            let response =
              "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in })
            state.withLock { $0.sockets.append(connection) }
            try send(
              [
                "action": 4, "connectionId": "fixture-connection", "connectionKey": "fixture-key",
                "connectionDetails": [
                  "clientId": clientID, "connectionStateTtl": 120_000,
                  "maxIdleInterval": 120_000, "maxMessageSize": 65_536,
                ],
              ], connection: connection)
            receive(connection, buffer: Data(bytes[end.upperBound...]), websocket: true)
            return
          }
          guard header.hasPrefix("POST /keys/") && header.contains("/requestToken") else {
            throw URLError(.unsupportedURL)
          }
          let bodyLength =
            header.components(separatedBy: "\r\n").first {
              $0.lowercased().hasPrefix("content-length:")
            }?.split(separator: ":").last.flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
            ?? 0
          if bytes.count < end.upperBound + bodyLength {
            receive(connection, buffer: bytes, websocket: false)
            return
          }
          let now = Int64(Date().timeIntervalSince1970 * 1000)
          let body = try JSONSerialization.data(withJSONObject: [
            "token": "fixture-token", "issued": now, "expires": now + 3_600_000,
            "clientId": clientID, "capability": "{\"*\":[\"subscribe\"]}",
          ])
          let response =
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
          connection.send(
            content: Data(response.utf8) + body,
            completion: .contentProcessed { _ in
              connection.cancel()
            })
          return
        }
        if complete || error != nil {
          connection.cancel()
          return
        }
        receive(connection, buffer: bytes, websocket: websocket)
      } catch {
        state.withLock { $0.errors.append(String(describing: error)) }
        connection.cancel()
      }
    }
  }

  private func protocolMessage(_ data: Data, connection: NWConnection) throws {
    let decoded = try JSONSerialization.jsonObject(with: data)
    let messages = (decoded as? [[String: Any]]) ?? (decoded as? [String: Any]).map { [$0] } ?? []
    for message in messages {
      let action = message["action"] as? Int ?? -1
      let channel = message["channel"] as? String ?? ""
      if action == 10 {
        let automatic = state.withLock { value in
          value.channels[channel] = connection
          return value.autoAttach
        }
        if automatic || channel.hasPrefix("user-org-foreground:") {
          try send(["action": 11, "channel": channel], connection: connection)
        }
        onProtocol(action, channel)
      } else if action == 12 {
        try send(["action": 13, "channel": channel], connection: connection)
        onProtocol(action, channel)
      } else if action == 0 {
        try send(["action": 0], connection: connection)
      } else if action == 7 {
        try send(["action": 8], connection: connection)
      } else if action == 14 {
        try send(
          ["action": 1, "msgSerial": message["msgSerial"] ?? 0, "count": 1], connection: connection)
      }
    }
  }

  private static func frame(_ data: Data) -> (consumed: Int, opcode: UInt8, payload: Data)? {
    let bytes = [UInt8](data)
    guard bytes.count >= 2 else { return nil }
    let opcode = bytes[0] & 15
    let masked = bytes[1] & 128 != 0
    var length = Int(bytes[1] & 127)
    var offset = 2
    if length == 126 {
      guard bytes.count >= 4 else { return nil }
      length = Int(bytes[2]) * 256 + Int(bytes[3])
      offset = 4
    } else if length == 127 {
      return nil
    }
    let maskOffset = offset
    if masked { offset += 4 }
    guard bytes.count >= offset + length else { return nil }
    let payload = (0..<length).map { index in
      bytes[offset + index] ^ (masked ? bytes[maskOffset + index % 4] : 0)
    }
    return (offset + length, opcode, Data(payload))
  }
}
