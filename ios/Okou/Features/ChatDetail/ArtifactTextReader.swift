import ChatData
import ChatDomain
import Foundation

struct ArtifactTextContent: Sendable {
  let text: String
  let rows: [[String]]?
}

actor ArtifactTextReader {
  static let shared = ArtifactTextReader()

  func read(_ file: ChatAttachmentFile, kind: ChatArtifact.Kind) throws -> ArtifactTextContent {
    try Task.checkCancellation()
    let data = try Data(contentsOf: file.url)
    guard let text = String(data: data, encoding: .utf8) else {
      throw APIClientError.incompatibleData
    }
    if kind == .json,
      let object = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed),
      let pretty = try? JSONSerialization.data(
        withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]),
      let formatted = String(data: pretty, encoding: .utf8)
    {
      return ArtifactTextContent(text: formatted, rows: nil)
    }
    return ArtifactTextContent(text: text, rows: kind == .csv ? try csvRows(text) : nil)
  }

  private func csvRows(_ text: String) throws -> [[String]] {
    var rows: [[String]] = []
    var row: [String] = []
    var field = ""
    var quoted = false
    var iterator = text.replacingOccurrences(of: "\r\n", with: "\n").makeIterator()
    var next = iterator.next()
    while let character = next {
      try Task.checkCancellation()
      next = iterator.next()
      if character == "\"" {
        if quoted && next == "\"" {
          field.append("\"")
          next = iterator.next()
        } else {
          quoted.toggle()
        }
      } else if character == "," && !quoted {
        row.append(field)
        field = ""
      } else if (character == "\n" || character == "\r") && !quoted {
        row.append(field)
        field = ""
        rows.append(row)
        row = []
      } else {
        field.append(character)
      }
      // Bound native table construction while the original file remains available for sharing.
      if rows.count > 10_000 || row.count > 256 { throw URLError(.dataLengthExceedsMaximum) }
    }
    if !field.isEmpty || !row.isEmpty {
      row.append(field)
      rows.append(row)
    }
    return rows
  }
}
