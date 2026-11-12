import SwiftSyntax

enum NativeLifetimeValue: Int { case unknown, handle, collection, completion, completionCollection }

struct NativeLifetimeCleanup {
  let statements: CodeBlockItemListSyntax
  var captures: [String: NativeLifetimeValue] = [:]
}

struct NativeLifetimePath {
  enum Exit { case normal, returned, thrown, breakLoop, continueLoop }
  var values: [String: NativeLifetimeValue] = [:]
  var locals: Set<String> = []
  var immutable: Set<String> = []
  var acquired = false
  var released = false
  var transferred = false
  var exit = Exit.normal
  var deferred: [NativeLifetimeCleanup] = []
  var indexAliases: [String: NativeLifetimeIndex] = [:]
}

final class NativeLifetimeTrace {
  let kind: NativeLifetimeKind
  let creation: AbsolutePosition?
  let owner: NativeLifetimeOwner
  let slots: [NativeLifetimeSlot]
  var checking: Set<String> = []
  var calls: Set<AbsolutePosition> = []
  var teardown = false
  var reachedCreation = false
  var retained: [String: NativeLifetimeValue] = [:]
  var retainedSlots: [NativeLifetimeSlot] = []

  init(
    kind: NativeLifetimeKind, creation: AbsolutePosition?, owner: NativeLifetimeOwner,
    slot: NativeLifetimeSlot? = nil, slots: [NativeLifetimeSlot] = []
  ) {
    self.kind = kind
    self.creation = creation
    self.owner = owner
    self.slots = slots + (slot.map { [$0] } ?? [])
  }

  func finished(_ path: NativeLifetimePath) -> Bool {
    if !path.acquired || path.released || path.transferred { return true }
    return path.values.contains { name, value in
      if let slot = slots.first(where: { $0.storage == name }),
        [.handle, .completion].contains(value)
      {
        return ownerReleases(
          slot.field, value: value == .handle ? .collection : .completionCollection)
      }
      return name.hasPrefix("self.") && value != .unknown
        && ownerReleases(String(name.dropFirst(5)), value: value)
    }
  }

  func ownerReleases(_ name: String, value: NativeLifetimeValue) -> Bool {
    guard checking.insert(name).inserted else { return false }
    defer { checking.remove(name) }
    let previous = teardown
    teardown = true
    defer { teardown = previous }
    var entries: Set<String> = [
      "close", "stop", "cancel", "dismiss", "deactivate", "invalidate", "detach",
    ]
    if kind.isTask { entries = nativeTaskTeardown }
    let initial = NativeLifetimePath(values: ["self." + name: value], acquired: true)
    for function in owner.functions
    where entries.contains(function.name.text)
      && (kind.isTask || function.signature.parameterClause.parameters.isEmpty)
    {
      var entering = initial
      entering.locals = Set(
        function.signature.parameterClause.parameters.map {
          ($0.secondName ?? $0.firstName).text
        })
      entering.immutable = entering.locals
      if let body = function.body,
        block(body.statements, states: [entering]).allSatisfy(\.released)
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

  func block(_ statements: CodeBlockItemListSyntax, states: [NativeLifetimePath])
    -> [NativeLifetimePath]
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
      return paths.flatMap { path -> [NativeLifetimePath] in
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
              entering.immutable.insert(name)
            }
            return block(cleanup.statements, states: [entering]).map {
              var leaving = $0
              leaving.exit = exit
              for name in cleanup.captures.keys {
                leaving.values[name] = result.values[name]
                if !result.locals.contains(name) { leaving.locals.remove(name) }
                if !result.immutable.contains(name) { leaving.immutable.remove(name) }
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
            if initial.immutable.contains(name) {
              result.immutable.insert(name)
            } else {
              result.immutable.remove(name)
            }
          }
          return result
        }
      }
    }
  }

  func step(_ node: Syntax, path initial: NativeLifetimePath) -> [NativeLifetimePath] {
    var path = initial
    if let cleanup = node.as(DeferStmtSyntax.self) {
      path.deferred.append(NativeLifetimeCleanup(statements: cleanup.body.statements))
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
      let bindings = nativeLifetimeBindings(loop.pattern)
      iteration.locals.formUnion(bindings)
      iteration.immutable.formUnion(bindings)
      for name in bindings { iteration.values[name] = .unknown }
      if let name = loop.pattern.as(IdentifierPatternSyntax.self)?.identifier.text {
        iteration.locals.insert(name)
        iteration.immutable.insert(name)
        iteration.values[name] =
          sequence == .collection
          ? .handle
          : sequence == .completionCollection ? .completion : .unknown
      }
      let entering: [NativeLifetimePath]
      if let filter = loop.whereClause {
        var matching = iteration
        var skipped = iteration
        constrain(filter.condition, count: 1, initial: iteration, yes: &matching, no: &skipped)
        entering = [matching]
      } else {
        entering = [iteration]
      }
      let results = block(loop.body.statements, states: entering)
      if [.collection, .completionCollection].contains(sequence), loop.whereClause == nil,
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
          result.immutable = path.immutable
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
      return statement.cases.flatMap { entry -> [NativeLifetimePath] in
        guard let branch = entry.as(SwitchCaseSyntax.self) else { return [path] }
        return block(branch.statements, states: [path])
      }
    }
    if let statement = node.as(ReturnStmtSyntax.self) {
      if let expression = statement.expression {
        let returned = value(expression, path: &path)
        if !teardown, returned != .unknown { path.transferred = true }
        if kind.isTask, teardown, returned == .completion {
          // A returned cleanup Task transfers an explicit drain to its caller.
          path.released = true
        }
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
          if variable.bindingSpecifier.text == "let" {
            path.immutable.insert(name)
          } else {
            path.immutable.remove(name)
          }
          path.values[name] = source
        }
      }
    } else if let expression {
      _ = value(expression, path: &path)
    }
    let facts = NativeLifetimeSuspension()
    facts.walk(node)
    if teardown, !kind.isTask, facts.awaits, !initial.released {
      path.released = false
      path.exit = .returned
    }
    if initial.acquired, !initial.released, facts.throws {
      var failure = path
      if let parts = expression?.as(SequenceExprSyntax.self).map({ Array($0.elements) }),
        parts.count == 3, parts[1].is(AssignmentExprSyntax.self),
        let attempt = parts[2].as(TryExprSyntax.self),
        attempt.questionOrExclamationMark == nil,
        case .subscription = kind,
        let registration = attempt.expression.as(FunctionCallExprSyntax.self),
        let member = registration.calledExpression.as(MemberAccessExprSyntax.self),
        member.declName.baseName.text == "watch", let base = member.base,
        owner.isStore(base, at: registration),
        registration.arguments.allSatisfy({
          $0.expression.is(DeclReferenceExprSyntax.self)
            || $0.expression.is(MemberAccessExprSyntax.self)
        })
      {
        // Direct watch registration does not invoke its listener. On failure,
        // the assignment keeps the previous handle; arbitrary helpers may mutate it.
        failure = initial
      }
      failure.exit = .thrown
      return [path, failure]
    }
    return [path]
  }

  private func conditional(_ node: IfExprSyntax, path: NativeLifetimePath) -> [NativeLifetimePath] {
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
        if path.immutable.contains(name) {
          result.immutable.insert(name)
        } else {
          result.immutable.remove(name)
        }
      }
      return result
    }
  }

  private func conditions(
    _ conditions: ConditionElementListSyntax, path initial: NativeLifetimePath
  ) -> ([NativeLifetimePath], [NativeLifetimePath], Set<String>) {
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
        if binding.bindingSpecifier.text == "let" {
          yes.immutable.insert(name)
        } else {
          yes.immutable.remove(name)
        }
        bindings.insert(name)
        if conditions.count == 1, original != .unknown { no.released = true }
      } else if let expression = element.condition.as(ExprSyntax.self) {
        constrain(expression, count: conditions.count, initial: initial, yes: &yes, no: &no)
        if conditions.count == 1, let literal = expression.as(BooleanLiteralExprSyntax.self) {
          return literal.literal.text == "true" ? ([yes], [], bindings) : ([], [no], bindings)
        }
      }
    }
    return ([yes], [no], bindings)
  }

  private func constrain(
    _ expression: ExprSyntax, count: Int, initial: NativeLifetimePath,
    yes: inout NativeLifetimePath, no: inout NativeLifetimePath
  ) {
    _ = value(expression, path: &yes)
    if let member = expression.as(MemberAccessExprSyntax.self),
      member.declName.baseName.text == "isEmpty", let base = member.base,
      [.collection, .completionCollection].contains(value(base, path: &yes))
    {
      yes.released = true
    }
    if count == 1,
      let prefix = expression.as(PrefixOperatorExprSyntax.self), prefix.operator.text == "!",
      let member = prefix.expression.as(MemberAccessExprSyntax.self),
      member.declName.baseName.text == "isEmpty", let base = member.base,
      [.collection, .completionCollection].contains(value(base, path: &yes))
    {
      no.released = true
    }
    if let parts = expression.as(SequenceExprSyntax.self).map({ Array($0.elements) }),
      parts.count == 3,
      let operation = parts[1].as(BinaryOperatorExprSyntax.self)?.operator.text,
      ["==", "!="].contains(operation)
    {
      for index in [0, 2] where parts[2 - index].is(NilLiteralExprSyntax.self) {
        var evaluating = initial
        if value(parts[index], path: &evaluating) == .handle {
          if operation == "==" {
            yes.released = true
          } else if count == 1 {
            no.released = true
          }
        }
      }
    }
    if kind.isTask, teardown, count == 1,
      let prefix = expression.as(PrefixOperatorExprSyntax.self),
      prefix.operator.text == "!",
      let name = key(prefix.expression, path: initial),
      ["self.closed", "self.isClosed"].contains(name)
    {
      // An idempotent close may return when the owner has already closed.
      no.released = true
    }
  }
}

final class NativeLifetimeSuspension: SyntaxVisitor {
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
