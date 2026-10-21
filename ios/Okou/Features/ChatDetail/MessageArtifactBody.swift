import ChatDomain
import Foundation
import Textual

/// Markdown links keep their label and location. Image nodes reserve native preview/card slots.
@MainActor
enum MessageArtifactBody {
  enum Block: Equatable {
    case markdown(AttributedString)
    case artifact(ChatArtifact, label: String, destination: URL?)
  }

  static func resources(_ content: AttributedString, viewer: MessageArtifactStore) -> [ChatArtifact]
  {
    var seen = Set<ChatArtifact.Source>()
    return content.runs.compactMap { run in
      guard !isCode(run), let url = run.imageURL ?? run.link,
        let resource = viewer.resource(url.absoluteString), seen.insert(resource.id).inserted
      else { return nil }
      return resource
    }
  }

  static func blocks(_ content: AttributedString, viewer: MessageArtifactStore) -> [Block] {
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
        let url = run.imageURL, let resource = viewer.resource(url.absoluteString)
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
