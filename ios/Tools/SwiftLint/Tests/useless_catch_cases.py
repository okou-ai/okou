"""A catch must do more than rethrow the error it just bound."""

USELESS_CATCH_CASES = [
    (
        "sole unfiltered catches cannot only rethrow their original errors",
        "okou_useless_catch",
        """
        func read() async throws {
          do { try await service.load() }
          catch { throw error } // violation
          do { try await service.load() }
          catch let failure { throw failure } // violation
          do { try await service.load() }
          catch var failure { throw failure } // violation
          do { try await service.load() }
          catch { throw ((error)) } // violation
        }
    """,
    ),
    (
        "comments and a scoped do body do not give a bare catch an effect",
        "okou_useless_catch",
        """
        func read() throws {
          do {
            let handle = try service.open()
            defer { handle.close() }
            try handle.read()
          } catch { // violation
            // The do scope still owns the handle and its defer.
            throw error
          }
          owner.finished()
        }
    """,
    ),
    (
        "cleanup recovery reporting and error conversion remain meaningful",
        "okou_useless_catch",
        """
        func read() async throws -> [String] {
          do { return try await service.load() }
          catch {
            owner.release()
            throw error
          }
        }
        func recover() async throws -> [String] {
          do { return try await service.load() }
          catch { return try await owner.recover(error) }
        }
        func convert() async throws {
          do { try await service.load() }
          catch { throw Failure.unavailable(error) }
        }
        func report() async throws {
          do { try await service.load() }
          catch {
            owner.report(error)
            throw error
          }
        }
        func deferCleanup() async throws {
          do { try await service.load() }
          catch {
            defer { owner.release() }
            throw error
          }
        }
    """,
    ),
    (
        "typed filtered and alternative catches retain their selection contract",
        "okou_useless_catch",
        """
        func read() async throws {
          let error = Failure.offline
          do { try await service.load() }
          catch is CancellationError { throw error }
          do { try await service.load() }
          catch let failure as OfflineError { throw failure }
          do { try await service.load() }
          catch where error is CancellationError { throw error }
          do { try await service.load() }
          catch let failure where owner.mustRethrow(failure) { throw failure }
          do { try await service.load() }
          catch Failure.offline, Failure.busy { throw error }
          do { try await service.load() }
          catch is CancellationError { throw error }
          catch { owner.recover(error) }
        }
    """,
    ),
    (
        "a different error value or nested execution is not a direct rethrow",
        "okou_useless_catch",
        """
        func read() async throws {
          let error = Failure.offline
          do { try await service.load() }
          catch let failure { throw owner.cachedFailure }
          do { try await service.load() }
          catch let failure { throw error }
          do { try await service.load() }
          catch { throw (error as any Error) }
          do { try await service.load() }
          catch {
            let error = Failure.offline
            throw error
          }
          do { try await service.load() }
          catch { owner.install { throw error } }
          do { try await service.load() }
          catch { do { throw error } }
        }
    """,
    ),
    (
        "nested catches are checked independently under their own bindings",
        "okou_useless_catch",
        """
        func read() async throws {
          do {
            do { try await service.load() }
            catch is OfflineError { owner.useCache() }
            catch { throw error }
          } catch let original { throw original } // violation
          do {
            do { try await service.load() }
            catch { throw error } // violation
          } catch { owner.report(error) }
        }
    """,
    ),
]
