package ai.okou.ccstate

/** Definitions are identities; values and dependencies belong to a Store. */
sealed interface Signal<T>

class State<T> internal constructor(internal val initial: T) : Signal<T>

class Computed<T> internal constructor(internal val read: (Getter, Evaluation) -> T) : Signal<T>

class Command<I, O> internal constructor(internal val write: (CommandContext, I) -> O)

interface Getter {
    fun <T> get(signal: Signal<T>): T
}

interface CommandContext : Getter {
    fun <T> set(state: State<T>, value: T)

    fun <T> update(state: State<T>, updater: (T) -> T)

    fun <I, O> set(command: Command<I, O>, input: I): O
}

fun <T> state(initial: T): State<T> = State(initial)

fun <T> computed(read: (Getter, Evaluation) -> T): Computed<T> = Computed(read)

fun <I, O> command(write: (CommandContext, I) -> O): Command<I, O> = Command(write)

/** A cancelled observer releases its captures even if the caller retains this handle. */
class Subscription internal constructor(private var cleanup: (() -> Unit)?) : AutoCloseable {
    private val thread = Thread.currentThread()

    override fun close() {
        val action = cleanup ?: return
        check(Thread.currentThread() === thread) {
            "CCState subscription closed from another thread"
        }
        cleanup = null
        action()
    }
}

/** Own cleanup at a native adapter boundary; closing is idempotent. */
fun subscription(cleanup: () -> Unit): Subscription = Subscription(cleanup)

/** TS core uses ===, including value equality for scalar primitives and identity for objects. */
internal fun strictEqual(first: Any?, second: Any?): Boolean =
    when {
        first is Double && second is Double -> first == second
        first is Float && second is Float -> first == second
        first is Long && second is Long -> first == second
        first is Int && second is Int -> first == second
        first is Short && second is Short -> first == second
        first is Byte && second is Byte -> first == second
        first is String && second is String -> first == second
        first is Boolean && second is Boolean -> first == second
        first is Char && second is Char -> first == second
        else -> first === second
    }

class ListenerException(val failures: List<Throwable>) :
    RuntimeException("CCState callbacks failed") {
    init {
        failures.forEach(::addSuppressed)
    }
}
