import SwiftSyntax

extension NativeLifetimeTrace {
  func key(_ expression: ExprSyntax, path: NativeLifetimePath) -> String? {
    if let optional = expression.as(OptionalChainingExprSyntax.self) {
      return key(optional.expression, path: path)
    }
    if let forced = expression.as(ForceUnwrapExprSyntax.self) {
      return key(forced.expression, path: path)
    }
    if let reference = expression.as(DeclReferenceExprSyntax.self) {
      let name = reference.baseName.text
      return !path.locals.contains(name) && owner.fields.contains(name) ? "self." + name : name
    }
    if let member = expression.as(MemberAccessExprSyntax.self),
      member.base?.trimmedDescription == "self"
    {
      return "self." + member.declName.baseName.text
    }
    if let subscriptCall = expression.as(SubscriptCallExprSyntax.self) {
      let candidates = slots.filter {
        key(subscriptCall.calledExpression, path: path) == "self." + $0.field
      }
      if !candidates.isEmpty {
        guard subscriptCall.arguments.count == 1, let argument = subscriptCall.arguments.first
        else { return nil }
        let index = NativeLifetimeIndex.resolve(argument.expression, aliases: path.indexAliases)
        return candidates.first { $0.index.identity == index.identity }?.storage
      }
      return key(subscriptCall.calledExpression, path: path)
    }
    return nil
  }

  func value(_ expression: ExprSyntax, path: inout NativeLifetimePath) -> NativeLifetimeValue {
    if expression.position == creation, expression.is(FunctionCallExprSyntax.self) {
      reachedCreation = true
      path.acquired = true
      return .handle
    }
    if let attempt = expression.as(TryExprSyntax.self) {
      return value(attempt.expression, path: &path)
    }
    if let suspension = expression.as(AwaitExprSyntax.self) {
      if kind.isTask, let member = suspension.expression.as(MemberAccessExprSyntax.self),
        ["value", "result"].contains(member.declName.baseName.text), let base = member.base,
        [.handle, .completion].contains(value(base, path: &path))
      {
        path.released = true
        return .unknown
      }
      return value(suspension.expression, path: &path)
    }
    if let optional = expression.as(OptionalChainingExprSyntax.self) {
      return value(optional.expression, path: &path)
    }
    if let forced = expression.as(ForceUnwrapExprSyntax.self) {
      return value(forced.expression, path: &path)
    }
    if let array = expression.as(ArrayExprSyntax.self) {
      return collection(array.elements.map { value($0.expression, path: &path) })
    }
    if let dictionary = expression.as(DictionaryExprSyntax.self),
      case .elements(let elements) = dictionary.content
    {
      return collection(elements.map { value($0.value, path: &path) })
    }
    if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
      let element = tuple.elements.first
    {
      return value(element.expression, path: &path)
    }
    if let sequence = expression.as(SequenceExprSyntax.self) {
      let parts = Array(sequence.elements)
      if parts.count == 3, parts[1].is(AssignmentExprSyntax.self),
        let target = key(parts[0], path: path)
      {
        let source = value(parts[2], path: &path)
        path.values[target] =
          parts[0].is(SubscriptCallExprSyntax.self)
            && !slots.contains(where: { $0.storage == target })
            && [.handle, .completion].contains(source)
          ? collection([source]) : source
        for slot in slots where target == "self." + slot.field {
          path.values[slot.storage] = .unknown
        }
        if slots.isEmpty, !teardown, source == .handle, target.hasPrefix("self."),
          let subscriptCall = parts[0].as(SubscriptCallExprSyntax.self),
          subscriptCall.arguments.count == 1, let index = subscriptCall.arguments.first?.expression
        {
          retainedSlots.append(
            NativeLifetimeSlot(
              field: String(target.dropFirst(5)),
              index: NativeLifetimeIndex.resolve(index, aliases: path.indexAliases),
              syntax: subscriptCall))
        }
        retain(target, path: path)
        return .unknown
      }
      for part in parts { _ = value(part, path: &path) }
      return .unknown
    }
    if let call = expression.as(FunctionCallExprSyntax.self) {
      return invocation(call, path: &path)
    }
    if let member = expression.as(MemberAccessExprSyntax.self),
      member.declName.baseName.text == "values", let base = member.base
    {
      let stored = value(base, path: &path)
      return [.collection, .completionCollection].contains(stored) ? stored : .unknown
    }
    if !expression.is(SubscriptCallExprSyntax.self) || !slots.isEmpty,
      let name = key(expression, path: path)
    {
      let elements = slots.filter { name == "self." + $0.field }
        .map { path.values[$0.storage] ?? .unknown }
      let stored = collection(elements)
      if stored != .unknown { return stored }
      return path.values[name] ?? .unknown
    }
    return .unknown
  }

  private func collection(_ values: [NativeLifetimeValue]) -> NativeLifetimeValue {
    if values.contains(.handle) { return .collection }
    if values.contains(.completion) { return .completionCollection }
    return .unknown
  }

  private func invocation(
    _ call: FunctionCallExprSyntax, path: inout NativeLifetimePath
  ) -> NativeLifetimeValue {
    let member = call.calledExpression.as(MemberAccessExprSyntax.self)
    let receiver = member?.base.map { value($0, path: &path) } ?? .unknown
    let arguments = call.arguments.map { value($0.expression, path: &path) }
    if kind.isTask, nativeTaskCall(call), let closure = nativeTaskBody(call) {
      var entering = path
      entering.exit = .normal
      entering.deferred = []
      // A Task reads mutable captures later. Only immutable local values and
      // explicit capture-list snapshots preserve the original at acquisition.
      entering.values = path.values.filter { path.immutable.contains($0.key) }
      for capture in closure.signature?.capture?.items ?? [] {
        let name = capture.name.text
        let source =
          capture.initializer?.value
          ?? ExprSyntax(DeclReferenceExprSyntax(baseName: .identifier(name)))
        entering.locals.insert(name)
        entering.immutable.insert(name)
        entering.values[name] = capture.specifier == nil ? value(source, path: &path) : .unknown
      }
      for name in closureParameters(closure) {
        entering.locals.insert(name)
        entering.immutable.remove(name)
        entering.values[name] = .unknown
      }
      let results = block(closure.statements, states: [entering])
      return !path.released && results.allSatisfy(\.released) ? .completion : .unknown
    }
    if kind.isTask, callName(call.calledExpression) == "Array", arguments.count == 1,
      let first = arguments.first, [.collection, .completionCollection].contains(first)
    {
      return first
    }
    if let member {
      switch kind {
      case .subscription, .task:
        if member.declName.baseName.text == "cancel", call.arguments.isEmpty, receiver == .handle {
          path.released = true
        }
      case .observer(let center):
        if member.declName.baseName.text == "removeObserver", arguments == [.handle],
          let base = member.base, owner.center(base, at: call) == center
        {
          path.released = true
        }
      }
      if ["append", "insert"].contains(member.declName.baseName.text),
        collection(arguments) != .unknown, let base = member.base, let name = key(base, path: path)
      {
        path.values[name] = collection(arguments)
        retain(name, path: path)
      }
      if member.declName.baseName.text == "removeAll", let base = member.base,
        let name = key(base, path: path)
      {
        path.values[name] = .unknown
        for slot in slots where name == "self." + slot.field {
          path.values[slot.storage] = .unknown
        }
      }
      if member.declName.baseName.text == "removeValue",
        call.arguments.count == 1, let argument = call.arguments.first,
        argument.label?.text == "forKey",
        let base = member.base,
        let slot = slots.first(where: {
          key(base, path: path) == "self." + $0.field
            && NativeLifetimeIndex.resolve(argument.expression, aliases: path.indexAliases).identity
              == $0.index.identity
        })
      {
        let original = path.values[slot.storage] ?? .unknown
        path.values[slot.storage] = .unknown
        return original
      }
      if member.declName.baseName.text == "forEach",
        [.collection, .completionCollection].contains(receiver),
        let closure = call.trailingClosure
      {
        var element = path
        let name = closureParameters(closure).first ?? "$0"
        element.locals.insert(name)
        element.values[name] = receiver == .collection ? .handle : .completion
        if block(closure.statements, states: [element]).allSatisfy(\.released) {
          path.released = true
        }
      }
    }
    if isTestTeardown(call, path: path) || isEvaluationCleanup(call),
      let closure = call.trailingClosure
        ?? call.arguments.last?.expression.as(ClosureExprSyntax.self)
    {
      var cleanup = NativeLifetimeCleanup(statements: closure.statements)
      for capture in closure.signature?.capture?.items ?? [] {
        let name = capture.name.text
        let source =
          capture.initializer?.value
          ?? ExprSyntax(DeclReferenceExprSyntax(baseName: .identifier(name)))
        cleanup.captures[name] =
          capture.specifier == nil
          ? value(source, path: &path) : .unknown
      }
      path.deferred.append(cleanup)
    }
    applyHelper(call, arguments: arguments, path: &path)
    return .unknown
  }

  private func isEvaluationCleanup(_ call: FunctionCallExprSyntax) -> Bool {
    guard let member = call.calledExpression.as(MemberAccessExprSyntax.self),
      member.declName.baseName.text == "onCancel", let receiver = member.base?.trimmedDescription
    else { return false }
    for ancestor in ancestors(of: call) {
      if let closure = ancestor.as(ClosureExprSyntax.self),
        let (parent, _) = closureCall(closure),
        isGraphCall(parent, names: ["Computed", "computedTask"])
      {
        let arguments = closureParameters(closure)
        guard arguments.count > 1 else { continue }
        let before = CodeBlockItemListSyntax(
          closure.statements.filter { $0.position < call.position })
        if nativeSignalAliases(before, signals: [arguments[1] + ".signal"]).contains(receiver) {
          return true
        }
      }
      if let function = ancestor.as(FunctionDeclSyntax.self) {
        return function.signature.parameterClause.parameters.contains {
          ["EvaluationSignal", "CCState.EvaluationSignal"].contains($0.type.trimmedDescription)
            && ($0.secondName ?? $0.firstName).text == receiver
        }
      }
    }
    return false
  }

  private func isTestTeardown(_ call: FunctionCallExprSyntax, path: NativeLifetimePath) -> Bool {
    guard callName(call.calledExpression) == "addTeardownBlock" else { return false }
    if let reference = call.calledExpression.as(DeclReferenceExprSyntax.self),
      path.locals.contains(reference.baseName.text)
    {
      return false
    }
    let base = call.calledExpression.as(MemberAccessExprSyntax.self)?.base?.trimmedDescription
    if base == nil || base == "self" {
      guard !owner.functions.contains(where: { $0.name.text == "addTeardownBlock" }) else {
        return false
      }
      return owner.syntax?.parent?.as(ClassDeclSyntax.self)?.inheritanceClause?.inheritedTypes
        .contains { ["XCTestCase", "XCTest.XCTestCase"].contains($0.type.trimmedDescription) }
        == true
    }
    for ancestor in ancestors(of: call) {
      let parameters =
        ancestor.as(FunctionDeclSyntax.self)?.signature.parameterClause.parameters
        ?? ancestor.as(InitializerDeclSyntax.self)?.signature.parameterClause.parameters
      if let parameter = parameters?.first(where: { ($0.secondName ?? $0.firstName).text == base })
      {
        return ["XCTestCase", "XCTest.XCTestCase"].contains(parameter.type.trimmedDescription)
      }
    }
    return false
  }

  private func applyHelper(
    _ call: FunctionCallExprSyntax, arguments: [NativeLifetimeValue], path: inout NativeLifetimePath
  ) {
    if let reference = call.calledExpression.as(DeclReferenceExprSyntax.self),
      path.locals.contains(reference.baseName.text)
    {
      return
    }
    let functions = owner.matching(call, allowAsync: kind.isTask)
    guard !functions.isEmpty else { return }
    var results: [NativeLifetimePath] = []
    for function in functions {
      guard calls.insert(function.position).inserted else { return }
      if let body = function.body {
        var entering = path
        entering.locals = []
        entering.immutable = []
        entering.values = path.values.filter { $0.key.hasPrefix("self.") }
        entering.deferred = []
        for (parameter, argument) in zip(function.signature.parameterClause.parameters, arguments) {
          let name = (parameter.secondName ?? parameter.firstName).text
          entering.locals.insert(name)
          entering.immutable.insert(name)
          entering.values[name] = argument
        }
        for (parameter, argument) in zip(
          function.signature.parameterClause.parameters, call.arguments)
        {
          entering.indexAliases["parameter:\(parameter.position)"] = NativeLifetimeIndex.resolve(
            argument.expression, aliases: path.indexAliases)
        }
        results += block(body.statements, states: [entering])
      }
      calls.remove(function.position)
    }
    guard !results.isEmpty else { return }
    path.released = results.allSatisfy { result in
      if result.released { return true }
      // A helper may move the original into a distinct owner-held cleanup collection.
      return result.values.contains { name, value in
        name.hasPrefix("self.") && value != .unknown
          && path.values[name, default: .unknown] == .unknown
          && ownerReleases(String(name.dropFirst(5)), value: value)
      }
    }
    let names = Set(owner.fields.map { "self." + $0 }).union(slots.map(\.storage))
    for name in names {
      let values = results.map { $0.values[name] ?? .unknown }
      path.values[name] = values.allSatisfy { $0 == values.first } ? values.first : .unknown
    }
  }

  private func retain(_ name: String, path: NativeLifetimePath) {
    if name.hasPrefix("self."), let value = path.values[name], value != .unknown {
      retained[String(name.dropFirst(5))] = value
    }
  }
}
