import ChatDomain
import Foundation
import Textual

/// Markdown links keep their label and location. Image nodes reserve native preview/card slots.
enum MessageArtifactBody {
  enum Block: Equatable {
    case markdown(AttributedString)
    case artifact(ChatArtifact, label: String, destination: URL?)
  }

  static func resources(_ content: AttributedString, resolve: (String) -> ChatArtifact?)
    -> [ChatArtifact]
  {
    var seen = Set<ChatArtifact.Source>()
    return content.runs.compactMap { run in
      guard !isCode(run), let url = run.imageURL ?? run.link,
        let resource = resolve(url.absoluteString), seen.insert(resource.id).inserted
      else { return nil }
      return resource
    }
  }

  /// Links in running text that point at a result (a hosted site, a file, a published page),
  /// each once, with the link's own text, in reading order. The text keeps the link; the card
  /// that follows the passage shows what it points at.
  static func links(_ content: AttributedString, resolve: (String) -> ChatArtifact?)
    -> [(resource: ChatArtifact, label: String)]
  {
    var links: [(resource: ChatArtifact, label: String)] = []
    var seen = Set<ChatArtifact.Source>()
    var previous: (url: URL, end: AttributedString.Index)?
    for run in content.runs {
      guard !isCode(run), run.imageURL == nil, let url = run.link,
        let resource = resolve(url.absoluteString)
      else { continue }
      let text = String(content[run.range].characters)
      if let previous, previous.url == url, previous.end == run.range.lowerBound,
        links.last?.resource.id == resource.id
      {
        // Styling inside one link splits its text into adjacent runs.
        links[links.count - 1].label += text
      } else if seen.insert(resource.id).inserted {
        links.append((resource, text))
      }
      previous = (url, run.range.upperBound)
    }
    return links
  }

  static func blocks(_ content: AttributedString, resolve: (String) -> ChatArtifact?) -> [Block] {
    var blocks: [Block] = []
    var cursor = content.startIndex
    var previousImageEnd: AttributedString.Index?
    for run in content.runs {
      guard !isCode(run),
        run.presentationIntent?.components.contains(where: { component in
          switch component.kind {
          case .table, .tableRow, .tableCell, .tableHeaderRow: true
          default: false
          }
        }) != true,
        let url = run.imageURL, let resource = resolve(url.absoluteString)
      else { continue }
      if cursor < run.range.lowerBound {
        blocks.append(.markdown(AttributedString(content[cursor..<run.range.lowerBound])))
      }
      let label = String(content[run.range].characters)
      if previousImageEnd == run.range.lowerBound,
        case .artifact(let previous, let previousLabel, let destination) = blocks.last,
        previous.source == resource.source, destination == run.link
      {
        // Styling may split a single image's alt text into adjacent attributed runs.
        blocks[blocks.count - 1] = .artifact(
          resource, label: previousLabel + label, destination: destination)
      } else {
        blocks.append(.artifact(resource, label: label, destination: run.link))
      }
      previousImageEnd = run.range.upperBound
      cursor = run.range.upperBound
    }
    if cursor < content.endIndex { blocks.append(.markdown(AttributedString(content[cursor...]))) }
    return blocks
  }

  private static func isCode(_ run: AttributedString.Runs.Run) -> Bool {
    run.inlinePresentationIntent?.contains(.code) == true
      || run.presentationIntent?.components.contains(where: { component in
        if case .codeBlock = component.kind { return true }
        return false
      }) == true
  }
}
