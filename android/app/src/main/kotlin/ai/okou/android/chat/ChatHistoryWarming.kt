package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class HistoryWarmingState(
    val phase: ChatReadPhase = ChatReadPhase.Idle,
    val revision: Long = 0,
    val failure: Exception? = null,
)

/** Foreground prefetch owns no visible history, read receipt or list-loading state. */
class ChatHistoryWarming(
    private val service: ChatListService,
    private val cache: ChatCacheStore.Lease,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val candidates: suspend () -> List<String>,
    private val selected: () -> String?,
    private val onFailure: (Exception) -> Unit,
    private val dispatcher: CoroutineDispatcher,
    private val monotonicMillis: () -> Long,
    private val onUnavailable: (String) -> Unit,
) {
    private val mutable = MutableStateFlow(HistoryWarmingState())
    val state = mutable.asStateFlow()
    private val demand = Channel<Unit>(Channel.CONFLATED)
    private val worker = Mutex()
    private val history = ConversationHistorySync(service, dispatcher)
    private var foreground = false
    private var closed = false
    private var generation = 0L
    private var job: Job? = null
    private var startedAt: Long? = null

    private fun current(ticket: Long) =
        !closed && foreground && authorized() && generation == ticket

    private suspend fun requireCurrent(ticket: Long) {
        currentCoroutineContext().ensureActive()
        if (!current(ticket)) throw CancellationException("History warmer retired")
    }

    fun foreground(value: Boolean) {
        if (closed || foreground == value) return
        foreground = value
        val ticket = ++generation
        job?.cancel()
        if (!value) {
            mutable.value = mutable.value.copy(phase = ChatReadPhase.Idle, failure = null)
            return
        }
        val next =
            scope.launch(start = CoroutineStart.LAZY) {
                worker.withLock {
                    if (!current(ticket)) return@withLock
                    for (ignored in demand) {
                        val remaining =
                            startedAt?.let { (it + 1_000 - monotonicMillis()).coerceAtLeast(0) }
                                ?: 0
                        if (remaining > 0) delay(remaining)
                        while (demand.tryReceive().isSuccess) {}
                        try {
                            val ids = candidates().distinct().filter { it != selected() }
                            requireCurrent(ticket)
                            if (ids.isEmpty()) continue
                            startedAt = monotonicMillis()
                            mutable.value =
                                mutable.value.copy(phase = ChatReadPhase.Loading, failure = null)
                            warm(ids, ticket)
                            requireCurrent(ticket)
                            mutable.value =
                                HistoryWarmingState(ChatReadPhase.Ready, mutable.value.revision + 1)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: Exception) {
                            if (current(ticket)) {
                                mutable.value =
                                    HistoryWarmingState(
                                        ChatReadPhase.Failed,
                                        mutable.value.revision + 1,
                                        error,
                                    )
                                onFailure(error)
                            }
                        }
                    }
                }
            }
        job = next
        next.start()
    }

    fun invalidate() {
        if (!closed && foreground && authorized()) demand.trySend(Unit)
    }

    private suspend fun warm(ids: List<String>, ticket: Long) {
        val cached = cache.historyCursors(ids)
        requireCurrent(ticket)
        val cursors = ids.associateWith { cached[it] ?: HistoryCursor() }
        val batch = service.historyCatchUp(cursors)
        withContext(dispatcher) { batch.validate(cursors) }
        requireCurrent(ticket)
        cache.appendWarmedHistories(cached, batch.events, System.currentTimeMillis(), selected)
        val failures = coroutineScope {
            batch.notFoundThreads
                .map { id ->
                    async {
                        requireCurrent(ticket)
                        if (id == selected()) return@async null
                        try {
                            val checkpoint = history.synchronize(id, null)
                            requireCurrent(ticket)
                            cache.saveWarmedHistory(
                                checkpoint,
                                System.currentTimeMillis(),
                                cached[id],
                                selected,
                            )
                            null
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: Exception) {
                            requireCurrent(ticket)
                            when {
                                error is ApiFailure.Http && error.status in setOf(403, 404) -> {
                                    onUnavailable(id)
                                    cache.clearWarmedHistory(id, cached[id], selected)
                                    null
                                }
                                error is ApiFailure.Unauthenticated ||
                                    error is ApiFailure.UpdateRequired ||
                                    error is ApiFailure.Http && error.status == 401 -> throw error
                                else -> error
                            }
                        }
                    }
                }
                .awaitAll()
        }
        failures.firstOrNull { it != null }?.let { throw it }
    }

    fun close() {
        closed = true
        generation++
        job?.cancel()
        demand.close()
    }
}
