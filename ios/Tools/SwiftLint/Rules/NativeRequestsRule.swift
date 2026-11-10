import Foundation
import SwiftLintCore
import SwiftSyntax

struct NativeRequestsRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_native_requests", name: "Owned native transport",
    description:
      "Use typed ChatData services; raw URLSession requests belong to transport adapters",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    // Exact transport definition sites, not feature-directory exclusions. Asset
    // adapters intentionally omit application credentials and client headers.
    let owners = [
      "/Packages/ChatData/Sources/ChatData/APIClient.swift",
      "/Packages/ChatData/Sources/ChatData/IdentityPresentationCache.swift",
      "/Okou/Features/ChatDetail/ConnectorIconLoader.swift",
    ]
    if let path = file.path?.path, owners.contains(where: { path.hasSuffix($0) }) { return [] }
    let names = NameCollector(viewMode: .sourceAccurate)
    names.walk(file.syntaxTree)
    let visitor = Visitor(sessions: names.sessions)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    let sessions: Set<String>
    var positions: [AbsolutePosition] = []

    init(sessions: Set<String>) {
      self.sessions = sessions
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: MemberAccessExprSyntax) -> SyntaxVisitorContinueKind {
      guard let base = node.base,
        ["data", "download", "upload", "dataTask", "downloadTask", "uploadTask", "webSocketTask"]
          .contains(node.declName.baseName.text)
      else { return .visitChildren }
      let receiver = base.trimmedDescription.replacingOccurrences(of: "?", with: "")
      let lastName = receiver.components(separatedBy: ".").last ?? ""
      if receiver.hasPrefix("URLSession.") || receiver.hasPrefix("URLSession(")
        || receiver.hasPrefix("Foundation.URLSession.") || sessions.contains(lastName)
      {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }
  }
}
