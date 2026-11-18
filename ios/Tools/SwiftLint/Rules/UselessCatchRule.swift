import SwiftLintCore
import SwiftSyntax

struct UselessCatchRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_useless_catch", name: "Remove useless catch handlers",
    description:
      "Remove a catch that only rethrows its original error; preserve any needed do scope",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: DoStmtSyntax) -> SyntaxVisitorContinueKind {
      // A filtered or neighboring catch may make an otherwise bare rethrow meaningful.
      guard node.catchClauses.count == 1, let clause = node.catchClauses.first,
        let error = caughtError(clause), clause.body.statements.count == 1,
        let statement = clause.body.statements.first?.item.as(ThrowStmtSyntax.self),
        originalError(statement.expression, name: error)
      else { return .visitChildren }
      positions.append(clause.catchKeyword.positionAfterSkippingLeadingTrivia)
      return .visitChildren
    }

    private func originalError(_ expression: ExprSyntax, name: String) -> Bool {
      if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
        let element = tuple.elements.first, element.label == nil
      {
        return originalError(element.expression, name: name)
      }
      return expression.as(DeclReferenceExprSyntax.self)?.baseName.text == name
    }
  }
}
