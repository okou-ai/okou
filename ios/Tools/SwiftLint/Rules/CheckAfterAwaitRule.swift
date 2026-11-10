import SwiftLintCore
import SwiftSyntax

struct CheckAfterAwaitRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_check_after_await", name: "Current owner after suspension",
    description: "Check cancellation or owner identity after await before publishing native state",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    guard hasCCState(file) else { return [] }
    let names = NameCollector(viewMode: .sourceAccurate)
    names.walk(file.syntaxTree)
    let visitor = Visitor(stores: names.stores)
    visitor.walk(file.syntaxTree)
    return findings(Array(Set(visitor.positions)), in: file)
  }

  private final class Visitor: SyntaxVisitor {
    let stores: Set<String>
    var positions: [AbsolutePosition] = []
    init(stores: Set<String>) {
      self.stores = stores
      super.init(viewMode: .sourceAccurate)
    }
    override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind {
      guard let (call, _) = closureCall(node),
        nativeTaskCall(call) || isGraphCall(call, names: graphCallbacks)
      else { return .visitChildren }
      var writers = stores
      var signals: Set<String> = []
      for closure in [node] + ancestors(of: node).compactMap({ $0.as(ClosureExprSyntax.self) }) {
        if let (call, _) = closureCall(closure),
          isGraphCall(call, names: ["Computed", "computedTask"])
        {
          signals.formUnion(nativeSignalNames(closure))
        }
        if let (call, _) = closureCall(closure),
          isGraphCall(call, names: ["Command", "asyncCommand"]),
          let context = closureParameters(closure).first, context != "_"
        {
          writers.insert(context)
        }
      }
      for function in ancestors(of: node).compactMap({ $0.as(FunctionDeclSyntax.self) }) {
        for parameter in function.signature.parameterClause.parameters
        where ["EvaluationSignal", "CCState.EvaluationSignal"].contains(
          parameter.type.trimmedDescription)
        { signals.insert((parameter.secondName ?? parameter.firstName).text) }
      }
      let owner = nativeOwner(node)
      let properties = nativeProperties(owner)
      let analysis = PublicationAnalysis(
        properties: properties, writers: writers, signals: signals,
        helpers: nativeCheckHelpers(owner, properties: properties))
      _ = analysis.block(node.statements, flow: .init(), locals: Set(closureParameters(node)))
      positions.append(contentsOf: analysis.positions)
      return .visitChildren
    }
  }
}

private final class PublicationAnalysis {
  struct Flow {
    var suspended = false
    var reachable = true
  }
  let properties: Set<String>
  let writers: Set<String>
  let signals: Set<String>
  let helpers: Set<String>
  var positions: [AbsolutePosition] = []
  init(properties: Set<String>, writers: Set<String>, signals: Set<String>, helpers: Set<String>) {
    self.properties = properties
    self.writers = writers
    self.signals = signals
    self.helpers = helpers
  }

  func block(
    _ statements: CodeBlockItemListSyntax, flow initial: Flow, locals initialNames: Set<String>
  )
    -> Flow
  {
    var flow = initial
    var locals = initialNames
    for item in statements where flow.reachable {
      if let variable = item.item.as(VariableDeclSyntax.self) {
        for binding in variable.bindings {
          if let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text {
            locals.insert(name)
          }
        }
      }
      if let function = item.item.as(FunctionDeclSyntax.self) {
        locals.insert(function.name.text)
        continue
      }
      if item.item.is(DeferStmtSyntax.self) { continue }
      let expression = item.item.as(ExpressionStmtSyntax.self)?.expression
      if let guardStatement = item.item.as(GuardStmtSyntax.self) {
        inspect(guardStatement.conditions, flow: &flow, locals: locals)
        _ = block(guardStatement.body.statements, flow: flow, locals: locals)
        if nativeCondition(
          guardStatement.conditions, properties: properties, locals: locals, signals: signals)
          > 0
        {
          flow.suspended = false
        }
      } else if let condition = expression?.as(IfExprSyntax.self) ?? item.item.as(IfExprSyntax.self)
      {
        flow = conditional(condition, flow: flow, locals: locals)
      } else if let statement = item.item.as(DoStmtSyntax.self) {
        let body = block(statement.body.statements, flow: flow, locals: locals)
        let facts = CancellationFacts()
        facts.walk(statement.body)
        var paths = [body]
        for handler in statement.catchClauses {
          var failure = flow
          failure.suspended = failure.suspended || facts.awaits
          paths.append(block(handler.body.statements, flow: failure, locals: locals))
        }
        flow = merge(paths)
      } else if let loop = item.item.as(ForStmtSyntax.self) {
        inspect(loop.sequence, flow: &flow, locals: locals)
        var iteration = flow
        iteration.suspended = iteration.suspended || loop.awaitKeyword != nil
        var names = locals
        if let name = loop.pattern.as(IdentifierPatternSyntax.self)?.identifier.text {
          names.insert(name)
        }
        let body = block(loop.body.statements, flow: iteration, locals: names)
        flow = merge([flow, body])
      } else if let loop = item.item.as(WhileStmtSyntax.self) {
        inspect(loop.conditions, flow: &flow, locals: locals)
        var iteration = flow
        if nativeCondition(
          loop.conditions, properties: properties, locals: locals, signals: signals) > 0
        {
          iteration.suspended = false
        }
        flow = merge([flow, block(loop.body.statements, flow: iteration, locals: locals)])
      } else if let expression = expression?.as(SwitchExprSyntax.self)
        ?? item.item.as(SwitchExprSyntax.self)
      {
        inspect(expression.subject, flow: &flow, locals: locals)
        var paths: [Flow] = []
        for entry in expression.cases {
          if let branch = entry.as(SwitchCaseSyntax.self) {
            paths.append(block(branch.statements, flow: flow, locals: locals))
          }
        }
        flow = merge(paths)
      } else {
        inspect(item.item, flow: &flow, locals: locals)
        if item.item.is(ReturnStmtSyntax.self) || item.item.is(ThrowStmtSyntax.self) {
          flow.reachable = false
        }
      }
    }
    return flow
  }

  private func conditional(_ node: IfExprSyntax, flow initial: Flow, locals: Set<String>) -> Flow {
    var flow = initial
    inspect(node.conditions, flow: &flow, locals: locals)
    let check = nativeCondition(
      node.conditions, properties: properties, locals: locals, signals: signals)
    var yes = flow
    var no = flow
    if check > 0 { yes.suspended = false }
    if check < 0 { no.suspended = false }
    yes = block(node.body.statements, flow: yes, locals: locals)
    if let body = node.elseBody?.as(CodeBlockSyntax.self) {
      no = block(body.statements, flow: no, locals: locals)
    } else if let branch = node.elseBody?.as(IfExprSyntax.self) {
      no = conditional(branch, flow: no, locals: locals)
    }
    return merge([yes, no])
  }

  private func merge(_ paths: [Flow]) -> Flow {
    let surviving = paths.filter(\.reachable)
    return Flow(suspended: surviving.contains { $0.suspended }, reachable: !surviving.isEmpty)
  }

  private func inspect(_ node: some SyntaxProtocol, flow: inout Flow, locals: Set<String>) {
    let events = Events(
      properties: properties, writers: writers, locals: locals, signals: signals,
      helpers: helpers.subtracting(locals))
    events.walk(node)
    for event in events.values {
      switch event {
      case .suspend: flow.suspended = true
      case .check: flow.suspended = false
      case .write(let position): if flow.suspended { positions.append(position) }
      }
    }
  }

  private final class Events: SyntaxVisitor {
    enum Event {
      case suspend, check
      case write(AbsolutePosition)
    }
    var values: [Event] = []
    let properties: Set<String>
    let writers: Set<String>
    let locals: Set<String>
    let signals: Set<String>
    let helpers: Set<String>
    init(
      properties: Set<String>, writers: Set<String>, locals: Set<String>, signals: Set<String>,
      helpers: Set<String>
    ) {
      self.properties = properties
      self.writers = writers
      self.locals = locals
      self.signals = signals
      self.helpers = helpers
      super.init(viewMode: .sourceAccurate)
    }
    override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visit(_ node: DeferStmtSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
    override func visitPost(_ node: AwaitExprSyntax) { values.append(.suspend) }
    override func visitPost(_ node: FunctionCallExprSyntax) {
      let member = node.calledExpression.as(MemberAccessExprSyntax.self)
      if helpers.contains(callName(node.calledExpression)),
        ["", "self"].contains(member?.base?.trimmedDescription ?? ""),
        checkedStatement(node)
      {
        values.append(.check)
      }
      guard let member else { return }
      if member.declName.baseName.text == "set", let base = member.base,
        writers.contains(rootName(base))
      {
        values.append(.write(node.positionAfterSkippingLeadingTrivia))
      }
      if member.declName.baseName.text == "checkCancellation", let base = member.base,
        (Set(["Task", "Swift.Task", "_Concurrency.Task"]).union(signals)).contains(
          base.trimmedDescription)
      {
        guard checkedStatement(node) else { return }
        values.append(.check)
      }
    }
    private func checkedStatement(_ node: FunctionCallExprSyntax) -> Bool {
      guard let attempt = node.parent?.as(TryExprSyntax.self),
        attempt.questionOrExclamationMark == nil
      else { return false }
      return attempt.parent?.is(CodeBlockItemSyntax.self) == true
        || attempt.parent?.as(ExpressionStmtSyntax.self)?.parent?.is(CodeBlockItemSyntax.self)
          == true
    }
    override func visitPost(_ node: SequenceExprSyntax) {
      guard let first = node.elements.first,
        node.elements.contains(where: {
          $0.is(AssignmentExprSyntax.self)
            || $0.as(BinaryOperatorExprSyntax.self).map {
              ["+=", "-=", "*=", "/=", "&+=", "&-="].contains($0.operator.text)
            } == true
        }),
        let name = property(first), properties.contains(name)
      else { return }
      values.append(.write(node.positionAfterSkippingLeadingTrivia))
    }
    private func property(_ expression: ExprSyntax) -> String? {
      if let name = expression.as(DeclReferenceExprSyntax.self),
        !locals.contains(name.baseName.text)
      {
        return name.baseName.text
      }
      if let member = expression.as(MemberAccessExprSyntax.self), let base = member.base {
        if base.trimmedDescription == "self" { return member.declName.baseName.text }
        return property(base)
      }
      return nil
    }
  }
}
