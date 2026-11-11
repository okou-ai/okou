import SwiftSyntax

enum SubscriptionValue: Int { case unknown, handle, collection }

struct SubscriptionCleanup {
  let statements: CodeBlockItemListSyntax
  var captures: [String: SubscriptionValue] = [:]
}

struct SubscriptionPath {
  enum Exit { case normal, returned, thrown, breakLoop, continueLoop }
  var values: [String: SubscriptionValue] = [:]
  var locals: Set<String> = []
  var acquired = false
  var released = false
  var transferred = false
  var exit = Exit.normal
  var deferred: [SubscriptionCleanup] = []
}

final class SubscriptionTrace {
  let kind: SubscriptionKind
  let creation: AbsolutePosition
  let owner: SubscriptionOwner
  var checking: Set<String> = []
  var calls: Set<AbsolutePosition> = []
  var teardown = false
  var reachedCreation = false

  init(kind: SubscriptionKind, creation: AbsolutePosition, owner: SubscriptionOwner) {
    self.kind = kind
    self.creation = creation
    self.owner = owner
  }

  func finished(_ path: SubscriptionPath) -> Bool {
    if !path.acquired || path.released || path.transferred { return true }
    return path.values.contains { name, value in
      name.hasPrefix("self.") && value != .unknown
        && ownerReleases(String(name.dropFirst(5)), value: value)
    }
  }

  func ownerReleases(_ name: String, value: SubscriptionValue) -> Bool {
    guard checking.insert(name).inserted else { return false }
    defer { checking.remove(name) }
    let previous = teardown
    teardown = true
    defer { teardown = previous }
    let entries: Set<String> = [
      "close", "stop", "cancel", "dismiss", "deactivate", "invalidate", "detach",
    ]
    let initial = SubscriptionPath(values: ["self." + name: value], acquired: true)
    for function in owner.functions
    where entries.contains(function.name.text)
      && function.signature.parameterClause.parameters.isEmpty
    {
      if let body = function.body,
        block(body.statements, states: [initial]).allSatisfy(\.released)
      {
        return true
      }
    }
    // A native control's actual destruction is a lifetime boundary, unlike a retained
    // business owner that must close before navigation or identity replacement.
    if owner.nativeLifetime {
      for member in owner.syntax?.members ?? [] {
        if let destructor = member.decl.as(DeinitializerDeclSyntax.self),
          let body = destructor.body,
          block(body.statements, states: [initial]).allSatisfy(\.released)
        {
          return true
        }
      }
    }
    return false
  }

  func block(_ statements: CodeBlockItemListSyntax, states: [SubscriptionPath])
    -> [SubscriptionPath]
  {
    states.flatMap { initial in
      var paths = [initial]
      var declarations: Set<String> = []
      for statement in statements {
        if let variable = statement.item.as(VariableDeclSyntax.self) {
          declarations.formUnion(
            variable.bindings.compactMap {
              $0.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
            })
        }
        paths = paths.flatMap { path in
          path.exit == .normal ? step(Syntax(statement.item), path: path) : [path]
        }
      }
      return paths.flatMap { path -> [SubscriptionPath] in
        var results = [path]
        let pending = path.deferred.dropFirst(initial.deferred.count)
        for cleanup in pending.reversed() {
          results = results.flatMap { result in
            var entering = result
            let exit = entering.exit
            entering.exit = .normal
            entering.deferred = Array(entering.deferred.prefix(initial.deferred.count))
            for (name, value) in cleanup.captures {
              entering.values[name] = value
              entering.locals.insert(name)
            }
            return block(cleanup.statements, states: [entering]).map {
              var leaving = $0
              leaving.exit = exit
              for name in cleanup.captures.keys {
                leaving.values[name] = result.values[name]
                if !result.locals.contains(name) { leaving.locals.remove(name) }
              }
              return leaving
            }
          }
        }
        return results.map {
          var result = $0
          result.deferred = initial.deferred
          for name in declarations {
            result.values[name] = initial.values[name]
            if !initial.locals.contains(name) { result.locals.remove(name) }
          }
          return result
        }
      }
    }
  }

  private func step(_ node: Syntax, path initial: SubscriptionPath) -> [SubscriptionPath] {
    var path = initial
    if let cleanup = node.as(DeferStmtSyntax.self) {
      path.deferred.append(SubscriptionCleanup(statements: cleanup.body.statements))
      return [path]
    }
    let expression = node.as(ExpressionStmtSyntax.self)?.expression ?? node.as(ExprSyntax.self)
    if let branch = expression?.as(IfExprSyntax.self) {
      return conditional(branch, path: path)
    }
    if let statement = node.as(GuardStmtSyntax.self) {
      let (yes, no, _) = conditions(statement.conditions, path: path)
      return yes + no.flatMap { block(statement.body.statements, states: [$0]) }
    }
    if let statement = node.as(DoStmtSyntax.self) {
      return block(statement.body.statements, states: [path]).flatMap { result in
        guard result.exit == .thrown, !statement.catchClauses.isEmpty else { return [result] }
        var failures = statement.catchClauses.flatMap { handler in
          var failure = result
          failure.exit = .normal
          for item in handler.catchItems {
            if let binding = item.pattern?.as(ValueBindingPatternSyntax.self),
              let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
            {
              failure.locals.insert(name)
              failure.values[name] = .unknown
            }
          }
          return block(handler.body.statements, states: [failure])
        }
        if !statement.catchClauses.contains(where: { $0.catchItems.isEmpty }) {
          failures.append(result)
        }
        return failures
      }
    }
    if let loop = node.as(ForStmtSyntax.self) {
      let sequence = value(loop.sequence, path: &path)
      var iteration = path
      if let name = loop.pattern.as(IdentifierPatternSyntax.self)?.identifier.text {
        iteration.locals.insert(name)
        iteration.values[name] = sequence == .collection ? .handle : .unknown
      }
      let results = block(loop.body.statements, states: [iteration])
      if sequence == .collection, loop.whereClause == nil,
        results.allSatisfy({ $0.released && ($0.exit == .normal || $0.exit == .continueLoop) })
      {
        path.released = true
      }
      // Unknown iteration cannot establish unconditional cleanup.
      return [path]
        + results.map { result in
          var result = result
          if result.exit == .breakLoop || result.exit == .continueLoop { result.exit = .normal }
          result.values = path.values.merging(result.values.filter { $0.key.hasPrefix("self.") }) {
            _, new in new
          }
          result.locals = path.locals
          return result
        }
    }
    if let loop = node.as(WhileStmtSyntax.self) {
      let (yes, no, _) = conditions(loop.conditions, path: path)
      return no
        + block(loop.body.statements, states: yes).map {
          var result = $0
          if result.exit == .breakLoop || result.exit == .continueLoop { result.exit = .normal }
          return result
        }
    }
    if let loop = node.as(RepeatStmtSyntax.self) {
      return block(loop.body.statements, states: [path]).map {
        var result = $0
        if result.exit == .breakLoop || result.exit == .continueLoop { result.exit = .normal }
        if result.exit == .normal { _ = value(loop.condition, path: &result) }
        return result
      }
    }
    if let statement = expression?.as(SwitchExprSyntax.self) {
      _ = value(statement.subject, path: &path)
      return statement.cases.flatMap { entry -> [SubscriptionPath] in
        guard let branch = entry.as(SwitchCaseSyntax.self) else { return [path] }
        return block(branch.statements, states: [path])
      }
    }
    if let statement = node.as(ReturnStmtSyntax.self) {
      if let expression = statement.expression, value(expression, path: &path) != .unknown,
        !teardown
      {
        path.transferred = true
      }
      path.exit = .returned
      return [path]
    }
    if node.is(ThrowStmtSyntax.self) {
      path.exit = .thrown
      return [path]
    }
    if node.is(BreakStmtSyntax.self) || node.is(ContinueStmtSyntax.self) {
      path.exit = node.is(BreakStmtSyntax.self) ? .breakLoop : .continueLoop
      return [path]
    }
    if let function = node.as(FunctionDeclSyntax.self) {
      path.locals.insert(function.name.text)
      return [path]
    }
    if let variable = node.as(VariableDeclSyntax.self) {
      for binding in variable.bindings {
        let source = binding.initializer.map { value($0.value, path: &path) } ?? .unknown
        if let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text {
          path.locals.insert(name)
          path.values[name] = source
        }
      }
    } else if let expression {
      _ = value(expression, path: &path)
    }
    let facts = SubscriptionSuspension()
    facts.walk(node)
    if teardown, facts.awaits, !initial.released {
      path.released = false
      path.exit = .returned
    }
    if initial.acquired, !initial.released, facts.throws {
      var failure = path
      failure.exit = .thrown
      return [path, failure]
    }
    return [path]
  }

  private func conditional(_ node: IfExprSyntax, path: SubscriptionPath) -> [SubscriptionPath] {
    let (yes, no, bindings) = conditions(node.conditions, path: path)
    var results = block(node.body.statements, states: yes)
    if let body = node.elseBody?.as(CodeBlockSyntax.self) {
      results += block(body.statements, states: no)
    } else if let nested = node.elseBody?.as(IfExprSyntax.self) {
      results += no.flatMap { conditional(nested, path: $0) }
    } else {
      results += no
    }
    return results.map {
      var result = $0
      for name in bindings {
        result.values[name] = path.values[name]
        if !path.locals.contains(name) { result.locals.remove(name) }
      }
      return result
    }
  }

  private func conditions(
    _ conditions: ConditionElementListSyntax, path initial: SubscriptionPath
  ) -> ([SubscriptionPath], [SubscriptionPath], Set<String>) {
    var yes = initial
    var no = initial
    var bindings: Set<String> = []
    for element in conditions {
      if let binding = element.condition.as(OptionalBindingConditionSyntax.self),
        let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
      {
        let source =
          binding.initializer?.value
          ?? ExprSyntax(DeclReferenceExprSyntax(baseName: .identifier(name)))
        let original = value(source, path: &yes)
        yes.values[name] = original
        yes.locals.insert(name)
        bindings.insert(name)
        if conditions.count == 1, original != .unknown { no.released = true }
      } else if let expression = element.condition.as(ExprSyntax.self) {
        _ = value(expression, path: &yes)
        if conditions.count == 1, let literal = expression.as(BooleanLiteralExprSyntax.self) {
          return literal.literal.text == "true" ? ([yes], [], bindings) : ([], [no], bindings)
        }
      }
    }
    return ([yes], [no], bindings)
  }
}

final class SubscriptionSuspension: SyntaxVisitor {
  var awaits = false
  var `throws` = false
  init() { super.init(viewMode: .sourceAccurate) }
  override func visit(_ node: ClosureExprSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind { .skipChildren }
  override func visit(_ node: AwaitExprSyntax) -> SyntaxVisitorContinueKind {
    awaits = true
    return .visitChildren
  }
  override func visit(_ node: TryExprSyntax) -> SyntaxVisitorContinueKind {
    if node.questionOrExclamationMark == nil { self.throws = true }
    return .visitChildren
  }
}
