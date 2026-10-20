import Foundation

/// Lossless values for composer parts that native text editing does not own.
public enum MessageJSON: Codable, Equatable, Sendable {
  case object([String: MessageJSON])
  case array([MessageJSON])
  case string(String)
  case number(Decimal)
  case bool(Bool)
  case null

  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() {
      self = .null
    } else if let bool = try? value.decode(Bool.self) {
      self = .bool(bool)
    } else if let string = try? value.decode(String.self) {
      self = .string(string)
    } else if let number = try? value.decode(Decimal.self) {
      self = .number(number)
    } else if let array = try? value.decode([MessageJSON].self) {
      self = .array(array)
    } else {
      self = .object(try value.decode([String: MessageJSON].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .object(let object): try value.encode(object)
    case .array(let array): try value.encode(array)
    case .string(let string): try value.encode(string)
    case .number(let number): try value.encode(number)
    case .bool(let bool): try value.encode(bool)
    case .null: try value.encodeNil()
    }
  }

  public subscript(_ key: String) -> MessageJSON? {
    if case .object(let object) = self { return object[key] }
    return nil
  }
  public var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }
}

public struct ChatDraftDocument: Codable, Equatable, Sendable {
  public let version: Int
  public var parts: [MessageJSON]

  public init(parts: [MessageJSON] = []) {
    self.version = 1
    self.parts = parts
  }

  public var text: String {
    parts.filter { $0["type"]?.string == "text" }.compactMap { $0["text"]?.string }.joined()
  }
  public var isSupported: Bool {
    version == 1
      && parts.allSatisfy {
        guard let type = $0["type"]?.string else { return false }
        return [
          "text", "file", "chat_thread", "agent", "template", "source", "additional_info",
          "automation", "feedback",
        ].contains(type)
      }
  }
  public var contextLabels: [String] {
    parts.compactMap { part in
      switch part["type"]?.string {
      case "text", "file": return nil
      case "agent": return part["nameSnapshot"]?.string
      case "chat_thread", "template": return part["titleSnapshot"]?.string
      case "feedback": return part["quote"]?.string
      case "source": return "Source context"
      case "additional_info": return "Additional context"
      case "automation": return part["workflowName"]?.string
      default: return "Content requires a newer app"
      }
    }
  }

  /// Apply the text field's edit only to text spans; reference/file envelopes retain their order.
  public mutating func replaceText(_ replacement: String) {
    let old = Array(text)
    let new = Array(replacement)
    var prefix = 0
    while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
    var suffix = 0
    while suffix < min(old.count, new.count) - prefix,
      old[old.count - suffix - 1] == new[new.count - suffix - 1]
    { suffix += 1 }
    let end = old.count - suffix
    let inserted = String(new[prefix..<(new.count - suffix)])
    var offset = 0
    var didInsert = false
    parts = parts.compactMap { part in
      guard part["type"]?.string == "text", let text = part["text"]?.string else { return part }
      let characters = Array(text)
      let start = offset
      offset += characters.count
      guard offset >= prefix, start <= end else { return part }
      var result = String(characters.prefix(max(0, min(characters.count, prefix - start))))
      if !didInsert {
        result += inserted
        didInsert = true
      }
      result += String(characters.suffix(max(0, min(characters.count, offset - end))))
      return result.isEmpty ? nil : .object(["type": .string("text"), "text": .string(result)])
    }
    if !didInsert, !inserted.isEmpty {
      parts.append(.object(["type": .string("text"), "text": .string(inserted)]))
    }
  }
}
