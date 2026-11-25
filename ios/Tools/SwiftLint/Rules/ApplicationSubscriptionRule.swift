import Foundation
import SwiftLintCore
import SwiftSyntax

struct ApplicationSubscriptionRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_application_subscription", name: "No application graph subscriptions",
    description:
      "Application sources do not subscribe to a CCState Store; views read graph values through "
      + "CCStateSwiftUI and follow-up work continues in the command that made the change",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    // Production sources only; test waiters may watch a signal to observe a graph result.
    guard hasCCState(file), let path = file.path?.path else { return [] }
    // A checkout directory named Okou must not turn tests or tooling into App sources.
    var source = "/" + path
    if let root = path.range(of: "/ios/", options: .backwards) {
      source = "/" + path[root.upperBound...]
    }
    guard
      [
        "/Okou/", "/Push/", "/Widgets/", "/NotificationExtension/",
        "/Packages/ChatDomain/Sources/ChatDomain/", "/Packages/ChatData/Sources/ChatData/"
      ].contains(where: { source.contains($0) })
    else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
      // In a CCState source, a member `watch` call is a Store subscription.
      if let member = node.calledExpression.as(MemberAccessExprSyntax.self), member.base != nil,
        member.declName.baseName.text == "watch"
      {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }
  }
}
