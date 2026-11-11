package ai.okou.ccstate.compose

import ai.okou.ccstate.Store
import ai.okou.ccstate.computed
import ai.okou.ccstate.state
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class ObservationTest {
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
