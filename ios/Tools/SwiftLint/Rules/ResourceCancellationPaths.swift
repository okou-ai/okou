import SwiftSyntax

/// Visible cancellation paths in one catch; unknown helper semantics still require review.
struct ResourceCancellationPaths {
  let handler: CatchClauseSyntax
  let signals: Set<String>

  var binding: String? {
    if handler.catchItems.isEmpty { return "error" }
    guard handler.catchItems.count == 1, let item = handler.catchItems.first else { return nil }
    let pattern = item.pattern?.tokens(viewMode: .sourceAccurate).map(\.text) ?? []
    if pattern.isEmpty || pattern.first == "is" { return "error" }
    if pattern.count >= 2, ["let", "var"].contains(pattern[0]) { return pattern[1] }
    return nil
  }

  private var urlError: Bool {
    guard let item = handler.catchItems.first else { return false }
    let pattern = item.pattern?.tokens(viewMode: .sourceAccurate).map(\.text) ?? []
    guard let cast = pattern.firstIndex(of: "as") ?? pattern.firstIndex(of: "is") else {
      return false
    }
    return ["URLError", "Foundation.URLError"].contains(pattern.dropFirst(cast + 1).joined())
  }

  var cancelledCatch: Bool {
    handler.catchItems.count == 1
      && handler.catchItems.first?.whereClause.map { proves($0.condition, value: true) } == true
  }

  func swallowsCancellation() -> Bool {
    let visitor = Returns(paths: self)
    visitor.walk(handler.body)
    return visitor.found
  }

  private func proves(_ conditions: ConditionElementListSyntax, value: Bool) -> Bool {
    let checks = conditions.map {
      $0.condition.as(ExprSyntax.self).map { proves($0, value: value) } ?? false
    }
    return value ? checks.contains(true) : !checks.isEmpty && checks.allSatisfy { $0 }
  }

  private func proves(_ expression: ExprSyntax, value: Bool, depth: Int = 0) -> Bool {
    guard depth < 16 else { return false }
    if let prefix = expression.as(PrefixOperatorExprSyntax.self), prefix.operator.text == "!" {
      return proves(prefix.expression, value: !value, depth: depth)
    }
    if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
      let first = tuple.elements.first, first.label == nil
    {
      return proves(first.expression, value: value, depth: depth)
    }
    let parts = expression.as(SequenceExprSyntax.self).map { Array($0.elements) } ?? [expression]
    return proves(parts, value: value, depth: depth)
  }

  private func proves(_ parts: [ExprSyntax], value: Bool, depth: Int = 0) -> Bool {
    guard depth < 16 else { return false }
    for operation in ["||", "&&"] {
      if parts.contains(where: { $0.as(BinaryOperatorExprSyntax.self)?.operator.text == operation })
      {
        let segments = parts.split {
          $0.as(BinaryOperatorExprSyntax.self)?.operator.text == operation
        }
        let constant = operation == "||"
        if segments.contains(where: { literal(Array($0), depth: depth) == constant }) {
          return false
        }
        let remaining = segments.filter { literal(Array($0), depth: depth) == nil }
        guard !remaining.isEmpty else { return false }
        let checks = remaining.map { proves(Array($0), value: value, depth: depth) }
        return (operation == "||") == value ? checks.allSatisfy { $0 } : checks.contains(true)
      }
    }
    if parts.count == 1, let first = parts.first,
      first.is(PrefixOperatorExprSyntax.self) || first.is(TupleExprSyntax.self)
    {
      return proves(first, value: value, depth: depth)
    }
    if parts.count == 1, let first = parts.first,
      let reference = first.as(DeclReferenceExprSyntax.self),
      let source = alias(reference.baseName.text, at: first)
    {
      return proves(source, value: value, depth: depth + 1)
    }
    if parts.count == 3, let operation = parts[1].as(BinaryOperatorExprSyntax.self)?.operator.text,
      ["==", "!="].contains(operation)
    {
      for index in [0, 2] {
        if let constant = parts[index].as(BooleanLiteralExprSyntax.self) {
          let same = (constant.literal.text == "true") == (operation == "==")
          return proves(parts[2 - index], value: value == same, depth: depth)
        }
      }
      let left = parts[0].tokens(viewMode: .sourceAccurate).map(\.text).joined()
      let right = parts[2].tokens(viewMode: .sourceAccurate).map(\.text).joined()
      if value == (operation == "=="),
        (urlCode(parts[0]) && cancelledCode(right)) || (urlCode(parts[2]) && cancelledCode(left))
      {
        return true
      }
    }
    guard value else { return false }
    let text = parts.flatMap { $0.tokens(viewMode: .sourceAccurate).map(\.text) }.joined()
    for task in ["Task", "Swift.Task", "_Concurrency.Task"] where text == task + ".isCancelled" {
      let root = String(task.prefix { $0 != "." })
      return !shadowed(root, at: parts.first, signalAlias: true)
    }
    for signal in signals where text == signal + ".isCancelled" {
      let root = String(signal.prefix { $0 != "." })
      return !shadowed(root, at: parts.first, signalAlias: true)
    }
    let tokens = parts.flatMap { $0.tokens(viewMode: .sourceAccurate).map(\.text) }
    guard tokens.count >= 3, tokens[1] == "is", let first = parts.first,
      cancellationTypes.contains(tokens.dropFirst(2).joined())
    else { return false }
    return originalError(tokens[0], at: first)
  }

  private let cancellationTypes: Set<String> = [
    "CancellationError", "_Concurrency.CancellationError", "Swift.CancellationError",
  ]

  private func literal(_ parts: [ExprSyntax], depth: Int = 0) -> Bool? {
    guard depth < 16 else { return nil }
    guard parts.count == 1, let first = parts.first else { return nil }
    if let value = first.as(BooleanLiteralExprSyntax.self) { return value.literal.text == "true" }
    if let prefix = first.as(PrefixOperatorExprSyntax.self), prefix.operator.text == "!" {
      return literal([prefix.expression], depth: depth).map { !$0 }
    }
    if let tuple = first.as(TupleExprSyntax.self), tuple.elements.count == 1,
      let element = tuple.elements.first
    {
      return literal([element.expression], depth: depth)
    }
    if let reference = first.as(DeclReferenceExprSyntax.self),
      let source = alias(reference.baseName.text, at: first)
    {
      return literal([source], depth: depth + 1)
    }
    return nil
  }

  private func urlCode(_ expression: ExprSyntax) -> Bool {
    let tokens = expression.tokens(viewMode: .sourceAccurate).map(\.text)
    guard let name = tokens.first == "(" ? tokens.dropFirst().first : tokens.first,
      originalError(name, at: expression)
    else { return false }
    let text = tokens.joined()
    if urlError && text == name + ".code" { return true }
    return ["URLError", "Foundation.URLError"].contains {
      text == "(" + name + "as?" + $0 + ")?.code"
    }
  }

  private func cancelledCode(_ text: String) -> Bool {
    [
      ".cancelled", "URLError.cancelled", "URLError.Code.cancelled",
      "Foundation.URLError.cancelled", "Foundation.URLError.Code.cancelled",
    ].contains(text)
  }

  func isOriginalError(_ expression: ExprSyntax) -> Bool {
    let value = unwrapped(expression)
    guard let reference = value.as(DeclReferenceExprSyntax.self) else { return false }
    return originalError(reference.baseName.text, at: value)
  }

  private func originalError(_ name: String, at node: ExprSyntax, depth: Int = 0) -> Bool {
    guard depth < 16 else { return false }
    if name == binding, !shadowed(name, at: node) { return true }
    guard let source = alias(name, at: node) else { return false }
    let value = unwrapped(source)
    guard let reference = value.as(DeclReferenceExprSyntax.self) else { return false }
    return originalError(reference.baseName.text, at: value, depth: depth + 1)
  }

  private func unwrapped(_ expression: ExprSyntax) -> ExprSyntax {
    if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
      let element = tuple.elements.first, element.label == nil
    {
      return unwrapped(element.expression)
    }
    return expression
  }

  // Resolve each immutable snapshot at its initializer, before later shadowing.
  private func alias(_ name: String, at node: ExprSyntax) -> ExprSyntax? {
    for parent in ancestors(of: node) {
      if parent.id == handler.id { break }
      if let branch = parent.as(SwitchCaseSyntax.self),
        let label = branch.label.as(SwitchCaseLabelSyntax.self),
        label.caseItems.contains(where: { binds(Syntax($0.pattern), name: name) })
      {
        return nil
      }
      if let branch = parent.as(IfExprSyntax.self),
        node.position >= branch.body.position, node.endPosition <= branch.body.endPosition,
        binds(branch.conditions, name: name)
      {
        return nil
      }
      if let loop = parent.as(WhileStmtSyntax.self),
        node.position >= loop.body.position, binds(loop.conditions, name: name)
      {
        return nil
      }
      if let conditions = parent.as(ConditionElementListSyntax.self),
        conditions.contains(where: { $0.endPosition <= node.position && binds($0, name: name) })
      {
        return nil
      }
      if let loop = parent.as(ForStmtSyntax.self),
        node.position >= loop.body.position, binds(Syntax(loop.pattern), name: name)
      {
        return nil
      }
      guard let statements = parent.as(CodeBlockItemListSyntax.self) else { continue }
      for item in statements.reversed() where item.position < node.position {
        if let variable = item.item.as(VariableDeclSyntax.self) {
          for binding in variable.bindings.reversed()
          where binding.endPosition <= node.position && binds(Syntax(binding.pattern), name: name) {
            guard variable.bindingSpecifier.text == "let",
              binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name
            else { return nil }
            return binding.initializer?.value
          }
        }
        if let guardStatement = item.item.as(GuardStmtSyntax.self),
          item.endPosition <= node.position, binds(guardStatement.conditions, name: name)
        {
          return nil
        }
      }
    }
    return nil
  }

  private func cancellingCase(_ branch: SwitchCaseSyntax) -> Bool {
    guard let label = branch.label.as(SwitchCaseLabelSyntax.self),
      let selection = ancestors(of: branch).compactMap({ $0.as(SwitchExprSyntax.self) }).first,
      !label.caseItems.isEmpty
    else { return false }
    return label.caseItems.allSatisfy { item in
      if let condition = item.whereClause?.condition {
        if literal([condition]) == false { return false }
        if proves(condition, value: true) { return true }
      }
      let tokens = item.pattern.tokens(viewMode: .sourceAccurate).map(\.text)
      let text = tokens.joined()
      if isOriginalError(selection.subject) {
        if cancellationTypes.contains(where: { text == "is" + $0 }) { return true }
        if tokens.count >= 4, ["let", "var"].contains(tokens[0]), tokens[2] == "as",
          cancellationTypes.contains(tokens.dropFirst(3).joined())
        {
          return true
        }
      }
      if urlCode(selection.subject) {
        if cancelledCode(text) { return true }
        if text.hasPrefix(".some("), text.hasSuffix(")"),
          cancelledCode(String(text.dropFirst(".some(".count).dropLast()))
        {
          return true
        }
      }
      if ["true", "false"].contains(text) {
        return proves(selection.subject, value: text == "true")
      }
      return false
    }
  }

  private func binds(_ conditions: ConditionElementListSyntax, name: String) -> Bool {
    conditions.contains { binds($0, name: name) }
  }

  private func binds(_ condition: ConditionElementSyntax, name: String) -> Bool {
    let pattern =
      condition.condition.as(OptionalBindingConditionSyntax.self)?.pattern
      ?? condition.condition.as(MatchingPatternConditionSyntax.self)?.pattern
    return pattern.map { binds(Syntax($0), name: name) } ?? false
  }

  private func binds(_ node: Syntax, name: String) -> Bool {
    if let identifier = node.as(IdentifierPatternSyntax.self) {
      return identifier.identifier.text == name
    }
    return node.children(viewMode: .sourceAccurate).contains { binds($0, name: name) }
  }

  private func shadowed(_ name: String, at node: ExprSyntax?, signalAlias: Bool = false) -> Bool {
    guard let node else { return false }
    for parent in ancestors(of: node) {
      if !signalAlias && parent.id == handler.id { break }
      if signalAlias, let closure = parent.as(ClosureExprSyntax.self) {
        if closureCall(closure).map({ isGraphCall($0.0, names: graphCallbacks) }) == true {
          break
        }
        for capture in closure.signature?.capture?.items ?? [] where capture.name.text == name {
          if let source = capture.initializer?.value.trimmedDescription,
            source != name, !signals.contains(source)
          {
            return true
          }
        }
        if closureParameters(closure).contains(name) { return true }
      }
      if let branch = parent.as(SwitchCaseSyntax.self),
        let label = branch.label.as(SwitchCaseLabelSyntax.self),
        label.caseItems.contains(where: { binds(Syntax($0.pattern), name: name) })
      {
        return true
      }
      if let conditional = parent.as(IfExprSyntax.self),
        node.position >= conditional.body.position,
        node.endPosition <= conditional.body.endPosition,
        binds(conditional.conditions, name: name)
      {
        return true
      }
      if let loop = parent.as(WhileStmtSyntax.self),
        node.position >= loop.body.position, binds(loop.conditions, name: name)
      {
        return true
      }
      if let conditions = parent.as(ConditionElementListSyntax.self) {
        for item in conditions where item.endPosition <= node.position {
          if binds(item, name: name) { return true }
        }
      }
      if let loop = parent.as(ForStmtSyntax.self), node.position >= loop.body.position,
        binds(Syntax(loop.pattern), name: name)
      {
        return true
      }
      guard let statements = parent.as(CodeBlockItemListSyntax.self) else { continue }
      for item in statements where item.endPosition <= node.position {
        if let variable = item.item.as(VariableDeclSyntax.self),
          let binding = variable.bindings.first(where: {
            binds(Syntax($0.pattern), name: name)
          })
        {
          if signalAlias, variable.bindingSpecifier.text == "let",
            binding.initializer.map({ signals.contains($0.value.trimmedDescription) }) == true
          {
            return false
          }
          return true
        }
        if let guardStatement = item.item.as(GuardStmtSyntax.self),
          binds(guardStatement.conditions, name: name)
        {
          return true
        }
      }
    }
    return false
  }

  private final class Returns: SyntaxVisitor {
    let paths: ResourceCancellationPaths
    var found = false
    init(paths: ResourceCancellationPaths) {
      self.paths = paths
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: ReturnStmtSyntax) -> SyntaxVisitorContinueKind {
      // A throwing retry/recovery still owns its failure; optional try does not.
      if let expression = node.expression, propagatesFailure(Syntax(expression)) {
        return .skipChildren
      }
      var child = Syntax(node)
      for parent in ancestors(of: node) {
        if parent.id == paths.handler.id { break }
        if let conditional = parent.as(IfExprSyntax.self),
          paths.proves(conditional.conditions, value: child.id == conditional.body.id)
        {
          found = true
        }
        if let guardStatement = parent.as(GuardStmtSyntax.self),
          paths.proves(guardStatement.conditions, value: false)
        {
          found = true
        }
        if let branch = parent.as(SwitchCaseSyntax.self), paths.cancellingCase(branch) {
          found = true
        }
        if let statements = parent.as(CodeBlockItemListSyntax.self) {
          for item in statements where item.endPosition <= node.position {
            if let guardStatement = item.item.as(GuardStmtSyntax.self),
              paths.proves(guardStatement.conditions, value: true)
            {
              found = true
            }
          }
        }
        child = parent
      }
      found = found || paths.cancelledCatch
      return .skipChildren
    }

    private func propagatesFailure(_ node: Syntax) -> Bool {
      if node.is(ClosureExprSyntax.self) { return false }
      if let attempt = node.as(TryExprSyntax.self), attempt.questionOrExclamationMark == nil {
        return true
      }
      return node.children(viewMode: .sourceAccurate).contains { propagatesFailure($0) }
    }

    override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: CatchClauseSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: AccessorBlockSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  }
}
