import Foundation
import SwiftLintCore
import SwiftSyntax

struct ImportBoundariesRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_import_boundaries", name: "Owned native imports",
    description: "Keep SDK imports at their adapters and preserve Domain/Data dependency direction",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let visitor = Visitor(path: file.path?.path ?? "")
    visitor.walk(file.syntaxTree)
    return visitor.violations.map { position, reason in
      StyleViolation(
        ruleDescription: Self.description, severity: configuration.severity,
        location: Location(file: file, position: position), reason: reason)
    }
  }

  private final class Visitor: SyntaxVisitor {
    let path: String
    var violations: [(AbsolutePosition, String)] = []

    init(path: String) {
      self.path = path
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: ImportDeclSyntax) -> SyntaxVisitorContinueKind {
      guard let identifier = node.path.first?.name.text else { return .skipChildren }
      let module = identifier.trimmingCharacters(in: CharacterSet(charactersIn: "`"))
      if path.contains("/Packages/ChatDomain/Sources/"),
        !["Foundation", "Swift"].contains(module)
      {
        report(node, "ChatDomain imports only Foundation and the Swift standard library")
      } else if path.contains("/Packages/ChatData/Sources/"),
        Self.dataForbidden.contains(module) || Self.sdkOwners[module] != nil
      {
        report(node, "ChatData must not depend on App, UI, state graphs, or identity/realtime SDKs")
      } else if let owners = Self.sdkOwners[module],
        !owners.contains(where: { path.hasSuffix("/" + $0) })
      {
        report(node, "Import \(module) only at its native adapter or external-provider test owner")
      }
      return .skipChildren
    }

    private func report(_ node: ImportDeclSyntax, _ reason: String) {
      violations.append((node.importKeyword.positionAfterSkippingLeadingTrivia, reason))
    }

    // Definition sites, including the SDK's real external-provider fixtures.
    // These are import contracts, not whole-directory lint exclusions. A new
    // adapter needs an explicit dependency-boundary review and CLI coverage.
    private static let sdkOwners: [String: Set<String>] = [
      "Ably": [
        "Okou/Services/RealtimeService.swift",
        "OkouTests/RealtimeResourceRecoveryTests.swift",
      ],
      "ClerkKit": [
        "Okou/Services/AuthenticationService.swift",
        "Okou/Features/SignIn/NativeAuthFlow.swift",
        "Okou/Features/SignIn/AuthProviderMark.swift",
        "Okou/Features/SignIn/NativeAuthView.swift",
        "Okou/Features/SignIn/SignInView.swift",
        "Push/NotificationExtensionSession.swift",
        "Push/PushConfiguration.swift",
        "OkouTests/AuthenticationHTTPFixture.swift",
        "OkouTests/AuthenticationScopeTests.swift",
        "OkouTests/NativeAuthFlowTests.swift",
      ],
      "ClerkKitUI": [
        "Okou/DesignSystem/Foundations/OkouAuthTheme.swift",
        "Okou/Features/SignIn/NativeAuthView.swift",
      ],
    ]

    // Known forbidden module edges; system storage, crypto, synchronization and
    // transport frameworks remain valid in Data. Unknown modules still need
    // dependency review; syntax alone cannot classify every future framework.
    private static let dataForbidden: Set<String> = [
      "Okou", "SwiftUI", "UIKit", "AppKit", "WebKit", "AuthenticationServices",
      "CCState", "CCStateSwiftUI",
    ]
  }
}
