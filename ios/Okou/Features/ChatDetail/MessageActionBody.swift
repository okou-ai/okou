import ChatData
import Foundation
import Textual

/// Small presentation seam: Markdown keeps its attributed structure around native card slots.
/// Further action families can add a slot without taking over the Markdown renderer or list.
enum MessageActionBody {
  enum Block {
    case markdown(AttributedString)
    case connector(ChatConnectorAction)
  }
  static func blocks(_ content: AttributedString, webURL: URL, agentID: String, threadID: String)
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
        guard range.lowerBound >= cursor,
          let action = ChatConnectorAction.parse(
            value, webURL: webURL, agentID: agentID, threadID: threadID)
        else { continue }
        if cursor < range.lowerBound {
          blocks.append(.markdown(AttributedString(content[cursor..<range.lowerBound])))
        }
        if case .connector(let previous) = blocks.last, previous.id == action.id {
          // Formatting can split one linked label into multiple attributed runs.
        } else {
          blocks.append(.connector(action))
        }
        cursor = range.upperBound
      }
    }
    if cursor < content.endIndex { blocks.append(.markdown(AttributedString(content[cursor...]))) }
    return blocks
  }
}
