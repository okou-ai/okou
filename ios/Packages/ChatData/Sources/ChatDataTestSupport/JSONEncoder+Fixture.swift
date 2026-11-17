import Foundation

extension JSONEncoder {
  /// Encode fixture JSON without losing the encoder's error channel.
  public func encodeString<Value: Encodable>(_ value: Value) throws -> String {
    // JSONEncoder guarantees UTF-8, including escaped user content.
    String(data: try encode(value), encoding: .utf8)!
  }
}
