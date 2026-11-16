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

/** Main-thread, visible-conversation projection. Chunks never enter the confirmed cache. */
class RunOutputModel(
    private val history: () -> ConversationUiState,
    private val authorized: () -> Boolean,
    private val catchUp: () -> Unit,
) {
    private data class Buffer(
        val runId: String,
        val runEventId: String,
        val text: String,
        val index: Long,
        val interrupted: Boolean = false,
    )

    private val buffers = linkedMapOf<String, Buffer>()
    private val mutable = MutableStateFlow(RunOutputState())
    val state = mutable.asStateFlow()
    private val demand = MutableStateFlow<RunOutputTarget?>(null)
    val target = demand.asStateFlow()
    private var visible = false
    private var closed = false
    private var epoch = 0L
    private var size = 0
    private var full = false
    private var ownerGeneration = -1L

    fun visible(value: Boolean) {
        if (closed || visible == value) return
        visible = value
        if (!value && buffers.isNotEmpty()) discontinuity()
        epoch++
        reconcile()
    }

    fun reconcile() {
        if (closed) return
        val current = history()
        if (current.generation != ownerGeneration || current.thread?.id != mutable.value.threadId) {
            ownerGeneration = current.generation
            epoch++
            buffers.clear()
            size = 0
            full = false
            mutable.value = RunOutputState(threadId = current.thread?.id)
        }
        val persisted = current.transcript?.persistedIds.orEmpty()
        val removed = buffers.keys.filter { it in persisted }
        for (id in removed) {
            val value = checkNotNull(buffers.remove(id))
            size -= value.text.length + value.runEventId.length
        }
        if (removed.isNotEmpty()) {
            full = false
            if (buffers.none { it.value.interrupted })
                mutable.value = mutable.value.copy(phase = RunOutputPhase.Waiting)
        }
        val run = current.transcript?.activeRunId
        if (buffers.any { it.value.runId != run }) {
            buffers.replaceAll { _, value ->
                if (value.runId != run) value.copy(interrupted = true) else value
            }
            mutable.value = mutable.value.copy(phase = RunOutputPhase.CatchingUp)
        }
        val thread = current.thread?.id
        demand.value =
            if (
                visible &&
                    authorized() &&
                    thread != null &&
                    run != null &&
                    current.source == ChatListSource.Network
            )
                RunOutputTarget(thread, run, epoch)
            else null
        publish()
    }

    fun transport(phase: RealtimePhase) {
        if (phase != RealtimePhase.Connected && buffers.isNotEmpty()) discontinuity()
    }

    fun receive(target: RunOutputTarget, signal: RunOutputSignal) {
        val current = history()
        if (
            closed ||
                !authorized() ||
                !visible ||
                demand.value != target ||
                current.thread?.id != target.threadId ||
                current.transcript?.activeRunId != target.runId ||
                current.source != ChatListSource.Network
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
                delta.eventId in current.transcript.persistedIds ||
                full
        )
            return
        val previous = buffers[delta.eventId]
        if (
            previous == null &&
                buffers.any { (_, value) ->
                    value.runId == delta.runId && value.runEventId == delta.runEventId
                }
        ) {
            discontinuity()
            return
        }
        if (
            previous != null &&
                (previous.runId != delta.runId ||
                    previous.runEventId != delta.runEventId ||
                    previous.interrupted)
        )
            return
        if (previous != null && delta.chunkIndex <= previous.index) return
        if (delta.chunkIndex != (previous?.index?.plus(1) ?: 0L)) {
            discontinuity()
            return
        }
        val added =
            delta.delta.length.toLong() + if (previous == null) delta.runEventId.length else 0
        if (added > MAX_CHARACTERS - size || previous == null && buffers.size >= MAX_MESSAGES) {
            full = true
            discontinuity()
            return
        }
        buffers[delta.eventId] =
            Buffer(
                delta.runId,
                delta.runEventId,
                previous?.text.orEmpty() + delta.delta,
                delta.chunkIndex,
            )
        size += added.toInt()
        mutable.value =
            mutable.value.copy(
                phase =
                    if (buffers.any { it.value.interrupted }) RunOutputPhase.CatchingUp
                    else RunOutputPhase.Live
            )
        publish()
    }

    private fun discontinuity() {
        buffers.replaceAll { _, value -> value.copy(interrupted = true) }
        val changed = mutable.value.phase != RunOutputPhase.CatchingUp
        mutable.value = mutable.value.copy(phase = RunOutputPhase.CatchingUp)
        if (changed) catchUp()
    }

    private fun publish() {
        mutable.value =
            mutable.value.copy(
                messages =
                    buffers.map { (id, value) ->
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

    companion object {
        const val MAX_CHARACTERS = 256 * 1024
        const val MAX_MESSAGES = 32
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
