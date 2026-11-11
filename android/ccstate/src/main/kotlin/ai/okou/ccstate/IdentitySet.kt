package ai.okou.ccstate

/** JS Set uses reference identity for functions, unlike Kotlin function-reference equals. */
internal class IdentitySet<T : Any> : AbstractMutableSet<T>() {
    private class Key<T : Any>(val value: T) {
        override fun equals(other: Any?): Boolean = other is Key<*> && value === other.value

        override fun hashCode(): Int = System.identityHashCode(value)
    }

    private val values = linkedMapOf<Key<T>, T>()

    override val size: Int
        get() = values.size

    override fun add(element: T): Boolean = values.put(Key(element), element) == null

    override fun contains(element: T): Boolean = values.containsKey(Key(element))

    override fun remove(element: T): Boolean = values.remove(Key(element)) != null

    override fun clear() = values.clear()

    override fun iterator(): MutableIterator<T> = values.values.iterator()
}
