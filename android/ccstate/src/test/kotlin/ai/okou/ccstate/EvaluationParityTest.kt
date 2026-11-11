package ai.okou.ccstate

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** TS 6.1.0: abort and dependencies; coroutine gates replace JS microtask delays. */
class EvaluationParityTest {
    @Test
    fun signalOwnershipIsIsolatedBetweenStoresInBothObservationModes() {
        for (mounted in listOf(false, true)) Store().use { first ->
            Store().use { second ->
                val revision = state(0)
                val target = computed { get, evaluation ->
                    get.get(revision)
                    evaluation.signal
                }
                val one = if (mounted) first.watch(target) {} else null
                val two = if (mounted) second.watch(target) {} else null
                try {
                    val oldFirst = first.get(target)
                    val oldSecond = second.get(target)
                    assertNotSame(oldFirst, oldSecond)
                    first.set(revision, 1)
                    val currentFirst = first.get(target)
                    assertTrue(oldFirst.aborted)
                    assertFalse(currentFirst.aborted)
                    assertSame(oldSecond, second.get(target))
                    assertFalse(oldSecond.aborted)
                    second.set(revision, 1)
                    assertNotSame(oldSecond, second.get(target))
                    assertTrue(oldSecond.aborted)
                    assertFalse(currentFirst.aborted)
                } finally {
                    one?.close()
                    two?.close()
                }
            }
        }
    }

    @Test
    fun invalidationSurvivesBranchesThatSkipSignalOrThrowBeforeReadingIt() {
        for (mounted in listOf(false, true)) Store().use { store ->
            val revision = state(0)
            val unrelated = state(0)
            val failure = IllegalStateException("read failed")
            val evaluations = mutableListOf<Evaluation>()
            val target = computed { get, evaluation ->
                val value = get.get(revision)
                evaluations.add(evaluation)
                if (value == 0) evaluation.signal
                if (value == 2) throw failure
                value
            }
            val watch = if (mounted) store.watch(target) {} else null
            try {
                assertEquals(0, store.get(target))
                val initial = evaluations.single().signal
                store.set(unrelated, 1)
                store.set(revision, 0)
                assertEquals(0, store.get(target))
                assertFalse(initial.aborted)
                store.set(revision, 1)
                assertEquals(mounted, initial.aborted)
                assertEquals(1, store.get(target))
                assertTrue(initial.aborted)
                store.set(revision, 2)
                assertSame(
                    failure,
                    assertThrows(IllegalStateException::class.java) { store.get(target) },
                )
                assertTrue(evaluations[1].signal.aborted)
                val failedEvaluation = evaluations[2].signal
                assertFalse(failedEvaluation.aborted)
                store.set(revision, 3)
                assertEquals(3, store.get(target))
                assertTrue(failedEvaluation.aborted)
                assertFalse(evaluations.last().signal.aborted)
            } finally {
                watch?.close()
            }
        }
    }

    @Test
    fun delayedSignalReadsCannotAbortTheNewEvaluation() = runTest {
        for (mounted in listOf(false, true)) for (readBeforeAwait in listOf(false, true)) {
            Store().use { store ->
                val revision = state(0)
                val gate = CompletableDeferred<Unit>()
                val evaluations = mutableListOf<Evaluation>()
                val target = computed { get, evaluation ->
                    val value = get.get(revision)
                    evaluations.add(evaluation)
                    async(start = CoroutineStart.UNDISPATCHED) {
                        val initial = if (readBeforeAwait || value > 0) evaluation.signal else null
                        gate.await()
                        if (initial != null) assertSame(initial, evaluation.signal)
                        evaluation.signal
                    }
                }
                val watch = if (mounted) store.watch(target) {} else null
                try {
                    val first = store.get(target)
                    store.set(revision, 1)
                    val second = store.get(target)
                    val current = evaluations.last().signal
                    assertFalse(current.aborted)
                    gate.complete(Unit)
                    assertTrue(first.await().aborted)
                    assertSame(current, second.await())
                    assertFalse(current.aborted)
                } finally {
                    watch?.close()
                }
            }
        }
    }

    @Test
    fun returningTheSameDeferredStillReplacesDynamicDependencyEdges() = runTest {
        Store().use { store ->
            val chooseLeft = state(true)
            val left = state(1)
            val right = state(1)
            val shared = CompletableDeferred<Int>()
            var calls = 0
            val target = computed { get, _ ->
                get.get(if (get.get(chooseLeft)) left else right)
                calls++
                shared
            }
            var notifications = 0
            store
                .watch(target) { notifications++ }
                .use {
                    store.set(chooseLeft, false)
                    store.set(left, 2)
                    assertEquals(2, calls)
                    store.set(right, 2)
                    assertEquals(3, calls)
                    assertSame(shared, store.get(target))
                    assertEquals(0, notifications)
                    shared.complete(42)
                    assertEquals(42, store.get(target).await())
                }
        }
    }

    @Test
    fun nativeProducerCancellationRequiresTheEvaluationOwnersExplicitOptIn() = runTest {
        Store().use { store ->
            val revision = state(0)
            val gate = CompletableDeferred<Unit>()
            val target = computed { get, evaluation ->
                val value = get.get(revision)
                val task =
                    async(start = CoroutineStart.UNDISPATCHED) {
                        gate.await()
                        value
                    }
                evaluation.signal.onCancel { task.cancel() }
                task
            }
            val watch = store.watch(target) {}
            val first = store.get(target)
            watch.close()
            assertTrue(first.isActive)
            store.set(revision, 1)
            assertTrue(first.isActive)
            val current = store.get(target)
            assertTrue(first.isCancelled)
            assertTrue(current.isActive)
            store.close()
            testScheduler.runCurrent()
            assertTrue(first.isCompleted)
            assertTrue(current.isCancelled)
            assertTrue(current.isCompleted)
        }
    }
}
