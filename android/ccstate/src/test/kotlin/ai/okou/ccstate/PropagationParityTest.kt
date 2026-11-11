package ai.okou.ccstate

import org.junit.Assert.*
import org.junit.Test

/** TS 6.1.0: batch-command, cache, propagation, and glitch. */
class PropagationParityTest {
    @Test
    fun threeWritesWithoutEagerReadsComputeAndNotifyOnlyTheFinalValue() {
        Store().use { store ->
            val source = state(0)
            var calls = 0
            val target = computed { get, _ ->
                calls++
                get.get(source) * 2
            }
            val seen = mutableListOf<Int>()
            store
                .watch(target) { seen.add(store.get(target)) }
                .use {
                    store.set(
                        command<Unit, Unit> { context, _ ->
                            context.set(source, 1)
                            context.set(source, 2)
                            context.set(source, 3)
                        },
                        Unit,
                    )
                    assertEquals(listOf(6), seen)
                    assertEquals(2, calls)
                }
        }
    }

    @Test
    fun subscribingInsideAnUpdaterPreservesTheNewListener() {
        Store().use { store ->
            val source = state(0)
            val seen = mutableListOf<Int>()
            lateinit var watch: Subscription
            store.update(source) { previous ->
                watch = store.watch(source) { seen.add(store.get(source)) }
                previous + 1
            }
            watch.use {
                assertEquals(listOf(1), seen)
                store.set(source, 2)
                assertEquals(listOf(1, 2), seen)
            }
        }
    }

    @Test
    fun subscribingToPendingCommandValuesDoesNotEmitAnInitialNotification() {
        Store().use { store ->
            val source = state(0)
            val target = computed { get, _ -> get.get(source) }
            val seen = mutableListOf<Int>()
            lateinit var watch: Subscription
            store.set(
                command<Unit, Unit> { context, _ ->
                    context.set(source, 1)
                    watch = store.watch(target) { seen.add(store.get(target)) }
                    assertEquals(1, context.get(target))
                    assertTrue(seen.isEmpty())
                    context.set(source, 2)
                },
                Unit,
            )
            watch.use { assertEquals(listOf(2), seen) }
        }
    }

    @Test
    fun eagerConditionalReadsReattachDependenciesWithinTheSameCommand() {
        Store().use { store ->
            val enabled = state(false)
            val source = state(0)
            val target =
                computed<Int?> { get, _ -> if (get.get(enabled)) get.get(source) else null }
            val seen = mutableListOf<Int?>()
            store
                .watch(target) { seen.add(store.get(target)) }
                .use {
                    store.set(
                        command<Unit, Unit> { context, _ ->
                            context.set(enabled, true)
                            assertEquals(0, context.get(target))
                            context.set(source, 1)
                        },
                        Unit,
                    )
                    assertEquals(listOf(1), seen)
                    store.set(source, 2)
                    assertEquals(listOf(1, 2), seen)
                }
        }
    }

    @Test
    fun anEqualBranchCannotHideAChangedSiblingInOneCommand() {
        Store().use { store ->
            val first = state(listOf(0))
            val second = state(listOf(0))
            val left = computed { get, _ -> get.get(first).single() }
            val right = computed { get, _ -> get.get(second).single() }
            val joined = computed { get, _ -> get.get(left) to get.get(right) }
            val seen = mutableListOf<Pair<Int, Int>>()
            store
                .watch(joined) { seen.add(store.get(joined)) }
                .use {
                    store.set(
                        command<Unit, Unit> { context, _ ->
                            context.set(first, listOf(0))
                            context.set(second, listOf(1))
                        },
                        Unit,
                    )
                    assertEquals(listOf(0 to 1), seen)
                }
        }
    }

    @Test
    fun retainedComputedGettersStayReactiveAcrossLaterWriteBatches() {
        Store().use { store ->
            val stable = state(0)
            val changing = state(0)
            val closure = computed { get, _ -> { value: Int -> value + get.get(stable) } }
            val upstream = computed { get, _ -> get.get(closure)(get.get(changing)) }
            val downstream = computed { get, _ -> get.get(upstream) * 2 }
            val seen = mutableListOf<Int>()
            store
                .watch(downstream) { seen.add(store.get(downstream)) }
                .use {
                    store.set(changing, 1)
                    store.set(changing, 2)
                    store.set(stable, 10)
                    assertEquals(listOf(2, 4, 24), seen)
                }
        }
    }

    @Test
    fun layeredDiamondsEvaluateEachDerivationOncePerWrite() {
        for (depth in listOf(4, 8, 12)) Store().use { store ->
            val source = state(1)
            var calls = 0
            fun counted(read: (Getter) -> Int) = computed { get, _ ->
                calls++
                read(get)
            }
            var left = counted { it.get(source) }
            var right = counted { it.get(source) }
            repeat(depth - 1) {
                val oldLeft = left
                val oldRight = right
                left = counted { it.get(oldLeft) + it.get(oldRight) }
                right = counted { it.get(oldLeft) + it.get(oldRight) }
            }
            val root = counted { it.get(left) + it.get(right) }
            val seen = mutableListOf<Int>()
            store
                .watch(root) { seen.add(store.get(root)) }
                .use {
                    assertEquals(1 shl depth, store.get(root))
                    assertEquals(2 * depth + 1, calls)
                    for (value in listOf(2, 3)) {
                        calls = 0
                        store.set(source, value)
                        assertEquals(value * (1 shl depth), store.get(root))
                        assertEquals(2 * depth + 1, calls)
                    }
                    assertEquals(listOf(2 * (1 shl depth), 3 * (1 shl depth)), seen)
                }
        }
    }

    @Test
    fun equalBranchSwitchesDetachObsoleteSourcesWithoutRecomputingTheJoin() {
        Store().use { store ->
            val chooseLeft = state(true)
            val left = state(1)
            val right = state(1)
            val selected = computed { get, _ -> get.get(if (get.get(chooseLeft)) left else right) }
            val double = computed { get, _ -> get.get(selected) * 2 }
            var calls = 0
            val join = computed { get, _ ->
                calls++
                get.get(selected) + get.get(double)
            }
            val seen = mutableListOf<Int>()
            store
                .watch(join) { seen.add(store.get(join)) }
                .use {
                    calls = 0
                    store.set(chooseLeft, false)
                    store.set(left, 2)
                    assertEquals(3, store.get(join))
                    assertEquals(0, calls)
                    store.set(right, 2)
                    store.set(chooseLeft, true)
                    store.set(right, 3)
                    store.set(left, 3)
                    assertEquals(listOf(6, 9), seen)
                    assertEquals(2, calls)
                }
        }
    }

    @Test
    fun multipleUnmountedRootsShareTheCurrentUpstreamCache() {
        Store().use { store ->
            val source = state(1)
            var calls = 0
            val shared = computed { get, _ ->
                calls++
                get.get(source) * 2
            }
            val left = computed { get, _ -> get.get(shared) + 1 }
            val right = computed { get, _ -> get.get(shared) - 1 }
            repeat(2) {
                assertEquals(3, store.get(left))
                assertEquals(1, store.get(right))
            }
            store.set(source, 2)
            assertEquals(5, store.get(left))
            assertEquals(3, store.get(right))
            assertEquals(2, calls)
        }
    }
}
