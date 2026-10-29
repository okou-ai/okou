import Foundation

enum MessageMermaidBody {
  enum Block {
    case markdown(AttributedString)
    case diagram(code: String, original: AttributedString)
  }

  static func blocks(_ content: AttributedString, source: String) -> [Block] {
    var blocks: [Block] = []
    var cursor = content.startIndex
    var previousID: Int?
    for run in content.runs {
      guard let component = run.presentationIntent?.components.first,
        case .codeBlock(let language) = component.kind, language == "mermaid",
        component.identity != previousID,
        let position = run.markdownSourcePosition, let sourceRange = Range(position, in: source),
        isClosedFence(source[sourceRange])
      else { continue }
      previousID = component.identity
      // Source positions and presentation intents come from the Markdown parser, so quoted
      // examples and other languages cannot accidentally become executable diagram blocks.
      let end =
        content.runs.last(where: {
          $0.presentationIntent?.components.first?.identity == component.identity
        })?.range.upperBound ?? run.range.upperBound
      if cursor < run.range.lowerBound {
        blocks.append(.markdown(AttributedString(content[cursor..<run.range.lowerBound])))
      }
      let original = AttributedString(content[run.range.lowerBound..<end])
      let characters = String(original.characters)
      let code = characters.hasSuffix("\n") ? String(characters.dropLast()) : characters
      blocks.append(.diagram(code: code, original: original))
      cursor = end
    }
    if cursor < content.endIndex { blocks.append(.markdown(AttributedString(content[cursor...]))) }
    return blocks
  }

  private static func isClosedFence(_ source: Substring) -> Bool {
    let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.count > 1, let first = lines.first, let last = lines.last,
      let marker = first.first, marker == "`" || marker == "~"
    else { return false }
    let fenceLength = first.prefix(while: { $0 == marker }).count
    // A nested block's source range includes the quote prefix on its closing line.
    let closing = last.trimmingCharacters(in: .whitespacesAndNewlines)
      .drop(while: { $0 == ">" || $0.isWhitespace })
    return fenceLength >= 3 && closing.count >= fenceLength
      && closing.allSatisfy { $0 == marker || $0 == "\r" }
  }
}
