package ai.okou.ccstate

import org.junit.Assert.*
import org.junit.Test

/** TS 6.1.0: empty-state, result, distinct, and watch-listener-prototype. */
class ResultParityTest {
    @Test
    fun nullableWritesBeforeFirstReadReachTheUpdater() {
        Store().use { store ->
            val source = state<String?>("initial")
            store.set(source, null)
            assertNull(store.get(source))
            store.update(source) { current ->
                assertNull(current)
                "restored"
            }
            assertEquals("restored", store.get(source))
        }
    }

    @Test
    fun successfulEmptyValuesRemainDistinctFromReadFailures() {
        for (mounted in listOf(false, true)) for (output in listOf(null, false, 0, "")) {
            Store().use { store ->
                val broken = state(false)
                val failure = IllegalStateException("offline")
                val target =
                    computed<Any?> { get, _ ->
                        if (get.get(broken)) throw failure
                        output
                    }
                val relay = computed { get, _ -> runCatching { get.get(target) } }
                val seen = mutableListOf<Result<Any?>>()
                val watch = if (mounted) store.watch(relay) { seen.add(store.get(relay)) } else null
                try {
                    assertEquals(output, store.get(relay).getOrThrow())
                    store.set(broken, true)
                    assertSame(failure, store.get(relay).exceptionOrNull())
                    store.set(broken, false)
                    assertEquals(output, store.get(target))
                    assertEquals(output, store.get(relay).getOrThrow())
                    if (mounted) {
                        assertEquals(2, seen.size)
                        assertSame(failure, seen[0].exceptionOrNull())
                        assertEquals(output, seen[1].getOrThrow())
                    }
                } finally {
                    watch?.close()
                }
            }
        }
    }

    @Test
    fun replacingAnErrorPropagatesItsIdentityThroughACatchingDerivation() {
        for (mounted in listOf(false, true)) Store().use { store ->
            val first = IllegalStateException("first")
            val second = IllegalStateException("second")
            val reason = state<Throwable>(first)
            val target = computed<Int> { get, _ -> throw get.get(reason) }
            val caught = computed { get, _ -> runCatching { get.get(target) }.exceptionOrNull() }
            val relay = computed { get, _ -> get.get(caught) }
            val seen = mutableListOf<Throwable?>()
            val watch = if (mounted) store.watch(relay) { seen.add(store.get(relay)) } else null
            try {
                assertSame(first, store.get(relay))
                store.set(reason, second)
                assertSame(second, store.get(relay))
                assertSame(
                    second,
                    assertThrows(IllegalStateException::class.java) { store.get(target) },
                )
                if (mounted) assertEquals(listOf(second), seen)
            } finally {
                watch?.close()
            }
        }
    }

    @Test
    fun throwingTheSameErrorKeepsDownstreamResultsMemoized() {
        for (mounted in listOf(false, true)) Store().use { store ->
            val revision = state(0)
            val failure = IllegalStateException("unchanged")
            val target =
                computed<Int> { get, _ ->
                    get.get(revision)
                    throw failure
                }
            var calls = 0
            val caught = computed { get, _ ->
                calls++
                runCatching { get.get(target) }.exceptionOrNull()
            }
            val watch = if (mounted) store.watch(caught) {} else null
            try {
                assertSame(failure, store.get(caught))
                store.set(revision, 1)
                assertSame(failure, store.get(caught))
                assertEquals(1, calls)
            } finally {
                watch?.close()
            }
        }
    }

    @Test
    fun theLastDistinctListenerOwnsUnmountAndRemountReadsFreshValues() {
        Store().use { store ->
            val source = state(0)
            val target = computed { get, _ -> get.get(source) * 2 }
            val first = mutableListOf<Int>()
            val second = mutableListOf<Int>()
            val one = store.watch(target) { first.add(store.get(target)) }
            val two = store.watch(target) { second.add(store.get(target)) }
            store.set(source, 1)
            one.close()
            store.set(source, 2)
            two.close()
            store.set(source, 3)
            assertEquals(listOf(2), first)
            assertEquals(listOf(2, 4), second)
            store
                .watch(target) { first.add(store.get(target)) }
                .use {
                    assertEquals(6, store.get(target))
                    assertEquals(listOf(2), first)
                    store.set(source, 4)
                    assertEquals(listOf(2, 8), first)
                }
        }
    }

    @Test
    fun unsubscribingInsideACallbackStopsItsReentrantNotification() {
        Store().use { store ->
            val source = state(0)
            var calls = 0
            lateinit var watch: Subscription
            watch =
                store.watch(source) {
                    calls++
                    watch.close()
                    store.set(source, 2)
                }
            store.set(source, 1)
            assertEquals(1, calls)
            assertEquals(2, store.get(source))
        }
    }

    @Test
    fun aCallbackSharedByStateAndComputedSeesOneConsistentSnapshot() {
        Store().use { store ->
            val source = state(0)
            val double = computed { get, _ -> get.get(source) * 2 }
            val seen = mutableListOf<Pair<Int, Int>>()
            val listener: () -> Unit = { seen.add(store.get(source) to store.get(double)) }
            store.watch(source, listener).use {
                store.watch(double, listener).use {
                    store.set(source, 2)
                    assertEquals(listOf(2 to 4), seen)
                }
            }
        }
    }

    @Test
    fun readsInsideAListenerDoNotCreateComputedDependencies() {
        Store().use { store ->
            val source = state(0)
            val unrelated = state(10)
            val target = computed { get, _ -> get.get(source) }
            val seen = mutableListOf<Int>()
            store
                .watch(target) { seen.add(store.get(unrelated)) }
                .use {
                    store.set(source, 1)
                    store.set(unrelated, 20)
                    assertEquals(listOf(10), seen)
                    store.set(source, 2)
                    assertEquals(listOf(10, 20), seen)
                }
        }
    }
}
