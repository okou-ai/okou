import SwiftLintCore
import SwiftSyntax

struct ResourceFailuresRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_resource_failures", name: "Preserve resource failures",
    description:
      "Keep failures in graph callbacks and async throwing data helpers instead of publishing empty data",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let visitor = Visitor(ccstate: hasCCState(file))
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    let ccstate: Bool
    var positions: [AbsolutePosition] = []

    init(ccstate: Bool) {
      self.ccstate = ccstate
      super.init(viewMode: .sourceAccurate)
    }

    private func inResource(_ node: some SyntaxProtocol) -> Bool {
      guard ccstate else { return false }
      return ancestors(of: node).contains {
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
        if cancellationPaths(handler).isOriginalError(statement.expression) { return true }
        guard
          isCancelledRead(handler)
            || isDataRead(handler) && cancellationPaths(handler).cancelledCatch,
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
      let helperRead = dataHelper(node) != nil
      let cancelledRead = isCancelledRead(node)
      let paths = cancellationPaths(node)
      let dataRead = helperRead || isDataRead(node) && inReadExecution(node)
      let cancelledPath = dataRead && paths.swallowsCancellation()
      guard
        caughtError(node) != nil || cancelledRead || cancelledPath
          || dataRead && paths.cancelledCatch,
        inResource(node) || helperRead
      else {
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
      if statements.isEmpty || emptyReturn || returnsSuccess || cancelledPath {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    private func isCancelledRead(_ node: CatchClauseSyntax) -> Bool {
      let catchesCancellation = node.catchItems.contains { cancellationName($0) != nil }
      guard catchesCancellation else { return false }
      return isDataRead(node) || dataHelper(node) != nil
    }

    private func dataHelper(_ node: some SyntaxProtocol) -> FunctionDeclSyntax? {
      for parent in ancestors(of: node) {
        // A deferred callback or nested function owns its own result contract.
        if parent.is(ClosureExprSyntax.self) || parent.is(AccessorBlockSyntax.self)
          || parent.is(MemberBlockSyntax.self) || parent.is(DeferStmtSyntax.self)
        {
          return nil
        }
        guard let function = parent.as(FunctionDeclSyntax.self) else { continue }
        guard function.signature.effectSpecifiers?.asyncSpecifier != nil,
          function.signature.effectSpecifiers?.throwsClause?.throwsSpecifier.text == "throws",
          let result = function.signature.returnClause?.type,
          !hasSeparateResultContract(result)
        else { return nil }
        return function
      }
      return nil
    }

    private func hasSeparateResultContract(_ type: TypeSyntax, seen: Set<String> = []) -> Bool {
      if let attributed = type.as(AttributedTypeSyntax.self) {
        return hasSeparateResultContract(attributed.baseType, seen: seen)
      }
      if let optional = type.as(OptionalTypeSyntax.self) {
        return hasSeparateResultContract(optional.wrappedType, seen: seen)
      }
      if let tuple = type.as(TupleTypeSyntax.self), tuple.elements.count == 1,
        let element = tuple.elements.first, element.firstName == nil
      {
        return hasSeparateResultContract(element.type, seen: seen)
      }
      if let member = type.as(MemberTypeSyntax.self), let owner = nativeOwner(type),
        !seen.contains(member.trimmedDescription)
      {
        let ownerName =
          owner.parent?.as(ClassDeclSyntax.self)?.name.text
          ?? owner.parent?.as(StructDeclSyntax.self)?.name.text
          ?? owner.parent?.as(ActorDeclSyntax.self)?.name.text
          ?? owner.parent?.as(EnumDeclSyntax.self)?.name.text
          ?? owner.parent?.as(ProtocolDeclSyntax.self)?.name.text
          ?? owner.parent?.as(ExtensionDeclSyntax.self)?.extendedType.trimmedDescription
        if ["Self", ownerName].contains(member.baseType.trimmedDescription),
          let alias = owner.members.compactMap({ $0.decl.as(TypeAliasDeclSyntax.self) })
            .first(where: { $0.name.text == member.name.text })
        {
          return hasSeparateResultContract(
            alias.initializer.value, seen: seen.union([member.trimmedDescription]))
        }
      }
      if let identifier = type.as(IdentifierTypeSyntax.self),
        !seen.contains(identifier.name.text)
      {
        for parent in ancestors(of: type) {
          let aliases =
            parent.as(CodeBlockItemListSyntax.self)?.compactMap {
              $0.item.as(TypeAliasDeclSyntax.self)
            }
            ?? parent.as(MemberBlockSyntax.self)?.members.compactMap {
              $0.decl.as(TypeAliasDeclSyntax.self)
            }
            ?? parent.as(SourceFileSyntax.self)?.statements.compactMap {
              $0.item.as(TypeAliasDeclSyntax.self)
            } ?? []
          if let alias = aliases.first(where: { $0.name.text == identifier.name.text }) {
            return hasSeparateResultContract(
              alias.initializer.value, seen: seen.union([identifier.name.text]))
          }
        }
      }
      if ["Void", "Swift.Void", "()", "Never", "Swift.Never"].contains(type.trimmedDescription)
        || type.is(FunctionTypeSyntax.self)
      {
        return true
      }
      return arguments(
        type,
        names: [
          "Task", "Result", "Computed", "Signal", "Loadable", "AsyncStream", "AsyncThrowingStream",
        ],
        modules: ["Swift", "_Concurrency", "CCState", "CCStateSwiftUI"]) != nil
    }

    private func isDataRead(_ node: CatchClauseSyntax) -> Bool {
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

    private func inReadExecution(_ node: CatchClauseSyntax) -> Bool {
      for parent in ancestors(of: node) {
        if parent.is(FunctionDeclSyntax.self) || parent.is(AccessorBlockSyntax.self) {
          return false
        }
        guard let closure = parent.as(ClosureExprSyntax.self) else { continue }
        guard let (call, _) = closureCall(closure) else { return false }
        if isGraphCall(call, names: graphCallbacks) { return true }
        if !nativeTaskCall(call) { return false }
      }
      return false
    }

    private func cancellationPaths(_ node: CatchClauseSyntax) -> ResourceCancellationPaths {
      if let helper = dataHelper(node), let body = helper.body {
        let parameters = helper.signature.parameterClause.parameters.filter {
          ["EvaluationSignal", "CCState.EvaluationSignal"].contains($0.type.trimmedDescription)
        }
        return ResourceCancellationPaths(
          handler: node,
          signals: nativeSignalAliases(
            body.statements,
            signals: Set(parameters.map { ($0.secondName ?? $0.firstName).text })))
      }
      let callback = ancestors(of: node).compactMap { $0.as(ClosureExprSyntax.self) }.first {
        closureCall($0).map { isGraphCall($0.0, names: graphCallbacks) } == true
      }
      return ResourceCancellationPaths(
        handler: node, signals: callback.map(nativeSignalNames) ?? [])
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
