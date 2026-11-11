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
      return array.elements.map { value($0.expression, path: &path) }.contains(.handle)
        ? .collection : .unknown
    }
    if let dictionary = expression.as(DictionaryExprSyntax.self),
      case .elements(let elements) = dictionary.content
    {
      return elements.map { value($0.value, path: &path) }.contains(.handle)
        ? .collection : .unknown
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
          parts[0].is(SubscriptCallExprSyntax.self) && source == .handle ? .collection : source
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
      return value(base, path: &path) == .collection ? .collection : .unknown
    }
    if !expression.is(SubscriptCallExprSyntax.self), let name = key(expression, path: path) {
      return path.values[name] ?? .unknown
    }
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
    if kind.isTask, callName(call.calledExpression) == "Array", arguments == [.collection] {
      return .collection
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
        arguments.contains(.handle), let base = member.base, let name = key(base, path: path)
      {
        path.values[name] = .collection
        retain(name, path: path)
      }
      if member.declName.baseName.text == "removeAll", let base = member.base,
        let name = key(base, path: path)
      {
        path.values[name] = .unknown
      }
      if member.declName.baseName.text == "forEach", receiver == .collection,
        let closure = call.trailingClosure
      {
        var element = path
        let name = closureParameters(closure).first ?? "$0"
        element.locals.insert(name)
        element.values[name] = .handle
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
        results += block(body.statements, states: [entering])
      }
      calls.remove(function.position)
    }
    guard !results.isEmpty else { return }
    path.released = results.allSatisfy { result in
      if result.released { return true }
      guard kind.isTask else { return false }
      // A helper may move the original into a distinct owner-held drain collection.
      return result.values.contains { name, value in
        name.hasPrefix("self.") && value != .unknown
          && path.values[name, default: .unknown] == .unknown
          && ownerReleases(String(name.dropFirst(5)), value: value)
      }
    }
    for field in owner.fields {
      let name = "self." + field
      let values = results.map { $0.values[name] ?? .unknown }
      path.values[name] = values.allSatisfy { $0 == values.first } ? values.first : .unknown
    }
  }

  private func retain(_ name: String, path: NativeLifetimePath) {
    if kind.isTask, name.hasPrefix("self."), let value = path.values[name], value != .unknown {
      retained[String(name.dropFirst(5))] = value
    }
  }
}
