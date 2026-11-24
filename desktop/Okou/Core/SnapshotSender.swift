import Foundation

/// An optional transport for bytes from an already authorized window capture.
@MainActor
public protocol SnapshotSender: AnyObject, Sendable {
  func prepare(
    session: String, exchange: @escaping @Sendable (JSONValue) async throws -> JSONValue)
  func enqueue(session: String, commandId: String, snapshot: JSONValue) -> String?
  func stop()
}
