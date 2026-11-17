import Foundation

extension JSONEncoder {
  /// Encode fixture JSON without losing the encoder's error channel.
  public func encodeString<Value: Encodable>(_ value: Value) throws -> String {
    // JSONEncoder guarantees UTF-8, including escaped user content.
    String(data: try encode(value), encoding: .utf8)!
  }
}

extension JSONSerialization {
  /// Preserve Foundation's JSON validation while producing UTF-8 fixture text.
  public static func string(
    withJSONObject value: Any, options: WritingOptions = []
  ) throws -> String {
    // JSONSerialization always writes valid UTF-8.
    String(data: try data(withJSONObject: value, options: options), encoding: .utf8)!
  }
}
