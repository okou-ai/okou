package ai.okou.ccstate.compose

import ai.okou.ccstate.Store
import ai.okou.ccstate.computed
import ai.okou.ccstate.state
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class ObservationTest {
    @Test
    fun deferredPhasesRecoverThroughLoadingDataErrorAndData() = runTest {
        Store().use { store ->
            val first = CompletableDeferred<Int>()
            val source = state<Deferred<Int>>(first)
            val seen = mutableListOf<Loadable<Int>>()
            observeDeferred(store, source, this) { seen.add(it) }
                .use {
                    first.complete(1)
                    testScheduler.runCurrent()
                    val failed = CompletableDeferred<Int>()
                    store.set(source, failed)
                    val failure = IllegalStateException("offline")
                    failed.completeExceptionally(failure)
                    testScheduler.runCurrent()
                    store.set(source, CompletableDeferred(2))
                    assertEquals(6, seen.size)
                    for (index in listOf(0, 2, 4)) assertSame(Loadable.Loading, seen[index])
                    assertEquals(1, (seen[1] as Loadable.Data).value)
                    assertSame(failure, (seen[3] as Loadable.Error).cause)
                    assertEquals(2, (seen[5] as Loadable.Data).value)
                }
        }
    }

    @Test
    fun aLateRejectedDeferredCannotReplaceCurrentData() = runTest {
        Store().use { store ->
            val old = CompletableDeferred<Int>()
            val source = state<Deferred<Int>>(old)
            val seen = mutableListOf<Loadable<Int>>()
            observeDeferred(store, source, this, keepLast = true) { seen.add(it) }
                .use {
                    store.set(source, CompletableDeferred(2))
                    old.completeExceptionally(IllegalStateException("obsolete"))
                    testScheduler.runCurrent()
                    assertEquals(1, seen.size)
                    assertEquals(2, (seen.single() as Loadable.Data).value)
                }
        }
    }

    @Test
    fun keepLastRetainsAnErrorUntilTheReplacementSettles() = runTest {
        Store().use { store ->
            val failure = IllegalArgumentException("initial failure")
            val initial = CompletableDeferred<Int>().apply { completeExceptionally(failure) }
            val source = state<Deferred<Int>>(initial)
            val seen = mutableListOf<Loadable<Int>>()
            observeDeferred(store, source, this, keepLast = true) { seen.add(it) }
                .use {
                    assertSame(failure, (seen.single() as Loadable.Error).cause)
                    val replacement = CompletableDeferred<Int>()
                    store.set(source, replacement)
                    assertEquals(1, seen.size)
                    replacement.complete(42)
                    testScheduler.runCurrent()
                    assertEquals(42, (seen.last() as Loadable.Data).value)
                }
        }
    }

    @Test
    fun aCancelledProducerIsAnErrorWithoutCancellingItsObserverScope() = runTest {
        Store().use { store ->
            val producer = CompletableDeferred<Int>()
            val source = state<Deferred<Int>>(producer)
            val seen = mutableListOf<Loadable<Int>>()
            observeDeferred(store, source, this) { seen.add(it) }
                .use {
                    val failure = CancellationException("producer cancelled")
                    producer.cancel(failure)
                    testScheduler.runCurrent()
                    assertSame(failure, (seen.last() as Loadable.Error).cause)
                    assertTrue(isActive)
                    store.set(source, CompletableDeferred(7))
                    assertEquals(7, (seen.last() as Loadable.Data).value)
                }
        }
    }

    @Test
    fun aSynchronousReadFailureCanRecoverToTheSameSharedDeferred() = runTest {
        Store().use { store ->
            val broken = state(false)
            val task = CompletableDeferred<Int>()
            val failure = IllegalStateException("read failed")
            val target =
                computed<Deferred<Int>> { get, _ ->
                    if (get.get(broken)) throw failure
                    task
                }
            val seen = mutableListOf<Loadable<Int>>()
            observeDeferred(store, target, this) { seen.add(it) }
                .use {
                    store.set(broken, true)
                    assertSame(failure, (seen.last() as Loadable.Error).cause)
                    task.complete(9)
                    testScheduler.runCurrent()
                    assertSame(failure, (seen.last() as Loadable.Error).cause)
                    store.set(broken, false)
                    assertEquals(9, (seen.last() as Loadable.Data).value)
                }
        }
    }

    @Test
    fun disposalIgnoresALateRejectionAndReleasesOnlyTheWaiter() = runTest {
        Store().use { store ->
            val task = CompletableDeferred<Int>()
            val source = state<Deferred<Int>>(task)
            val seen = mutableListOf<Loadable<Int>>()
            val observer = observeDeferred(store, source, this) { seen.add(it) }
            observer.close()
            assertTrue(task.isActive)
            task.completeExceptionally(IllegalStateException("late failure"))
            testScheduler.runCurrent()
            assertEquals(1, seen.size)
            assertSame(Loadable.Loading, seen.single())
        }
    }

    @Test
    fun cancellingTheWaiterScopeDoesNotPublishAnErrorOrCancelTheProducer() = runTest {
        Store().use { store ->
            val task = CompletableDeferred<Int>()
            val source = state<Deferred<Int>>(task)
            val owner = SupervisorJob()
            val scope = CoroutineScope(coroutineContext + owner)
            val seen = mutableListOf<Loadable<Int>>()
            val observer = observeDeferred(store, source, scope) { seen.add(it) }
            try {
                scope.cancel()
                testScheduler.runCurrent()
                assertTrue(task.isActive)
                task.complete(1)
                testScheduler.runCurrent()
                assertEquals(1, seen.size)
                assertSame(Loadable.Loading, seen.single())
            } finally {
                observer.close()
                owner.cancel()
            }
        }
    }

    @Test
    fun aCancelledScopeCannotInstallAnObservation() = runTest {
        Store().use { store ->
            val task = CompletableDeferred<Int>()
            val source = state<Deferred<Int>>(task)
            val owner = Job().apply { cancel() }
            val scope = CoroutineScope(coroutineContext + owner)
            var calls = 0
            assertThrows(CancellationException::class.java) {
                observeDeferred(store, source, scope) { calls++ }
            }
            store.set(source, CompletableDeferred(2))
            assertEquals(0, calls)
            task.complete(1)
        }
    }

    @Test
    fun replacementSubscriptionsCanShareAProducerWithoutRevivingTheOldObserver() = runTest {
        Store().use { store ->
            val shared = CompletableDeferred<Int>()
            val first = state<Deferred<Int>>(shared)
            val second = state<Deferred<Int>>(shared)
            val old = mutableListOf<Loadable<Int>>()
            val current = mutableListOf<Loadable<Int>>()
            val one = observeDeferred(store, first, this) { old.add(it) }
            one.close()
            observeDeferred(store, second, this) { current.add(it) }
                .use {
                    shared.complete(3)
                    testScheduler.runCurrent()
                    assertEquals(1, old.size)
                    assertSame(Loadable.Loading, old.single())
                    assertEquals(3, (current.last() as Loadable.Data).value)
                }
        }
    }

    @Test
    fun aNativeObserverGetsInitialStateChangesAndRecoverableErrors() {
        Store().use { store ->
            val source = state(1)
            val failure = IllegalStateException("unavailable")
            val target = computed { get, _ ->
                if (get.get(source) < 0) throw failure
                get.get(source)
            }
            val values = mutableListOf<Loadable<Int>>()
            val observer = observe(store, target, values::add)
            assertEquals(1, (values.last() as Loadable.Data).value)
            store.set(source, -1)
            assertSame(failure, (values.last() as Loadable.Error).cause)
            store.set(source, 2)
            assertEquals(2, (values.last() as Loadable.Data).value)
            observer.close()
            val finalSize = values.size
            store.set(source, 3)
            assertEquals(finalSize, values.size)
        }
    }

    @Test
    fun subscriberFailureDuringInitializationReleasesItsSubscription() {
        Store().use { store ->
            val source = state(0)
            val failure = IllegalArgumentException("consumer")
            assertSame(
                failure,
                assertThrows(IllegalArgumentException::class.java) {
                    observe(store, source) { throw failure }
                },
            )
            store.set(source, 1)
            assertEquals(1, store.get(source))
        }
    }

    @Test
    fun oldDeferredCompletionCannotOverwriteTheNewValue() = runTest {
        Store().use { store ->
            val first = CompletableDeferred<Int>()
            val second = CompletableDeferred<Int>()
            val source = state<Deferred<Int>>(first)
            val values = mutableListOf<Loadable<Int>>()
            observeDeferred(store, source, this) { values.add(it) }
                .use {
                    assertSame(Loadable.Loading, values.last())
                    store.set(source, second)
                    second.complete(2)
                    testScheduler.runCurrent()
                    assertEquals(2, (values.last() as Loadable.Data).value)
                    first.complete(1)
                    testScheduler.runCurrent()
                    assertEquals(2, (values.last() as Loadable.Data).value)
                    assertFalse(first.isCancelled)
                }
        }
    }

    @Test
    fun closingOneWaiterDoesNotCancelTheSharedProducer() = runTest {
        Store().use { store ->
            val task = CompletableDeferred<Int>()
            val source = state<Deferred<Int>>(task)
            val first = mutableListOf<Loadable<Int>>()
            val second = mutableListOf<Loadable<Int>>()
            val one = observeDeferred(store, source, this) { first.add(it) }
            val two = observeDeferred(store, source, this) { second.add(it) }
            one.close()
            assertFalse(task.isCancelled)
            task.complete(42)
            testScheduler.runCurrent()
            assertSame(Loadable.Loading, first.last())
            assertEquals(42, (second.last() as Loadable.Data).value)
            two.close()
            two.close()
        }
    }

    @Test
    fun keepLastRetainsThePhaseOnlyWhileTheReplacementIsPending() = runTest {
        Store().use { store ->
            val initial = CompletableDeferred(1)
            val source = state<Deferred<Int>>(initial)
            val values = mutableListOf<Loadable<Int>>()
            observeDeferred(store, source, this, keepLast = true) { values.add(it) }
                .use {
                    assertEquals(1, (values.last() as Loadable.Data).value)
                    val replacement = CompletableDeferred<Int>()
                    store.set(source, replacement)
                    assertEquals(1, (values.last() as Loadable.Data).value)
                    val failure = IllegalArgumentException("new failure")
                    replacement.completeExceptionally(failure)
                    testScheduler.runCurrent()
                    assertSame(failure, (values.last() as Loadable.Error).cause)
                }
        }
    }
}
