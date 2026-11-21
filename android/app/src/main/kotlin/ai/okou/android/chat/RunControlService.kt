package ai.okou.android.chat

import ai.okou.android.api.generated.AcceptedInput
import ai.okou.android.api.generated.SendRequest
import ai.okou.android.api.generated.SendRequestVariant2
import ai.okou.android.api.generated.SendRequestVariant3
import kotlinx.serialization.Required
import kotlinx.serialization.Serializable

interface RunControlService : ConversationHistoryService {
    suspend fun sendControl(request: SendRequest): AcceptedInput
}

@Serializable
enum class RunControlKind {
    Interrupt,
    Revoke,
}

/** Frozen user intent. Restoration never dispatches it without a new explicit action. */
@Serializable
data class RunControlIntent(
    val id: String,
    val threadId: String,
    val agentId: String?,
    val kind: RunControlKind,
    val targetId: String,
) {
    fun request(): SendRequest =
        when (kind) {
            RunControlKind.Interrupt ->
                SendRequestVariant3(
                    threadId = threadId,
                    interruptsRunId = targetId,
                    clientEventId = id,
                )
            RunControlKind.Revoke ->
                SendRequestVariant2(
                    threadId = threadId,
                    revokesEventId = targetId,
                    clientEventId = id,
                )
        }
}

@Serializable
data class RunControlJournal(
    @Required val format: Int = 1,
    val pending: List<RunControlIntent> = emptyList(),
) {
    fun validate() {
        require(format == 1 && pending.map { it.id }.distinct().size == pending.size)
        require(
            pending.all {
                it.id.isNotEmpty() && it.threadId.isNotEmpty() && it.targetId.isNotEmpty()
            }
        )
    }
}

enum class RunControlEvidence {
    Recorded,
    TargetSettled,
    Eligible,
    Unknown,
    Invalid,
}

/** Absence is never proof of completion; the exact original target must supply evidence. */
fun controlEvidence(intent: RunControlIntent, checkpoint: HistoryCheckpoint): RunControlEvidence =
    RunControlObservation(checkpoint).evidence(intent)

/** One canonical projection/index for a batch of original control targets. */
internal class RunControlObservation(private val checkpoint: HistoryCheckpoint) {
    private val byId = checkpoint.rows.associateBy { it.id }
    private val replaced = checkpoint.rows.mapNotNullTo(hashSetOf()) { it.revokesId }
    private val facts = historyControlFacts(checkpoint)

    fun evidence(intent: RunControlIntent): RunControlEvidence {
        if (checkpoint.threadId != intent.threadId) return RunControlEvidence.Invalid
        val own = byId[intent.id]
        if (own != null) {
            val matches =
                when (intent.kind) {
                    RunControlKind.Interrupt ->
                        own.type == "control.interrupt" && own.runId == intent.targetId
                    RunControlKind.Revoke ->
                        own.type == "control.revoke" && own.revokesId == intent.targetId
                }
            return if (matches) RunControlEvidence.Recorded else RunControlEvidence.Invalid
        }
        return when (intent.kind) {
            RunControlKind.Interrupt ->
                when {
                    intent.targetId in facts.terminatedRunIds -> RunControlEvidence.TargetSettled
                    intent.targetId in facts.liveRunIds -> RunControlEvidence.Eligible
                    else -> RunControlEvidence.Unknown
                }
            RunControlKind.Revoke ->
                when {
                    intent.targetId in replaced -> RunControlEvidence.TargetSettled
                    byId[intent.targetId]?.runId != null -> RunControlEvidence.TargetSettled
                    intent.targetId in facts.queuedEventIds -> RunControlEvidence.Eligible
                    else -> RunControlEvidence.Unknown
                }
        }
    }
}
