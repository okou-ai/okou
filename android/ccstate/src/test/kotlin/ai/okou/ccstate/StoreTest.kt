package ai.okou.ccstate

import java.util.concurrent.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** Public behavioral contracts translated from the pinned TS core tests. */
class StoreTest {
    @Test
    fun storesIsolateValuesAndComputedCaches() {
        val source = state(1)
        val target = computed { get, _ -> get.get(source) * 2 }
        Store().use { first ->
            Store().use { second ->
                first.set(source, 3)
                assertEquals(6, first.get(target))
                assertEquals(2, second.get(target))
            }
        }
    }

    @Test
    fun unobservedReadsAreLazyAndMemoized() {
        Store().use { store ->
            val source = state(0)
            var calls = 0
            val target = computed { get, _ ->
                calls++
                get.get(source)
            }
            assertEquals(0, calls)
            assertEquals(0, store.get(target))
            assertEquals(0, store.get(target))
            store.set(source, 1)
            assertEquals(1, calls)
            assertEquals(1, store.get(target))
            assertEquals(2, calls)
        }
    }

    @Test
    fun watchEstablishesDependenciesWithoutAnInitialNotification() {
        Store().use { store ->
            val source = state(0)
            val selected = computed { get, _ -> get.get(source) > 0 }
            val seen = mutableListOf<Boolean>()
            val watch = store.watch(selected) { seen.add(store.get(selected)) }
            assertTrue(seen.isEmpty())
            store.set(source, 1)
            store.set(source, 2)
            assertEquals(listOf(true), seen)
            watch.close()
            watch.close()
            store.set(source, 0)
            assertEquals(listOf(true), seen)
        }
    }

    @Test
    fun conditionalBranchesDetachAndReattach() {
        Store().use { store ->
            val branch = state(false)
            val old = state(1)
            val current = state(2)
            val target = computed { get, _ -> get.get(if (get.get(branch)) current else old) }
            val seen = mutableListOf<Int>()
            store
                .watch(target) { seen.add(store.get(target)) }
                .use {
                    store.set(branch, true)
                    store.set(old, 99)
                    store.set(current, 3)
                    store.set(branch, false)
                    assertEquals(listOf(2, 3, 99), seen)
                }
        }
    }

    @Test
    fun synchronousWritesHaveFreshReadsAndOneFinalNotification() {
        Store().use { store ->
            val source = state(0)
            val target = computed { get, _ -> get.get(source) * 2 }
            val seen = mutableListOf<Int>()
            store
                .watch(target) { seen.add(store.get(target)) }
                .use {
                    val action =
                        command<Unit, List<Int>> { context, _ ->
                            context.set(source, 1)
                            val first = context.get(target)
                            context.set(source, 2)
                            val second = context.get(target)
                            context.set(source, 3)
                            listOf(first, second)
                        }
                    assertEquals(listOf(2, 4), store.set(action, Unit))
                    assertEquals(listOf(6), seen)
                }
        }
    }

    @Test
    fun nestedCommandsShareTheInternalBoundary() {
        Store().use { store ->
            val source = state(0)
            val seen = mutableListOf<Int>()
            val child =
                command<Unit, Unit> { context, _ ->
                    context.set(source, 2)
                    context.set(source, 3)
                }
            store
                .watch(source) { seen.add(store.get(source)) }
                .use {
                    store.set(
                        command<Unit, Unit> { context, _ ->
                            context.set(source, 1)
                            context.set(child, Unit)
                            context.set(source, 4)
                        },
                        Unit,
                    )
                    assertEquals(listOf(4), seen)
                }
        }
    }

    @Test
    fun aNestedPublicSetFlushesOutstandingSources() {
        Store().use { store ->
            val first = state(0)
            val second = state(0)
            val target = computed { get, _ -> get.get(first) + get.get(second) }
            val seen = mutableListOf<Int>()
            store
                .watch(target) { seen.add(store.get(target)) }
                .use {
                    store.set(
                        command<Unit, Unit> { context, _ ->
                            context.set(first, 1)
                            store.set(second, 1)
                            context.set(first, 2)
                        },
                        Unit,
                    )
                    assertEquals(listOf(2, 3), seen)
                }
        }
    }

    @Test
    fun nestedPublicSetWithTheSameSourceDoesNotPrematurelyFlush() {
        Store().use { store ->
            val source = state(0)
            val seen = mutableListOf<Int>()
            store
                .watch(source) { seen.add(store.get(source)) }
                .use {
                    store.set(
                        command<Unit, Unit> { context, _ ->
                            context.set(source, 1)
                            store.set(source, 2)
                        },
                        Unit,
                    )
                    assertEquals(listOf(2), seen)
                }
        }
    }

    @Test
    fun diamondObserversSeeOnlyConsistentFinalValues() {
        Store().use { store ->
            val source = state(1)
            val left = computed { get, _ -> get.get(source) * 2 }
            val right = computed { get, _ -> get.get(source) + 1 }
            val extra = computed { get, _ -> get.get(right) * 3 }
            val joined = computed { get, _ -> get.get(left) + get.get(extra) }
            val seen = mutableListOf<Int>()
            store
                .watch(joined) { seen.add(store.get(joined)) }
                .use {
                    store.set(source, 2)
                    assertEquals(listOf(13), seen)
                }
        }
    }

    @Test
    fun sameListenerIsDeduplicatedAndReentrantWritesRemainObservable() {
        Store().use { store ->
            val first = state(0)
            val second = state(0)
            val seen = mutableListOf<Pair<Int, Int>>()
            val listener = {
                seen.add(store.get(first) to store.get(second))
                Unit
            }
            store.watch(first, listener).use {
                store.watch(second, listener).use {
                    store.set(
                        command<Unit, Unit> { context, _ ->
                            context.set(first, 1)
                            context.set(second, 2)
                        },
                        Unit,
                    )
                    assertEquals(listOf(1 to 2), seen)
                }
            }
            store
                .watch(first) { if (store.get(first) == 2) store.set(first, 3) }
                .use {
                    store.set(first, 2)
                    assertEquals(3, store.get(first))
                }
        }
    }

    @Test
    fun distinctFunctionObjectsAreNotConflatedByKotlinEquality() {
        class Listener(val label: Int, val seen: MutableList<Int>) : () -> Unit {
            override fun invoke() {
                seen.add(label)
            }

            override fun equals(other: Any?): Boolean = other is Listener

            override fun hashCode(): Int = 0
        }
        Store().use { store ->
            val source = state(0)
            val seen = mutableListOf<Int>()
            val one = store.watch(source, Listener(1, seen))
            val two = store.watch(source, Listener(2, seen))
            store.set(source, 1)
            assertEquals(listOf(1, 2), seen)
            one.close()
            store.set(source, 2)
            assertEquals(listOf(1, 2, 2), seen)
            two.close()
        }
    }

    @Test
    fun throwsDoNotRollBackWritesOrSkipOtherListeners() {
        Store().use { store ->
            val source = state(0)
            val seen = mutableListOf<Int>()
            store
                .watch(source) { seen.add(store.get(source)) }
                .use {
                    val failure = IllegalStateException("write failed")
                    assertSame(
                        failure,
                        assertThrows(IllegalStateException::class.java) {
                            store.set(
                                command<Unit, Unit> { context, _ ->
                                    context.set(source, 1)
                                    context.set(source, 2)
                                    throw failure
                                },
                                Unit,
                            )
                        },
                    )
                    assertEquals(listOf(2), seen)
                    store
                        .watch(source) { throw failure }
                        .use {
                            var notified = false
                            store
                                .watch(source) { notified = true }
                                .use {
                                    val aggregate =
                                        assertThrows(ListenerException::class.java) {
                                            store.set(source, 3)
                                        }
                                    assertEquals(listOf(failure), aggregate.failures)
                                    assertTrue(notified)
                                    assertEquals(3, store.get(source))
                                }
                        }
                }
        }
    }

    @Test
    fun computedErrorsAreCachedByIdentityAndRecover() {
        Store().use { store ->
            val source = state(false)
            val failure = IllegalArgumentException("unavailable")
            var calls = 0
            val target = computed { get, _ ->
                calls++
                if (!get.get(source)) throw failure
                42
            }
            repeat(2) {
                assertSame(
                    failure,
                    assertThrows(IllegalArgumentException::class.java) { store.get(target) },
                )
            }
            assertEquals(1, calls)
            store.set(source, true)
            assertEquals(42, store.get(target))
        }
    }

    @Test
    fun referencePayloadsUseIdentityWhileScalarsUseStrictEquality() {
        data class Payload(val id: Int)
        Store().use { store ->
            val source = state(Payload(1))
            var notifications = 0
            store
                .watch(source) { notifications++ }
                .use {
                    val same = store.get(source)
                    store.set(source, same)
                    store.set(source, Payload(1))
                    assertEquals(1, notifications)
                }
            val number = state(0.0)
            var numericNotifications = 0
            store
                .watch(number) { numericNotifications++ }
                .use {
                    store.set(number, -0.0)
                    store.set(number, Double.NaN)
                    store.set(number, Double.NaN)
                    assertEquals(2, numericNotifications)
                }
        }
    }

    @Test
    fun nativeIntegerPrecisionIsPreservedWithoutDoubleCoercion() {
        Store().use { store ->
            val source = state(9_007_199_254_740_992L)
            val seen = mutableListOf<Long>()
            store
                .watch(source) { seen.add(store.get(source)) }
                .use {
                    store.set(source, 9_007_199_254_740_993L)
                    assertEquals(listOf(9_007_199_254_740_993L), seen)
                }
        }
    }

    @Test
    fun functionValuesAndUpdaterFunctionsAreUnambiguous() {
        Store().use { store ->
            val initial = { 1 }
            val next = { 2 }
            val source = state(initial)
            store.set(source, next)
            assertSame(next, store.get(source))
            store.update(source) { initial }
            assertSame(initial, store.get(source))
        }
    }

    @Test
    fun evaluationSignalsInvalidateOnReevaluationNotUnsubscribe() {
        Store().use { store ->
            val revision = state(0)
            val signals = mutableListOf<EvaluationSignal>()
            val target = computed { get, evaluation ->
                signals.add(evaluation.signal)
                assertSame(evaluation.signal, evaluation.signal)
                get.get(revision)
            }
            store.get(target)
            store.set(revision, 1)
            assertFalse(signals.single().aborted)
            store.get(target)
            assertTrue(signals.first().aborted)
            val watch = store.watch(target) {}
            store.set(revision, 2)
            assertTrue(signals[1].aborted)
            watch.close()
            assertFalse(signals.last().aborted)
        }
    }

    @Test
    fun cancellationHandlersCanWriteDuringRecomputation() {
        Store().use { store ->
            val revision = state(0)
            val cancelled = state(false)
            val target = computed { get, evaluation ->
                val result = get.get(revision)
                // Only the superseded evaluation owns this graph mutation. The
                // replacement has no such work to tear down when its Store closes.
                if (result == 0) evaluation.signal.onCancel { store.set(cancelled, true) }
                result
            }
            val combined = computed { get, _ -> get.get(target) to get.get(cancelled) }
            val seen = mutableListOf<Pair<Int, Boolean>>()
            store
                .watch(combined) { seen.add(store.get(combined)) }
                .use {
                    store.set(revision, 1)
                    assertEquals(listOf(1 to true), seen)
                }
        }
    }

    @Test
    fun cancellationFailuresDoNotPoisonReplacementComputations() {
        Store().use { store ->
            val revision = state(0)
            val failure = IllegalStateException("cleanup failed")
            var otherCleanupRan = false
            val target = computed { get, evaluation ->
                val value = get.get(revision)
                if (value == 0) {
                    evaluation.signal.onCancel { throw failure }
                    evaluation.signal.onCancel { otherCleanupRan = true }
                }
                value * 2
            }
            val seen = mutableListOf<Int>()
            store
                .watch(target) { seen.add(store.get(target)) }
                .use {
                    val aggregate =
                        assertThrows(ListenerException::class.java) { store.set(revision, 1) }
                    assertEquals(listOf(failure), aggregate.failures)
                    assertTrue(otherCleanupRan)
                    assertEquals(listOf(2), seen)
                    assertEquals(2, store.get(target))
                    store.set(revision, 2)
                    assertEquals(listOf(2, 4), seen)
                }
        }
    }

    @Test
    fun escapedWritersReportCancellationFailuresAfterNotifying() {
        Store().use { store ->
            val revision = state(0)
            val failure = IllegalStateException("cleanup failed")
            val writer = store.set(command<Unit, CommandContext> { context, _ -> context }, Unit)
            val target = computed { get, evaluation ->
                val value = get.get(revision)
                if (value == 0) evaluation.signal.onCancel { throw failure }
                value
            }
            val seen = mutableListOf<Int>()
            store
                .watch(target) { seen.add(store.get(target)) }
                .use {
                    val aggregate =
                        assertThrows(ListenerException::class.java) { writer.set(revision, 1) }
                    assertEquals(listOf(failure), aggregate.failures)
                    assertEquals(listOf(1), seen)
                    writer.set(revision, 2)
                    assertEquals(listOf(1, 2), seen)
                }
        }
    }

    @Test
    fun lateGettersReportTheirOwnCancellationFailures() {
        Store().use { store ->
            val revision = state(0)
            val failure = IllegalStateException("cleanup failed")
            val target = computed { get, evaluation ->
                val value = get.get(revision)
                if (value == 0) evaluation.signal.onCancel { throw failure }
                value
            }
            val accessor = computed { get, _ -> get }
            val getter = store.get(accessor)
            assertEquals(0, store.get(target))
            store.set(revision, 1)
            val aggregate = assertThrows(ListenerException::class.java) { getter.get(target) }
            assertEquals(listOf(failure), aggregate.failures)
            assertEquals(1, store.get(target))
            store.set(revision, 2)
            assertEquals(2, getter.get(target))
        }
    }

    @Test
    fun aFailedLazyInvalidationRetainsItsReplacementAndDependencies() {
        Store().use { store ->
            val revision = state(0)
            val failure = IllegalStateException("cleanup failed")
            val target = computed { get, evaluation ->
                val value = get.get(revision)
                if (value == 0) evaluation.signal.onCancel { throw failure }
                value
            }
            assertEquals(0, store.get(target))
            store.set(revision, 1)
            val aggregate = assertThrows(ListenerException::class.java) { store.get(target) }
            assertEquals(listOf(failure), aggregate.failures)
            assertEquals(1, store.get(target))
            store.set(revision, 2)
            assertEquals(2, store.get(target))
        }
    }

    @Test
    fun failedWatchSetupReleasesItsNewListener() {
        Store().use { store ->
            val revision = state(0)
            val target = computed { get, evaluation ->
                val value = get.get(revision)
                if (value == 0) evaluation.signal.onCancel { error("cleanup failed") }
                value
            }
            assertEquals(0, store.get(target))
            store.set(revision, 1)
            val seen = mutableListOf<Int>()
            assertThrows(ListenerException::class.java) {
                store.watch(target) { seen.add(store.get(target)) }
            }
            store.set(revision, 2)
            assertEquals(2, store.get(target))
            assertTrue(seen.isEmpty())
        }
    }

    @Test
    fun cleanupAndReplacementReadFailuresBothRemainVisible() {
        Store().use { store ->
            val revision = state(0)
            val cleanupFailure = IllegalStateException("cleanup failed")
            val readFailure = IllegalArgumentException("read failed")
            val target = computed { get, evaluation ->
                val value = get.get(revision)
                if (value == 0) evaluation.signal.onCancel { throw cleanupFailure }
                if (value == 1) throw readFailure
                value
            }
            assertEquals(0, store.get(target))
            store.set(revision, 1)
            val aggregate = assertThrows(ListenerException::class.java) { store.get(target) }
            assertTrue(aggregate.failures.any { it === cleanupFailure })
            assertTrue(aggregate.failures.any { it === readFailure })
            assertSame(
                readFailure,
                assertThrows(IllegalArgumentException::class.java) { store.get(target) },
            )
            store.set(revision, 2)
            assertEquals(2, store.get(target))
        }
    }

    @Test
    fun lateSignalAccessCannotCancelTheCurrentEvaluation() {
        Store().use { store ->
            val revision = state(0)
            val evaluations = mutableListOf<Evaluation>()
            val target = computed { get, evaluation ->
                evaluations.add(evaluation)
                get.get(revision)
            }
            store.get(target)
            store.set(revision, 1)
            store.get(target)
            assertTrue(evaluations.first().signal.aborted)
            assertFalse(evaluations.last().signal.aborted)
        }
    }

    @Test
    fun aSuspendedCommandFlushesItsPrefixAndEachEscapedWrite() = runTest {
        Store().use { store ->
            val source = state(0)
            val gate = CompletableDeferred<Unit>()
            val seen = mutableListOf<Int>()
            store
                .watch(source) { seen.add(store.get(source)) }
                .use {
                    val action =
                        command<Unit, kotlinx.coroutines.Deferred<Unit>> { context, _ ->
                            async(start = CoroutineStart.UNDISPATCHED) {
                                context.set(source, 1)
                                context.set(source, 2)
                                gate.await()
                                context.set(source, 3)
                                context.set(source, 4)
                            }
                        }
                    val pending = store.set(action, Unit)
                    assertEquals(listOf(2), seen)
                    gate.complete(Unit)
                    pending.await()
                    assertEquals(listOf(2, 3, 4), seen)
                }
        }
    }

    @Test
    fun lateAsyncDependenciesStayReactiveAndObsoleteReadsCannotReattach() = runTest {
        Store().use { store ->
            val branch = state(false)
            val old = state(1)
            val current = state(2)
            val gate = CompletableDeferred<Unit>()
            val target = computed { get, _ ->
                async(start = CoroutineStart.UNDISPATCHED) {
                    if (get.get(branch)) get.get(current)
                    else {
                        gate.await()
                        get.get(old)
                    }
                }
            }
            var notifications = 0
            store
                .watch(target) { notifications++ }
                .use {
                    val obsolete = store.get(target)
                    store.set(branch, true)
                    val active = store.get(target)
                    assertEquals(2, active.await())
                    gate.complete(Unit)
                    assertEquals(1, obsolete.await())
                    store.set(old, 99)
                    assertSame(active, store.get(target))
                    store.set(current, 3)
                    assertEquals(3, store.get(target).await())
                    assertEquals(2, notifications)
                }
        }
    }

    @Test
    fun dependencyFirstReadAfterSuspensionIsTracked() = runTest {
        Store().use { store ->
            val source = state(1)
            val gate = CompletableDeferred<Unit>()
            val target = computed { get, _ ->
                async(start = CoroutineStart.UNDISPATCHED) {
                    gate.await()
                    get.get(source)
                }
            }
            var notifications = 0
            store
                .watch(target) { notifications++ }
                .use {
                    gate.complete(Unit)
                    assertEquals(1, store.get(target).await())
                    store.set(source, 2)
                    assertEquals(2, store.get(target).await())
                    assertEquals(1, notifications)
                }
        }
    }

    @Test
    fun returnedAsyncValuesStaySharedAndAreNotAutomaticallyCancelled() = runTest {
        Store().use { store ->
            val revision = state(false)
            val first = CompletableDeferred<Int>()
            val second = CompletableDeferred<Int>()
            val target = computed { get, _ -> if (get.get(revision)) second else first }
            val one = store.watch(target) {}
            val two = store.watch(target) {}
            assertSame(first, store.get(target))
            one.close()
            assertFalse(first.isCancelled)
            store.set(revision, true)
            assertSame(second, store.get(target))
            first.complete(1)
            assertEquals(1, first.await())
            assertSame(second, store.get(target))
            two.close()
            second.complete(2)
        }
    }

    @Test
    fun aForeignThreadCannotWriteOrLoseASubscriptionCleanup() {
        Store().use { store ->
            val source = state(0)
            val seen = mutableListOf<Int>()
            val watch = store.watch(source) { seen.add(store.get(source)) }
            val failures = java.util.concurrent.atomic.AtomicReference<List<Throwable>>()
            val worker = Thread {
                val write = assertThrows(IllegalStateException::class.java) { store.set(source, 1) }
                val close = assertThrows(IllegalStateException::class.java) { watch.close() }
                failures.set(listOf(write, close))
            }
            worker.start()
            worker.join()
            assertEquals(2, failures.get().size)
            store.set(source, 2)
            assertEquals(listOf(2), seen)
            watch.close()
            store.set(source, 3)
            assertEquals(listOf(2), seen)
        }
    }

    @Test
    fun closeInvalidatesEvaluationsAndRetiredWritersCannotPublish() {
        val store = Store()
        val target = computed { _, evaluation -> evaluation.signal }
        val signal = store.get(target)
        val source = state(0)
        val writer = store.set(command<Unit, CommandContext> { context, _ -> context }, Unit)
        store.close()
        store.close()
        assertTrue(signal.aborted)
        assertThrows(CancellationException::class.java) { signal.throwIfAborted() }
        assertThrows(IllegalStateException::class.java) { writer.set(source, 1) }
    }
}
