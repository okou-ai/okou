import SwiftSyntax

func nativeTaskCall(_ call: FunctionCallExprSyntax) -> Bool {
  var expression = call.calledExpression
  if let generic = expression.as(GenericSpecializationExprSyntax.self) {
    expression = generic.expression
  }
  if nativeTaskType(expression) { return true }
  guard let member = expression.as(MemberAccessExprSyntax.self), let base = member.base,
    ["init", "immediate", "detached"].contains(member.declName.baseName.text)
  else { return false }
  return nativeTaskType(base)
}

private func nativeTaskType(_ expression: ExprSyntax) -> Bool {
  if let generic = expression.as(GenericSpecializationExprSyntax.self) {
    return nativeTaskType(generic.expression)
  }
  return ["Task", "Swift.Task", "_Concurrency.Task"].contains(expression.trimmedDescription)
}

func nativeTaskBody(_ call: FunctionCallExprSyntax) -> ClosureExprSyntax? {
  call.trailingClosure
    ?? call.arguments.first(where: { $0.label?.text == "operation" })?.expression
    .as(ClosureExprSyntax.self)
}

func nativeOwner(_ node: some SyntaxProtocol) -> MemberBlockSyntax? {
  ancestors(of: node).compactMap { $0.as(MemberBlockSyntax.self) }.first
}

func nativeProperties(_ owner: MemberBlockSyntax?) -> Set<String> {
  guard let owner else { return [] }
  return Set(
    owner.members.flatMap { member -> [String] in
      guard let variable = member.decl.as(VariableDeclSyntax.self) else { return [] }
      return variable.bindings.compactMap { binding in
        let type = binding.typeAnnotation?.type.trimmedDescription ?? ""
        // Cancelling/releasing a retained handle is teardown, not publishing read data.
        guard !type.contains("Task<"), !type.contains("Subscription"),
          !type.contains("Continuation")
        else { return nil }
        return binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
      }
    })
}

func nativeSignalNames(_ closure: ClosureExprSyntax) -> Set<String> {
  let parameters = closureParameters(closure)
  guard parameters.count > 1, parameters[1] != "_" else { return [] }
  return nativeSignalAliases(closure.statements, signals: [parameters[1] + ".signal"])
}

func nativeSignalAliases(_ statements: CodeBlockItemListSyntax, signals initial: Set<String>)
  -> Set<String>
{
  var signals = initial
  for statement in statements {
    guard let variable = statement.item.as(VariableDeclSyntax.self),
      variable.bindingSpecifier.text == "let"
    else { continue }
    for binding in variable.bindings {
      guard let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text else {
        continue
      }
      let alias = binding.initializer.map { signals.contains($0.value.trimmedDescription) } ?? false
      signals.remove(name)
      signals.remove(name + ".signal")
      if alias { signals.insert(name) }
    }
  }
  return signals
}

/// Facts from the current execution scope; callback bodies run under their own owner.
final class CancellationFacts: SyntaxVisitor {
  var awaits = false

  init() { super.init(viewMode: .sourceAccurate) }
  override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  override func visit(_ node: DeferStmtSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  override func visit(_ node: AwaitExprSyntax) -> SyntaxVisitorContinueKind {
    awaits = true
    return .visitChildren
  }
}

func nativeCondition(
  _ condition: some SyntaxProtocol, properties: Set<String>, locals: Set<String> = [],
  signals: Set<String> = []
) -> Int {
  let checks = ConditionChecks(properties: properties, locals: locals, signals: signals)
  if let conditions = condition.as(ConditionElementListSyntax.self) {
    let proofs = conditions.map { element in
      element.condition.as(ExprSyntax.self).map { checks.proof($0) } ?? 0
    }
    if proofs.count == 1 { return proofs.first ?? 0 }
    // Every comma condition holds on success; failure can come from any condition.
    return proofs.contains(1) ? 1 : 0
  }
  return condition.as(ExprSyntax.self).map { checks.proof($0) } ?? 0
}

private struct ConditionChecks {
  let properties: Set<String>
  let locals: Set<String>
  let signals: Set<String>

  /// Positive proves the true path; negative proves the false path. Zero proves neither.
  func proof(_ expression: ExprSyntax) -> Int {
    if let prefix = expression.as(PrefixOperatorExprSyntax.self), prefix.operator.text == "!" {
      return -proof(prefix.expression)
    }
    if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
      let element = tuple.elements.first, element.label == nil
    {
      return proof(element.expression)
    }
    if let sequence = expression.as(SequenceExprSyntax.self) {
      return sequenceProof(Array(sequence.elements))
    }
    if let member = expression.as(MemberAccessExprSyntax.self),
      member.declName.baseName.text == "isCancelled",
      Set(["Task", "Swift.Task", "_Concurrency.Task"]).union(signals)
        .contains(member.base?.trimmedDescription ?? "")
    {
      return -1
    }
    if let property = ownedProperty(expression), ["closed", "isClosed"].contains(property),
      properties.contains(property)
    {
      return -1
    }
    // A flag passed into an unknown helper is not proof about that helper's result.
    return 0
  }

  private func sequenceProof(_ parts: [ExprSyntax]) -> Int {
    if parts.count == 1, let expression = parts.first { return proof(expression) }
    let operations = parts.compactMap { $0.as(BinaryOperatorExprSyntax.self)?.operator.text }
    guard !operations.contains("||") else { return 0 }
    if operations.contains("&&") {
      var segment: [ExprSyntax] = []
      var proofs: [Int] = []
      for part in parts {
        if part.as(BinaryOperatorExprSyntax.self)?.operator.text == "&&" {
          proofs.append(sequenceProof(segment))
          segment.removeAll()
        } else {
          segment.append(part)
        }
      }
      proofs.append(sequenceProof(segment))
      // A failed conjunction may only mean an unrelated condition was false.
      return proofs.contains(1) ? 1 : 0
    }
    guard parts.count == 3, let operation = parts[1].as(BinaryOperatorExprSyntax.self),
      ["==", "!="].contains(operation.operator.text)
    else { return 0 }
    for index in [0, 2] {
      if let value = parts[index].as(BooleanLiteralExprSyntax.self) {
        let other = proof(parts[2 - index])
        let matchesTrue = (value.literal.text == "true") == (operation.operator.text == "==")
        return matchesTrue ? other : -other
      }
    }
    guard parts[0].trimmedDescription != parts[2].trimmedDescription else { return 0 }
    let generation = [parts[0], parts[2]].compactMap { ownedProperty($0) }.contains {
      properties.contains($0)
        && ($0.lowercased().contains("generation") || $0.lowercased().contains("revision"))
    }
    return generation ? (operation.operator.text == "==" ? 1 : -1) : 0
  }

  private func ownedProperty(_ expression: ExprSyntax) -> String? {
    if let name = expression.as(DeclReferenceExprSyntax.self)?.baseName.text,
      !locals.contains(name)
    {
      return name
    }
    if let member = expression.as(MemberAccessExprSyntax.self),
      member.base?.trimmedDescription == "self"
    {
      return member.declName.baseName.text
    }
    return nil
  }
}

func nativeCheckHelpers(_ owner: MemberBlockSyntax?, properties: Set<String>) -> Set<String> {
  guard let owner else { return [] }
  var proofs: [String: [Bool]] = [:]
  for member in owner.members {
    guard let function = member.decl.as(FunctionDeclSyntax.self),
      function.signature.effectSpecifiers?.asyncSpecifier == nil,
      let first = function.body?.statements.first
    else { continue }
    var proven = false
    if let attempt = first.item.as(TryExprSyntax.self),
      attempt.questionOrExclamationMark == nil,
      let call = attempt.expression.as(FunctionCallExprSyntax.self),
      let method = call.calledExpression.as(MemberAccessExprSyntax.self),
      method.declName.baseName.text == "checkCancellation",
      ["Task", "Swift.Task", "_Concurrency.Task"].contains(method.base?.trimmedDescription ?? "")
    {
      proven = true
    }
    if let guardStatement = first.item.as(GuardStmtSyntax.self),
      nativeCondition(
        guardStatement.conditions, properties: properties,
        locals: Set(
          function.signature.parameterClause.parameters.map {
            ($0.secondName ?? $0.firstName).text
          })) > 0,
      guardStatement.body.statements.last?.item.is(ThrowStmtSyntax.self) == true
    {
      proven = true
    }
    proofs[function.name.text, default: []].append(proven)
  }
  return Set(proofs.compactMap { name, paths in paths.allSatisfy { $0 } ? name : nil })
}
