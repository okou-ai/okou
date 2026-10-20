import ChatData
import Foundation
import Textual

/// Small presentation seam: Markdown keeps its attributed structure around native card slots.
/// Further action families can add a slot without taking over the Markdown renderer or list.
enum MessageActionBody {
  enum Block: Equatable {
    case markdown(AttributedString)
    case connector(ChatConnectorAction)
    case permission(ChatPermissionAction)
    case unavailablePermission(String)
  }
  static func blocks(
    _ content: AttributedString, webURL: URL, agentID: String, threadID: String,
    permissionsEnabled: Bool = true
  )
    -> [Block]
  {
    var blocks: [Block] = []
    var cursor = content.startIndex
    for run in content.runs {
      guard run.imageURL == nil, run.inlinePresentationIntent?.contains(.code) != true,
        run.presentationIntent?.components.contains(where: { component in
          switch component.kind {
          case .codeBlock, .table, .tableRow, .tableCell, .tableHeaderRow: true
          default: false
          }
        }) != true
      else { continue }
      let candidates: [(Range<AttributedString.Index>, String)]
      if let link = run.link {
        candidates = [(run.range, link.absoluteString)]
      } else {
        let text = String(content[run.range].characters)
        let matches = text.ranges(of: #/https?://[^\s<>"`]+|/(?:connectors|agents)/[^\s<>"`]+/#)
        candidates = matches.map { range in
          let value = String(text[range]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;!"))
          let start = content.characters.index(
            run.range.lowerBound,
            offsetBy: text.distance(from: text.startIndex, to: range.lowerBound))
          let end = content.characters.index(start, offsetBy: value.count)
          return (start..<end, value)
        }
      }
      for (range, value) in candidates {
        guard range.lowerBound >= cursor else { continue }
        let block: Block
        if let action = ChatConnectorAction.parse(
          value, webURL: webURL, agentID: agentID, threadID: threadID)
        {
          block = .connector(action)
        } else if permissionsEnabled,
          let url = ChatPermissionAction.trustedURL(value, webURL: webURL)
        {
          if run.link == nil, range.lowerBound > content.startIndex {
            let previous = content.characters[content.characters.index(before: range.lowerBound)]
            // A path inside an identifier or a protocol-relative foreign URL is not an action.
            let prefix = content[..<range.lowerBound]
            if prefix.runs.last?.presentationIntent == run.presentationIntent {
              guard previous.isWhitespace || permissionURLDelimiter(previous) else { continue }
            }
            guard !permissionURLIsInMarkup(String(prefix.characters)) else { continue }
          }
          block =
            ChatPermissionAction(url: url, agentID: agentID, threadID: threadID)
            .map(Block.permission) ?? .unavailablePermission(value)
        } else {
          continue
        }
        if cursor < range.lowerBound {
          blocks.append(.markdown(AttributedString(content[cursor..<range.lowerBound])))
        }
        if blocks.last == block {
          // Formatting can split one linked label into multiple attributed runs.
        } else {
          blocks.append(block)
        }
        cursor = range.upperBound
      }
    }
    if cursor < content.endIndex { blocks.append(.markdown(AttributedString(content[cursor...]))) }
    return blocks
  }

  private static func permissionURLDelimiter(_ character: Character) -> Bool {
    if character.unicodeScalars.last?.value == 0x20E3 { return true }
    guard !"-./\\_*;~=&%+@#?".contains(character),
      let scalar = character.unicodeScalars.first
    else { return false }
    switch scalar.properties.generalCategory {
    case .dashPunctuation, .closePunctuation, .finalPunctuation, .initialPunctuation,
      .otherPunctuation, .openPunctuation, .mathSymbol, .otherSymbol:
      return true
    default: return false
    }
  }

  private static func permissionURLIsInMarkup(_ prefix: String) -> Bool {
    var inTag = false
    var quote: Character?
    for index in prefix.indices {
      let character = prefix[index]
      if inTag {
        if let delimiter = quote {
          if character == delimiter { quote = nil }
        } else if character == "\"" || character == "'" {
          quote = character
        } else if character == ">" {
          inTag = false
        }
      } else if character == "<" {
        let next = prefix.index(after: index)
        if next < prefix.endIndex {
          let initial = prefix[next]
          inTag = initial.isLetter || initial == "!" || initial == "/"
        }
      }
    }
    return inTag
  }
}
