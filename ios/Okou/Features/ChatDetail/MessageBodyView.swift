import ChatData
import ChatDomain
import SwiftUI
import Textual

struct MessageActionContext: Hashable, Sendable {
  let agentID: String
  let threadID: String
}

struct MessageBodyView: View, Equatable {
  let text: String
  let baseURL: URL
  let markdown: MessageMarkdownCache
  let actionContext: MessageActionContext?
  let connectorActions: ConnectorActionStore?
  let permissionActions: PermissionActionRegistry?
  let approvals: ApprovalCardRegistry?
  let artifacts: MessageArtifactStore?
  let artifactImageSources: [String]
  let loadsActions: Bool
  let loadsDiagrams: Bool
  @Environment(\.openURL) private var openURL
  @Environment(\.messageUnitMeasurement) private var unitMeasurement
  private struct Request: Hashable {
    let source: String
    let context: MessageRenderPlan.Context
  }

  private let request: Request
  @State private var prepared: (request: Request, plan: MessageRenderPlan)?

  init(
    text: String, baseURL: URL, markdown: MessageMarkdownCache,
    actionContext: MessageActionContext? = nil, connectorActions: ConnectorActionStore? = nil,
    permissionActions: PermissionActionRegistry? = nil, approvals: ApprovalCardRegistry? = nil,
    artifacts: MessageArtifactStore? = nil, artifactImageSources: [String] = [],
    loadsActions: Bool = false, loadsDiagrams: Bool = true
  ) {
    self.text = text
    self.baseURL = baseURL
    self.markdown = markdown
    self.actionContext = actionContext
    self.connectorActions = connectorActions
    self.permissionActions = permissionActions
    self.approvals = approvals
    self.artifacts = artifacts
    self.artifactImageSources = artifactImageSources
    self.loadsActions = loadsActions
    self.loadsDiagrams = loadsDiagrams
    let context = MessageRenderPlan.Context(
      webURL: baseURL, action: connectorActions == nil ? nil : actionContext,
      permissionsEnabled: permissionActions != nil, artifacts: artifacts)
    let request = Request(source: text, context: context)
    self.request = request
    _prepared = State(
      initialValue: markdown.cachedPlan(for: text, context: context).map {
        (request, $0)
      })
  }

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.text == rhs.text && lhs.baseURL == rhs.baseURL && lhs.markdown === rhs.markdown
      && lhs.actionContext == rhs.actionContext && lhs.connectorActions === rhs.connectorActions
      && lhs.permissionActions === rhs.permissionActions && lhs.approvals === rhs.approvals
      && lhs.artifacts === rhs.artifacts && lhs.artifactImageSources == rhs.artifactImageSources
      && lhs.loadsActions == rhs.loadsActions
      && lhs.loadsDiagrams == rhs.loadsDiagrams
  }

  var body: some View {
    let plan = prepared?.request == request ? prepared?.plan : nil
    Group {
      if let plan {
        MessageRenderUnitView(
          unit: plan.root, message: self, resources: plan.resources,
          measurement: plan.hasIndependentUnits ? unitMeasurement : nil)
      } else {
        Text(text).textSelection(.enabled)
      }
    }
    // Keep overrides closest to the content; the bundled style sets the same environment keys.
    .textual.tableStyle(.overflow)
    .modifier(OkouMarkdownStyle())
    .textual.imageAttachmentLoader(
      MessageImageLoader(baseURL: baseURL, artifacts: artifacts, loadsContent: loadsActions)
    )
    .textual.textSelection(.enabled)
    .frame(maxWidth: .infinity, alignment: .leading)
    .environment(
      \.openURL,
      OpenURLAction { url in
        guard ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else {
          return .discarded
        }
        if let artifacts, let resource = artifacts.resource(url.absoluteString) {
          artifacts.open(
            resource, images: plan?.resources ?? [], imageSources: artifactImageSources)
        } else {
          // Markdown links can retain a base URL. System dispatch needs the
          // resolved standalone destination, even when absoluteString is valid.
          openURL(url.absoluteURL)
        }
        return .handled
      }
    )
    .task(id: request) {
      guard prepared?.request != request else { return }
      guard let plan = await markdown.renderPlan(for: request.source, context: request.context),
        !Task.isCancelled
      else { return }
      prepared = (request, plan)
    }
  }
}

private struct MessageRenderUnitView: View {
  let unit: MessageRenderPlan.Unit
  let message: MessageBodyView
  let resources: [ChatArtifact]
  let measurement: MessageUnitMeasurements.Session?
  /// VoiceOver reads inline code as text; the drawn chips are for sighted reading.
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  var body: some View {
    if let measurement, let key = unit.sizeKey {
      if let size = measurement.size(for: key) {
        Color.clear.frame(width: size.width, height: size.height)
      } else {
        content.onGeometryChange(for: CGSize.self) {
          $0.size
        } action: { size in
          measurement.observe(size, for: key)
        }
      }
    } else {
      content
    }
  }

  @ViewBuilder private var content: some View {
    switch unit {
    case .group(let units, let spacing):
      VStack(alignment: .leading, spacing: spacing) {
        ForEach(units.indices, id: \.self) { index in
          MessageRenderUnitView(
            unit: units[index], message: message, resources: resources, measurement: measurement)
        }
      }
    case .markdown(let fragment, _):
      StructuredText(
        message.text, parser: PreparedMessageParser(content: fragment, drawsInlineCode: !voiceOver)
      )
      .id(fragment)
      .id(voiceOver)
    case .connector(let action):
      if let store = message.connectorActions {
        ConnectorActionCard(action: action, store: store, loadsState: message.loadsActions)
      }
    case .permission(let action):
      if let store = message.permissionActions {
        PermissionActionCard(store: store.card(action), loadsState: message.loadsActions)
      }
    case .permissionBatch(let action):
      if let store = message.permissionActions {
        PermissionBatchCard(store: store.card(action), loadsState: message.loadsActions)
      }
    case .unavailablePermission:
      ChatCardHeader(
        title: String(localized: "Permission request unavailable"), icon: "shield-alert"
      ) {
        EmptyView()
      }
      .padding(.horizontal, OkouSpace.lg)
      .padding(.vertical, OkouSpace.md)
      .frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
      .modifier(ChatCardSurface())
    case .mailDraft(let id):
      if let approvals = message.approvals {
        MailDraftCard(store: approvals.mailDraft(id), loadsState: message.loadsActions)
      }
    case .computerAuthorization(let action):
      if let approvals = message.approvals {
        ComputerAuthorizationCard(
          store: approvals.computer(action), loadsState: message.loadsActions)
      }
    case .sshAuthorization(let action):
      if let approvals = message.approvals {
        SSHAuthorizationCard(store: approvals.ssh(action), loadsState: message.loadsActions)
      }
    case .artifact(let resource, let label, let destination):
      if let viewer = message.artifacts {
        MessageArtifactCard(
          resource: resource, label: label, destination: destination, images: resources,
          imageSources: message.artifactImageSources, viewer: viewer,
          loadsContent: message.loadsActions)
      }
    case .diagram(let code, let original):
      MessageMermaidView(
        code: code, original: original, renderer: message.markdown.diagrams,
        loadsContent: message.loadsDiagrams
      )
      .id(code)
    }
  }
}

private struct MessageImageLoader: AttachmentLoader {
  let baseURL: URL
  let artifacts: MessageArtifactStore?
  let loadsContent: Bool

  private var loader: some AttachmentLoader { .image(relativeTo: baseURL) }

  func attachment(
    for url: URL, text: String, environment: ColorEnvironmentValues
  ) async throws -> some Textual.Attachment {
    let resolved = URL(string: url.absoluteString, relativeTo: baseURL)?.absoluteURL ?? url
    guard ["https", "http"].contains(resolved.scheme?.lowercased() ?? "") else {
      throw URLError(.unsupportedURL)
    }
    if let artifacts, let resource = await artifacts.resource(resolved.absoluteString) {
      guard loadsContent else { throw CancellationError() }
      let card = try await artifacts.card(resource, thumbnail: true)
      guard let data = card.thumbnail else { throw APIClientError.invalidResponse }
      let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString + ".png")
      try data.write(to: temporary)
      defer { try? FileManager.default.removeItem(at: temporary) }
      let erase: (any Textual.Attachment) -> AnyAttachment = AnyAttachment.init
      return erase(
        try await loader.attachment(for: temporary, text: text, environment: environment))
    }
    let erase: (any Textual.Attachment) -> AnyAttachment = AnyAttachment.init
    return erase(try await loader.attachment(for: resolved, text: text, environment: environment))
  }
}

#Preview("Markdown message") {
  ScrollView {
    MessageBodyView(
      text: """
        # A complete answer

        A paragraph with **bold**, *italic*, `inline code`, and a [safe link](/chats).

        ## Next steps

        1. Review the result.
        2. Run the example:
           - Keep the input unchanged.
           - Compare the output.

        > A quoted explanation can contain **formatting** too.

        | Feature | Result |
        | --- | --- |
        | Headings and lists | Native layout |
        | Tables and code | Horizontal scrolling when needed |

        ```swift
        let answer = "Hello, Okou"
        print(answer)
        ```
        """,
      baseURL: URL(string: "https://app.okou.ai")!,
      markdown: MessageMarkdownCache(baseURL: URL(string: "https://app.okou.ai")!)
    )
    .padding(OkouSpace.xl)
  }
}
