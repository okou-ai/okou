import SwiftLintCore
import SwiftSyntax

struct DiscardedThrowingTaskRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_discarded_throwing_task", name: "Handle discarded Task errors",
    description: "Await, transfer, or internally handle errors from a newly created throwing Task",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: SequenceExprSyntax) -> SyntaxVisitorContinueKind {
      let parts = Array(node.elements)
      if parts.count == 3, parts[0].is(DiscardAssignmentExprSyntax.self),
        parts[1].is(AssignmentExprSyntax.self)
      {
        inspect(parts[2])
      }
      return .visitChildren
    }

    override func visit(_ node: PatternBindingSyntax) -> SyntaxVisitorContinueKind {
      if node.pattern.is(WildcardPatternSyntax.self), let value = node.initializer?.value {
        inspect(value)
      }
      return .visitChildren
    }

    private func inspect(_ expression: ExprSyntax) {
      if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
        let element = tuple.elements.first, element.label == nil
      {
        inspect(element.expression)
        return
      }
      guard let call = expression.as(FunctionCallExprSyntax.self), nativeTaskCall(call),
        let body = nativeTaskBody(call)
      else { return }
      let errors = EscapingErrors(scope: body)
      errors.walk(body.statements)
      if errors.found { positions.append(call.positionAfterSkippingLeadingTrivia) }
    }
  }

  private final class EscapingErrors: SyntaxVisitor {
    let scope: ClosureExprSyntax
    var found = false

    init(scope: ClosureExprSyntax) {
      self.scope = scope
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: TryExprSyntax) -> SyntaxVisitorContinueKind {
      // An optional/forced try contains its nested expressions' error channel.
      if node.questionOrExclamationMark == nil, !handled(node) { found = true }
      return .skipChildren
    }

    override func visit(_ node: ThrowStmtSyntax) -> SyntaxVisitorContinueKind {
      if !handled(node) { found = true }
      return .skipChildren
    }

    private func handled(_ node: some SyntaxProtocol) -> Bool {
      var child = Syntax(node)
      for parent in ancestors(of: node) {
        // A catch around Task creation cannot handle that Task's later failure.
        if parent.id == scope.id { break }
        if let statement = parent.as(DoStmtSyntax.self), child.id == statement.body.id,
          statement.catchClauses.contains(where: catchesAll)
        {
          return true
        }
        child = parent
      }
      return false
    }

    private func catchesAll(_ clause: CatchClauseSyntax) -> Bool {
      if clause.catchItems.isEmpty { return true }
      return clause.catchItems.contains { item in
        guard item.whereClause == nil else { return false }
        guard let pattern = item.pattern else { return true }
        let tokens = pattern.tokens(viewMode: .sourceAccurate).map(\.text)
        if tokens == ["_"] { return true }
        if let binding = pattern.as(ValueBindingPatternSyntax.self),
          binding.pattern.is(IdentifierPatternSyntax.self)
            || binding.pattern.is(WildcardPatternSyntax.self)
        {
          return true
        }
        // Standard Error and NSError catches cover every Swift error.
        guard let cast = tokens.lastIndex(where: { $0 == "as" || $0 == "is" }) else {
          return false
        }
        return [
          "Error", "Swift.Error", "anyError", "anySwift.Error", "NSError", "Foundation.NSError",
        ]
        .contains(tokens.dropFirst(cast + 1).joined())
      }
    }

    override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: MemberBlockSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: AccessorBlockSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  }
}
