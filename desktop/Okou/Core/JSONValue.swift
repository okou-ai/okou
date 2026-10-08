import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let v = try? container.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? container.decode(Double.self) {
      self = .number(v)
    } else if let v = try? container.decode(String.self) {
      self = .string(v)
    } else if let v = try? container.decode([JSONValue].self) {
      self = .array(v)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }
  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let v): try container.encode(v)
    case .array(let v): try container.encode(v)
    case .string(let v): try container.encode(v)
    case .number(let v): try container.encode(v)
    case .bool(let v): try container.encode(v)
    case .null: try container.encodeNil()
    }
  }
  public subscript(_ key: String) -> JSONValue {
    get { object?[key] ?? .null }
    set {
      var values = object ?? [:]
      values[key] = newValue
      self = .object(values)
    }
  }
  public var object: [String: JSONValue]? {
    if case .object(let v) = self { return v }
    return nil
  }
  public var array: [JSONValue]? {
    if case .array(let v) = self { return v }
    return nil
  }
  public var string: String? {
    if case .string(let v) = self { return v }
    return nil
  }
  public var number: Double? {
    if case .number(let v) = self { return v }
    return nil
  }
  public var bool: Bool? {
    if case .bool(let v) = self { return v }
    return nil
  }
  public var formatted: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }
  public static func strings(_ values: [String]) -> JSONValue {
    .array(values.map(JSONValue.string))
  }
}

public struct DesktopFailure: Error, LocalizedError, Sendable {
  public let code: String
  public let message: String
  public init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
  public var errorDescription: String? { message }
  public var response: JSONValue {
    .object([
      "status": .string("failed"),
      "error": .object(["code": .string(code), "message": .string(message)]),
    ])
  }
}
