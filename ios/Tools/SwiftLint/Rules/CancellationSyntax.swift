import SwiftSyntax

func nativeTaskCall(_ call: FunctionCallExprSyntax) -> Bool {
  var expression = call.calledExpression
  if let generic = expression.as(GenericSpecializationExprSyntax.self) {
    expression = generic.expression
  }
  let name = expression.trimmedDescription
  return [
    "Task", "Swift.Task", "_Concurrency.Task", "Task.immediate", "Task.detached",
    "Swift.Task.immediate", "_Concurrency.Task.immediate", "_Concurrency.Task.detached",
  ]
  .contains(name)
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
  // A check hidden on only one side of OR does not establish the successful path.
  let tokens = condition.tokens(viewMode: .sourceAccurate).map(\.text)
  guard !tokens.contains("||") else { return 0 }
  let visitor = ConditionChecks(properties: properties, locals: locals, signals: signals)
  visitor.walk(condition)
  return visitor.result
}

private final class ConditionChecks: SyntaxVisitor {
  let properties: Set<String>
  let locals: Set<String>
  let signals: Set<String>
  var result = 0
  init(properties: Set<String>, locals: Set<String>, signals: Set<String>) {
    self.properties = properties
    self.locals = locals
    self.signals = signals
    super.init(viewMode: .sourceAccurate)
  }
  override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  override func visit(_ node: MemberAccessExprSyntax) -> SyntaxVisitorContinueKind {
    if node.declName.baseName.text == "isCancelled",
      (Set(["Task", "Swift.Task", "_Concurrency.Task"]).union(signals))
        .contains(node.base?.trimmedDescription ?? "")
    {
      mark(node)
    }
    if ["closed", "isClosed"].contains(node.declName.baseName.text),
      node.base?.trimmedDescription == "self", properties.contains(node.declName.baseName.text)
    {
      mark(node)
    }
    return .visitChildren
  }
  override func visit(_ node: DeclReferenceExprSyntax) -> SyntaxVisitorContinueKind {
    if ["closed", "isClosed"].contains(node.baseName.text),
      properties.contains(node.baseName.text), !locals.contains(node.baseName.text),
      node.parent?.is(MemberAccessExprSyntax.self) != true
    {
      mark(node)
    }
    return .visitChildren
  }
  override func visit(_ node: SequenceExprSyntax) -> SyntaxVisitorContinueKind {
    let parts = Array(node.elements)
    for index in parts.indices where index > 0 && index + 1 < parts.count {
      guard let operation = parts[index].as(BinaryOperatorExprSyntax.self),
        ["==", "!="].contains(operation.operator.text),
        parts[index - 1].trimmedDescription != parts[index + 1].trimmedDescription
      else { continue }
      let names = [parts[index - 1], parts[index + 1]].map { value in
        value.as(DeclReferenceExprSyntax.self).flatMap {
          locals.contains($0.baseName.text) ? nil : $0.baseName.text
        } ?? value.as(MemberAccessExprSyntax.self).flatMap {
          $0.base?.trimmedDescription == "self" ? $0.declName.baseName.text : nil
        } ?? ""
      }
      if names.contains(where: {
        properties.contains($0)
          && ($0.lowercased().contains("generation") || $0.lowercased().contains("revision"))
      }) {
        result = operation.operator.text == "==" ? 1 : -1
      }
    }
    return .visitChildren
  }
  private func mark(_ node: some SyntaxProtocol) {
    let negated = node.parent?.as(PrefixOperatorExprSyntax.self)?.operator.text == "!"
    result = negated ? 1 : -1
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
