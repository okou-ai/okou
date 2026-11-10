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
        guard let handler = $0.as(CatchClauseSyntax.self),
          let statement = handler.body.statements.last?.item.as(ThrowStmtSyntax.self)
        else { return false }
        if let original = caughtError(handler) ?? cancellationBinding(handler),
          statement.expression.trimmedDescription == original
        {
          return true
        }
        guard isCancelledRead(handler),
          let call = statement.expression.as(FunctionCallExprSyntax.self)
        else { return false }
        return ["CancellationError", "_Concurrency.CancellationError", "Swift.CancellationError"]
          .contains(call.calledExpression.trimmedDescription)
      }
      if node.questionOrExclamationMark?.text == "?", inResource(node), !rethrowsOriginal {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    override func visit(_ node: CatchClauseSyntax) -> SyntaxVisitorContinueKind {
      let cancelledRead = isCancelledRead(node)
      guard caughtError(node) != nil || cancelledRead, inResource(node) else {
        return .visitChildren
      }
      let statements = node.body.statements
      let emptyReturn =
        statements.count == 1
        && statements.first?.item.as(ReturnStmtSyntax.self)?.expression.map {
          ["nil", "[]", "[:]"].contains($0.trimmedDescription)
        } == true
      let returnsSuccess =
        cancelledRead
        && ReturnsVisitor(viewMode: .sourceAccurate).walk(
          tree: node.body, handler: \.found)
      if statements.isEmpty || emptyReturn || returnsSuccess {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    private func isCancelledRead(_ node: CatchClauseSyntax) -> Bool {
      let catchesCancellation = node.catchItems.contains { cancellationName($0) != nil }
      guard catchesCancellation else { return false }
      // A command may deliberately end a cancelled UI operation. A resource
      // read must keep cancellation in its Task rather than publish data.
      for ancestor in ancestors(of: node) {
        guard let closure = ancestor.as(ClosureExprSyntax.self),
          let (call, _) = closureCall(closure), isGraphCall(call, names: graphCallbacks)
        else { continue }
        return ["Computed", "computedTask"].contains(callName(call.calledExpression))
          && !isCompletionGraph(call)
      }
      return false
    }

    private func cancellationBinding(_ node: CatchClauseSyntax) -> String? {
      guard isCancelledRead(node), node.catchItems.count == 1,
        let item = node.catchItems.first
      else { return nil }
      return cancellationName(item)
    }

    private func cancellationName(_ item: CatchItemSyntax) -> String? {
      let types = [
        "CancellationError", "_Concurrency.CancellationError", "Swift.CancellationError",
      ]
      let tokens = item.pattern?.tokens(viewMode: .sourceAccurate).map(\.text) ?? []
      if let cast = tokens.lastIndex(where: { $0 == "is" || $0 == "as" }),
        types.contains(tokens.suffix(from: cast + 1).joined())
      {
        if tokens.first == "is" { return "error" }
        if cast == 2, ["let", "var"].contains(tokens[0]) { return tokens[1] }
      }
      let name: String
      if tokens.isEmpty {
        name = "error"
      } else if tokens.count == 2, ["let", "var"].contains(tokens[0]) {
        name = tokens[1]
      } else {
        return nil
      }
      let condition =
        item.whereClause?.condition.tokens(viewMode: .sourceAccurate).map(\.text) ?? []
      if condition.count >= 3, condition[0] == name, condition[1] == "is",
        types.contains(condition.dropFirst(2).joined())
      {
        return name
      }
      return nil
    }

    private func isCompletionGraph(_ call: FunctionCallExprSyntax) -> Bool {
      for parent in ancestors(of: call) {
        if let binding = parent.as(PatternBindingSyntax.self),
          binding.initializer?.value.id == call.id, let type = binding.typeAnnotation?.type
        {
          return isCompletionType(type)
        }
        if let function = parent.as(FunctionDeclSyntax.self) {
          return function.signature.returnClause.map { isCompletionType($0.type) } ?? false
        }
      }
      return false
    }

    private func isCompletionType(_ type: TypeSyntax) -> Bool {
      guard let graph = arguments(type, names: ["Computed", "Signal"], modules: ["CCState"]),
        graph.count == 1, let value = graph.first?.argument.as(TypeSyntax.self),
        let task = arguments(value, names: ["Task"], modules: ["Swift", "_Concurrency"]),
        task.count == 2, let success = task.first?.argument.as(TypeSyntax.self),
        let failure = task.last?.argument.as(TypeSyntax.self)
      else { return false }
      return ["Void", "Swift.Void", "()"].contains(success.trimmedDescription)
        && ["Never", "Swift.Never"].contains(failure.trimmedDescription)
    }

    private func arguments(_ type: TypeSyntax, names: Set<String>, modules: Set<String>)
      -> GenericArgumentListSyntax?
    {
      if let identifier = type.as(IdentifierTypeSyntax.self), names.contains(identifier.name.text) {
        return identifier.genericArgumentClause?.arguments
      }
      if let member = type.as(MemberTypeSyntax.self), names.contains(member.name.text),
        modules.contains(member.baseType.trimmedDescription)
      {
        return member.genericArgumentClause?.arguments
      }
      return nil
    }
  }

  private final class ReturnsVisitor: SyntaxVisitor {
    var found = false
    override func visit(_ node: ReturnStmtSyntax) -> SyntaxVisitorContinueKind {
      found = true
      return .skipChildren
    }
    override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  }
}
