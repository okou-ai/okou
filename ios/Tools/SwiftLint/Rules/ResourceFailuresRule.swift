import SwiftLintCore
import SwiftSyntax

struct ResourceFailuresRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_resource_failures", name: "Preserve resource failures",
    description:
      "Keep failures in CCState resource/action Tasks instead of converting them to successful empty data",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    guard hasCCState(file) else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    private func inResource(_ node: some SyntaxProtocol) -> Bool {
      ancestors(of: node).contains {
        guard let closure = $0.as(ClosureExprSyntax.self), let (call, _) = closureCall(closure)
        else { return false }
        return isGraphCall(call, names: graphCallbacks)
      }
    }

    override func visit(_ node: TryExprSyntax) -> SyntaxVisitorContinueKind {
      // A cleanup failure must not replace the primary failure. This permits
      // only catch paths whose final statement rethrows that original error.
      let rethrowsOriginal = ancestors(of: node).contains {
        guard let handler = $0.as(CatchClauseSyntax.self), let original = caughtError(handler),
          let statement = handler.body.statements.last?.item.as(ThrowStmtSyntax.self)
        else { return false }
        return statement.expression.trimmedDescription == original
      }
      if node.questionOrExclamationMark?.text == "?", inResource(node), !rethrowsOriginal {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    override func visit(_ node: CatchClauseSyntax) -> SyntaxVisitorContinueKind {
      guard caughtError(node) != nil, inResource(node) else { return .visitChildren }
      let statements = node.body.statements
      let emptyReturn =
        statements.count == 1
        && statements.first?.item.as(ReturnStmtSyntax.self)?.expression.map {
          ["nil", "[]", "[:]"].contains($0.trimmedDescription)
        } == true
      if statements.isEmpty || emptyReturn {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }
  }
}
