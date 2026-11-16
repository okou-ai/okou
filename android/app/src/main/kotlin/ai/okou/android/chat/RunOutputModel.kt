package ai.okou.android.chat

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class RunOutputPhase {
    Waiting,
    Live,
    CatchingUp,
}

data class RunOutputState(
    val threadId: String? = null,
    val messages: List<HistoryMessage> = emptyList(),
    val phase: RunOutputPhase = RunOutputPhase.Waiting,
)

/** Workspace-owned optimistic text, projected for the visible conversation on Main. */
class RunOutputModel(
    private val history: () -> ConversationUiState,
    private val authorized: () -> Boolean,
    private val catchUp: () -> Unit,
) {
    private data class Buffer(val threadId: String, val runId: String, val text: String)

    private val buffers = linkedMapOf<String, Buffer>()
    private val mutable = MutableStateFlow(RunOutputState())
    val state = mutable.asStateFlow()
    private val demand = MutableStateFlow<RunOutputTarget?>(null)
    val target = demand.asStateFlow()
    private var visible = false
    private var closed = false
    private var epoch = 0L
    private var ownerGeneration = -1L

    fun visible(value: Boolean) {
        if (closed || visible == value) return
        visible = value
        epoch++
        reconcile()
    }

    fun reconcile() {
        if (closed) return
        val current = history()
        if (current.generation != ownerGeneration || current.thread?.id != mutable.value.threadId) {
            ownerGeneration = current.generation
            epoch++
            mutable.value = RunOutputState(threadId = current.thread?.id)
        }
        val persisted = current.transcript?.persistedIds.orEmpty()
        val removed = buffers.keys.filter { it in persisted }
        for (id in removed) buffers.remove(id)
        if (removed.isNotEmpty()) {
            mutable.value = mutable.value.copy(phase = RunOutputPhase.Waiting)
        }
        val run = activeRun(current)
        if (buffers.any { it.value.threadId == current.thread?.id && it.value.runId != run }) {
            mutable.value = mutable.value.copy(phase = RunOutputPhase.CatchingUp)
        }
        val thread = current.thread?.id
        val selected =
            if (visible && authorized() && thread != null && run != null) thread to run else null
        val previous = demand.value
        if (previous?.let { it.threadId to it.runId } != selected) epoch++
        demand.value =
            selected?.let { (threadId, runId) -> RunOutputTarget(threadId, runId, epoch) }
        publish()
    }

    fun transport(phase: RealtimePhase) {
        if (phase != RealtimePhase.Connected && mutable.value.messages.isNotEmpty()) discontinuity()
    }

    fun receive(target: RunOutputTarget, signal: RunOutputSignal) {
        val current = history()
        val transcript = current.transcript ?: return
        if (
            closed ||
                !authorized() ||
                !visible ||
                demand.value != target ||
                current.thread?.id != target.threadId ||
                activeRun(current) != target.runId
        )
            return
        if (signal is RunOutputSignal.Discontinuity) {
            discontinuity()
            return
        }
        val delta = (signal as RunOutputSignal.Delta).value
        if (
            delta.threadId != target.threadId ||
                delta.runId != target.runId ||
                delta.eventId in transcript.persistedIds
        )
            return
        val previous = buffers[delta.eventId]
        // Match Web: chunk zero creates a block; later arrivals append in delivery order.
        if (previous == null && delta.chunkIndex != 0L) return
        if (previous != null && (previous.runId != delta.runId || delta.chunkIndex == 0L)) return
        buffers[delta.eventId] =
            Buffer(delta.threadId, delta.runId, previous?.text.orEmpty() + delta.delta)
        mutable.value = mutable.value.copy(phase = RunOutputPhase.Live)
        publish()
    }

    private fun discontinuity() {
        val changed = mutable.value.phase != RunOutputPhase.CatchingUp
        mutable.value = mutable.value.copy(phase = RunOutputPhase.CatchingUp)
        if (changed) catchUp()
    }

    private fun activeRun(current: ConversationUiState): String? {
        val transcript = current.transcript ?: return null
        // Web derives demand from persisted events followed by retained optimistic blocks.
        return (transcript.liveRunIds +
                buffers.values
                    .filter { it.threadId == current.thread?.id }
                    .map { it.runId }
                    .filterNot { it in transcript.terminatedRunIds })
            .distinct()
            .lastOrNull()
    }

    private fun publish() {
        mutable.value =
            mutable.value.copy(
                messages =
                    buffers
                        .filterValues { it.threadId == mutable.value.threadId }
                        .map { (id, value) ->
                            HistoryMessage(
                                id,
                                value.runId,
                                HistoryRole.Assistant,
                                listOf(HistoryBlock(HistoryBlockKind.Text, value.text)),
                            )
                        }
            )
    }

    fun close() {
        closed = true
        demand.value = null
        buffers.clear()
        mutable.value = RunOutputState()
    }
}

/** Persisted IDs win even when Compose observes the two StateFlows in different frames. */
fun HistoryTranscript.withOutput(output: RunOutputState, threadId: String): List<HistoryMessage> {
    if (output.threadId != threadId) return messages
    val extra = output.messages.filter { it.id !in persistedIds }.groupBy { it.runId }
    val last =
        messages.mapIndexedNotNull { index, message -> message.runId?.let { it to index } }.toMap()
    return buildList {
        for ((index, message) in messages.withIndex()) {
            add(message)
            if (message.runId != null && last[message.runId] == index)
                addAll(extra[message.runId].orEmpty())
        }
        addAll(extra.filterKeys { it !in last }.values.flatten())
    }
}
