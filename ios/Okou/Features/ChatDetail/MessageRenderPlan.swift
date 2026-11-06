import ChatData
import ChatDomain
import Foundation
import Textual

struct MessageRenderPlan: Sendable {
  struct Context: Hashable, Sendable {
    struct ArtifactOrigin: Hashable, Sendable {
      let webURL: URL
      let apiURL: URL

      func resource(_ value: String) -> ChatArtifact? {
        ChatArtifactReference.parse(value, webURL: webURL, apiURL: apiURL)
      }
    }

    let webURL: URL
    let action: MessageActionContext?
    let permissionsEnabled: Bool
    let artifacts: ArtifactOrigin?

    @MainActor
    init(
      webURL: URL, action: MessageActionContext?, permissionsEnabled: Bool,
      artifacts: MessageArtifactStore?
    ) {
      self.webURL = webURL
      self.action = action
      self.permissionsEnabled = permissionsEnabled
      self.artifacts = artifacts.map { .init(webURL: $0.webURL, apiURL: $0.apiURL) }
    }
  }

  indirect enum Unit: Sendable {
    case group([Unit], spacing: CGFloat)
    case markdown(AttributedString, stableHeight: Bool)
    case connector(ChatConnectorAction)
    case permission(ChatPermissionAction)
    case permissionBatch(ChatPermissionBatchAction)
    case unavailablePermission
    case mailDraft(String)
    case shellAuthorization(String)
    case artifact(ChatArtifact, label: String, destination: URL?)
    case diagram(code: String, original: AttributedString)

    var hasStableHeight: Bool {
      switch self {
      case .group(let children, _):
        children.allSatisfy(\.hasStableHeight)
      case .markdown(_, let stableHeight): stableHeight
      case .artifact:
        // Artifact cards reserve the preview and information sizes before loading metadata.
        true
      case .connector, .permission, .permissionBatch, .unavailablePermission, .mailDraft,
        .shellAuthorization, .diagram:
        false
      }
    }

    var hasIndependentUnits: Bool {
      guard case .group(let children, _) = self else { return false }
      return children.count > 1 || children.first?.hasIndependentUnits == true
    }

    var sizeKey: SizeKey? {
      switch self {
      case .markdown(let content, true) where content.characters.prefix(4_097).count <= 4_096:
        .markdown(content)
      case .artifact(let resource, let label, _): .artifact(resource, label: label)
      default: nil
      }
    }
  }

  enum SizeKey: Hashable {
    case markdown(AttributedString)
    case artifact(ChatArtifact, label: String)
  }

  let root: Unit
  let resources: [ChatArtifact]
  let hasStableHeight: Bool
  let hasIndependentUnits: Bool

  init(content: AttributedString, source: String, context: Context) {
    if let artifacts = context.artifacts {
      resources = MessageArtifactBody.resources(content, resolve: artifacts.resource)
    } else {
      resources = []
    }
    if let action = context.action {
      let units = MessageActionBody.blocks(
        content, webURL: context.webURL, agentID: action.agentID, threadID: action.threadID,
        permissionsEnabled: context.permissionsEnabled
      ).compactMap { block -> Unit? in
        switch block {
        case .markdown(let fragment):
          guard Self.hasText(fragment) else { return nil }
          return Self.artifactUnits(fragment, source: source, origin: context.artifacts)
        case .connector(let action): return .connector(action)
        case .permission(let action): return .permission(action)
        case .permissionBatch(let action): return .permissionBatch(action)
        case .unavailablePermission: return .unavailablePermission
        case .mailDraft(let id): return .mailDraft(id)
        case .shellAuthorization(let id): return .shellAuthorization(id)
        }
      }
      root = .group(units, spacing: 12)
    } else {
      root = Self.artifactUnits(content, source: source, origin: context.artifacts)
    }
    hasStableHeight = root.hasStableHeight
    hasIndependentUnits = root.hasIndependentUnits
  }

  private static func artifactUnits(
    _ content: AttributedString, source: String, origin: Context.ArtifactOrigin?
  ) -> Unit {
    guard let origin else { return diagramUnits(content, source: source) }
    let blocks = MessageArtifactBody.blocks(content, resolve: origin.resource)
    // A result shows once: an image already drawn as a card is not repeated for a link to it.
    var shown = Set<ChatArtifact.Source>()
    for block in blocks {
      if case .artifact(let resource, _, _) = block { shown.insert(resource.id) }
    }
    var units: [Unit] = []
    for block in blocks {
      switch block {
      case .markdown(let fragment):
        guard hasText(fragment) else { continue }
        units.append(diagramUnits(fragment, source: source))
        // A linked website, deck or file gets its card after the passage that names it, as
        // Manus places a result under "You can view it below".
        for link in MessageArtifactBody.links(fragment, resolve: origin.resource)
        where shown.insert(link.resource.id).inserted {
          units.append(.artifact(link.resource, label: link.label, destination: nil))
        }
      case .artifact(let resource, let label, let destination):
        units.append(.artifact(resource, label: label, destination: destination))
      }
    }
    return .group(units, spacing: 8)
  }

  private static func diagramUnits(_ content: AttributedString, source: String) -> Unit {
    let units = MessageMermaidBody.blocks(content, source: source).map { block -> Unit in
      switch block {
      case .markdown(let fragment):
        .markdown(fragment, stableHeight: stableMarkdownHeight(fragment))
      case .diagram(let code, let original): .diagram(code: code, original: original)
      }
    }
    return .group(units, spacing: 0)
  }

  private static func stableMarkdownHeight(_ content: AttributedString) -> Bool {
    content.runs.allSatisfy { run in
      guard run.imageURL == nil, run.textual.emojiURL == nil, run.textual.attachment == nil else {
        return false
      }
      return run.presentationIntent?.components.allSatisfy { component in
        guard case .codeBlock(let language) = component.kind else { return true }
        return language?.lowercased() != "math" && language?.lowercased() != "mermaid"
      } != false
    }
  }

  private static func hasText(_ content: AttributedString) -> Bool {
    content.characters.contains { !$0.isWhitespace }
  }
}
