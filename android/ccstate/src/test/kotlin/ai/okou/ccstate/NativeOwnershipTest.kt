package ai.okou.ccstate

import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

/** Kotlin/JVM owner boundaries in addition to the pinned TS contract cases. */
class NativeOwnershipTest {
    @Test
    fun foreignThreadsCannotReadUseEscapedAccessorsOrCloseTheOwner() {
        Store().use { store ->
            val source = state(0)
            val accessor = computed { get, _ -> get }
            val getter = store.get(accessor)
            val writer = store.set(command<Unit, CommandContext> { context, _ -> context }, Unit)
            val outcomes = AtomicReference<List<Throwable?>>(emptyList())
            val worker = Thread {
                outcomes.set(
                    listOf(
                        runCatching { store.get(source) }.exceptionOrNull(),
                        runCatching { getter.get(source) }.exceptionOrNull(),
                        runCatching { writer.set(source, 1) }.exceptionOrNull(),
                        runCatching { store.close() }.exceptionOrNull(),
                    )
                )
            }
            worker.start()
            worker.join()
            assertEquals(4, outcomes.get().size)
            assertTrue(outcomes.get().all { it is IllegalStateException })
            assertEquals(0, store.get(source))
            store.set(source, 2)
            assertEquals(2, store.get(source))
        }
    }

    @Test
    fun closeCompletesAllEvaluationCleanupAndStaysClosedAfterAFailure() {
        val store = Store()
        val failure = IllegalStateException("cleanup failed")
        var otherCleanupRan = false
        val first = computed { _, evaluation ->
            evaluation.signal.onCancel { throw failure }
            evaluation.signal
        }
        val second = computed { _, evaluation ->
            evaluation.signal.onCancel { otherCleanupRan = true }
            evaluation.signal
        }
        val one = store.watch(first) {}
        val two = store.watch(second) {}
        val firstSignal = store.get(first)
        val secondSignal = store.get(second)
        try {
            val aggregate = assertThrows(ListenerException::class.java) { store.close() }
            assertEquals(listOf(failure), aggregate.failures)
            assertTrue(otherCleanupRan)
            assertTrue(firstSignal.aborted)
            assertTrue(secondSignal.aborted)
            assertThrows(IllegalStateException::class.java) { store.get(first) }
            store.close()
        } finally {
            one.close()
            two.close()
            store.close()
        }
    }
}
