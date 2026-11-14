import SwiftSyntax

// Resolve only visible declarations, never a factory's name or its return type alone.
final class NativeGraphFactories {
  private var fresh: [AbsolutePosition: Bool] = [:]
  private var names: Set<String> = []

  init(tree: SourceFileSyntax) {
    let functions = Functions(viewMode: .sourceAccurate)
    functions.walk(tree)
    for function in functions.declarations where returnsFreshGraph(function) {
      names.insert(function.name.text)
    }
  }

  func constructsGraph(_ call: FunctionCallExprSyntax) -> Bool {
    guard names.contains(callName(call.calledExpression)) else { return false }
    var expression = call.calledExpression
    if let generic = expression.as(GenericSpecializationExprSyntax.self) {
      expression = generic.expression
    }
    if let reference = expression.as(DeclReferenceExprSyntax.self) {
      let name = reference.baseName.text
      for scope in ancestors(of: call) {
        if shadows(name, in: scope, at: call) { return false }
        guard let declarations = declarations(in: scope) else { continue }
        if let result = lookup(name, in: declarations, at: call) { return result }
      }
    } else if let member = expression.as(MemberAccessExprSyntax.self),
      let receiver = member.base?.as(DeclReferenceExprSyntax.self)
    {
      let name = member.declName.baseName.text
      let receiverName = receiver.baseName.text
      if ["self", "Self"].contains(receiverName), let owner = nativeOwner(call) {
        return lookup(name, in: owner.members.map(\.decl), at: call) ?? false
      }
      for scope in ancestors(of: call) {
        if shadows(receiverName, in: scope, at: call) { return false }
        guard let declarations = declarations(in: scope) else { continue }
        if boundValue(receiverName, in: declarations, at: call) { return false }
        let types = declarations.filter { typeName($0) == receiverName }
        guard !types.isEmpty else { continue }
        guard types.count == 1, let members = members(of: types[0]) else { return false }
        let functions = members.members.compactMap { $0.decl.as(FunctionDeclSyntax.self) }
          .filter { $0.modifiers.contains { $0.name.text == "static" } }
        return matching(name, functions: functions, call: call)
      }
    }
    return false
  }

  private func declarations(in scope: Syntax) -> [DeclSyntax]? {
    if let block = scope.as(MemberBlockSyntax.self) { return block.members.map(\.decl) }
    let statements =
      scope.as(CodeBlockItemListSyntax.self) ?? scope.as(SourceFileSyntax.self)?.statements
    return statements?.compactMap { $0.item.as(DeclSyntax.self) }
  }

  private func lookup(
    _ name: String, in declarations: [DeclSyntax], at call: FunctionCallExprSyntax
  ) -> Bool? {
    if boundValue(name, in: declarations, at: call)
      || declarations.contains(where: { typeName($0) == name })
    {
      return false
    }
    let functions = declarations.compactMap { $0.as(FunctionDeclSyntax.self) }
      .filter { $0.name.text == name }
    guard !functions.isEmpty else { return nil }
    return matching(name, functions: functions, call: call)
  }

  private func matching(
    _ name: String, functions: [FunctionDeclSyntax], call: FunctionCallExprSyntax
  ) -> Bool {
    // Without types, an overload is proven fresh only when every matching body is fresh.
    guard call.trailingClosure == nil, call.additionalTrailingClosures.isEmpty else { return false }
    guard
      !functions.contains(where: { function in
        function.name.text == name
          && function.signature.parameterClause.parameters.contains {
            $0.defaultValue != nil || $0.ellipsis != nil
          }
      })
    else { return false }
    let matches = functions.filter { function in
      let parameters = function.signature.parameterClause.parameters
      return function.name.text == name && parameters.count == call.arguments.count
        && zip(parameters, call.arguments).allSatisfy {
          ($0.0.firstName.text == "_" ? nil : $0.0.firstName.text) == $0.1.label?.text
        }
    }
    return !matches.isEmpty && matches.allSatisfy(returnsFreshGraph)
  }

  private func returnsFreshGraph(_ function: FunctionDeclSyntax) -> Bool {
    if let value = fresh[function.position] { return value }
    let result: Bool
    if fixedDispatch(function), let type = function.signature.returnClause?.type, graphType(type),
      let body = function.body
    {
      if body.statements.count == 1,
        let expression = body.statements.first?.item.as(ExprSyntax.self)
      {
        result = Self.construction(expression)
      } else {
        let returns = Returns(viewMode: .sourceAccurate)
        returns.walk(body)
        result = returns.found && returns.allFresh
      }
    } else {
      result = false
    }
    fresh[function.position] = result
    return result
  }

  private func fixedDispatch(_ function: FunctionDeclSyntax) -> Bool {
    guard function.parent?.is(MemberBlockItemSyntax.self) == true else { return true }
    if function.modifiers.contains(where: { ["static", "final", "private"].contains($0.name.text) })
    {
      return true
    }
    let owner = nativeOwner(function)?.parent
    if let declaration = owner?.as(ClassDeclSyntax.self) {
      return declaration.modifiers.contains { $0.name.text == "final" }
    }
    return owner?.is(ExtensionDeclSyntax.self) != true
  }

  private func graphType(_ type: TypeSyntax) -> Bool {
    let name: String
    if let identifier = type.as(IdentifierTypeSyntax.self) {
      name = identifier.name.text
    } else if let member = type.as(MemberTypeSyntax.self),
      member.baseType.trimmedDescription == "CCState"
    {
      name = member.name.text
    } else {
      return false
    }
    return graphConstructors.union(["Signal"]).contains(name)
  }

  private static func construction(_ expression: ExprSyntax) -> Bool {
    if let attempt = expression.as(TryExprSyntax.self), attempt.questionOrExclamationMark == nil {
      return construction(attempt.expression)
    }
    if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
      let element = tuple.elements.first, element.label == nil
    {
      return construction(element.expression)
    }
    return expression.as(FunctionCallExprSyntax.self).map {
      isGraphCall($0, names: graphConstructors)
    } == true
  }

  private func boundValue(
    _ name: String, in declarations: [DeclSyntax], at call: FunctionCallExprSyntax
  ) -> Bool {
    declarations.contains { declaration in
      guard let variable = declaration.as(VariableDeclSyntax.self) else { return false }
      let local =
        variable.parent?.is(CodeBlockItemSyntax.self) == true
        && variable.parent?.parent?.parent?.is(CodeBlockSyntax.self) == true
      guard !local || variable.position < call.position else { return false }
      return variable.bindings.contains { binding in
        binds(binding.pattern, name: name)
          && binding.initializer.map {
            $0.position <= call.position && call.position < $0.endPosition
          } != true
      }
    }
  }

  private func shadows(_ name: String, in scope: Syntax, at call: FunctionCallExprSyntax) -> Bool {
    let parameters =
      scope.as(FunctionDeclSyntax.self)?.signature.parameterClause.parameters
      ?? scope.as(InitializerDeclSyntax.self)?.signature.parameterClause.parameters
    if parameters?.contains(where: { ($0.secondName ?? $0.firstName).text == name }) == true {
      return true
    }
    if let closure = scope.as(ClosureExprSyntax.self) {
      if closureParameters(closure).contains(name) { return true }
      if closure.signature?.capture?.items.contains(where: { $0.name.text == name }) == true {
        return true
      }
    }
    if let loop = scope.as(ForStmtSyntax.self), loop.body.position <= call.position,
      binds(loop.pattern, name: name)
    {
      return true
    }
    if let branch = scope.as(IfExprSyntax.self),
      branch.body.position <= call.position && call.position < branch.body.endPosition,
      binds(branch.conditions, name: name)
    {
      return true
    }
    if let loop = scope.as(WhileStmtSyntax.self), loop.body.position <= call.position,
      binds(loop.conditions, name: name)
    {
      return true
    }
    if let branch = scope.as(SwitchCaseSyntax.self),
      let label = branch.label.as(SwitchCaseLabelSyntax.self),
      label.caseItems.contains(where: { binds($0.pattern, name: name) })
    {
      return true
    }
    if let handler = scope.as(CatchClauseSyntax.self),
      handler.catchItems.contains(where: {
        $0.pattern.map { binds($0, name: name) } == true
      })
    {
      return true
    }
    if let statements = scope.as(CodeBlockItemListSyntax.self) {
      return statements.contains {
        $0.endPosition <= call.position
          && $0.item.as(GuardStmtSyntax.self).map { binds($0.conditions, name: name) } == true
      }
    }
    return false
  }

  private func binds(_ conditions: ConditionElementListSyntax, name: String) -> Bool {
    conditions.contains {
      let pattern =
        $0.condition.as(OptionalBindingConditionSyntax.self)?.pattern
        ?? $0.condition.as(MatchingPatternConditionSyntax.self)?.pattern
      return pattern.map { binds($0, name: name) } == true
    }
  }

  private func binds(_ pattern: PatternSyntax, name: String) -> Bool {
    pattern.tokens(viewMode: .sourceAccurate).contains { $0.text == name }
  }

  private func typeName(_ declaration: DeclSyntax) -> String? {
    declaration.as(StructDeclSyntax.self)?.name.text
      ?? declaration.as(ClassDeclSyntax.self)?.name.text
      ?? declaration.as(ActorDeclSyntax.self)?.name.text
      ?? declaration.as(EnumDeclSyntax.self)?.name.text
      ?? declaration.as(TypeAliasDeclSyntax.self)?.name.text
  }

  private func members(of declaration: DeclSyntax) -> MemberBlockSyntax? {
    declaration.as(StructDeclSyntax.self)?.memberBlock
      ?? declaration.as(ClassDeclSyntax.self)?.memberBlock
      ?? declaration.as(ActorDeclSyntax.self)?.memberBlock
      ?? declaration.as(EnumDeclSyntax.self)?.memberBlock
  }

  private final class Returns: SyntaxVisitor {
    var found = false
    var allFresh = true

    override func visit(_ node: ReturnStmtSyntax) -> SyntaxVisitorContinueKind {
      found = true
      allFresh = allFresh && node.expression.map(NativeGraphFactories.construction) == true
      return .skipChildren
    }
    override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: ActorDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: EnumDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  }

  private final class Functions: SyntaxVisitor {
    var declarations: [FunctionDeclSyntax] = []
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind {
      declarations.append(node)
      return .visitChildren
    }
  }
}
