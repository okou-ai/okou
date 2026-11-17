package ai.okou.android.chat

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchiveChatThreadsItemServiceTier
import ai.okou.android.api.generated.RecoveryBilling
import ai.okou.android.api.generated.RecoveryCatalog
import ai.okou.android.api.generated.RecoveryModelsModelsItemMemberEffectiveProviderType
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItemFramework
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItemType
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class FailureRecoveryData(
    val selection: RecoverySelection,
    val failure: AssistantFailure,
    val classification: FailureClassification,
    val catalog: RecoveryCatalog? = null,
    val account: RecoverySubscriptionsSubscriptionsItem? = null,
    val billing: RecoveryBilling? = null,
    val resetTimes: List<String> = emptyList(),
) {
    val resetAccount: RecoverySubscriptionsSubscriptionsItem?
        get() =
            account?.takeIf {
                classification.kind == FailureKind.Usage &&
                    classification.framework == RecoveryFramework.Codex &&
                    classification.limit != RecoveryLimit.Model &&
                    (it.subscriptionResetCredits?.let { credits -> credits > 0 } == true)
            }
}

data class FailureRecoveryState(
    val selection: RecoverySelection? = null,
    val phase: ChatReadPhase = ChatReadPhase.Idle,
    val data: FailureRecoveryData? = null,
)

class RecoveryUnavailable : Exception("The original recovery context is no longer eligible")

/** Owns replaceable failure reads only. The shared composer owns every business mutation. */
class AssistantRecoveryModel(
    internal val service: AssistantRecoveryService,
    internal val history: ConversationHistoryModel,
    private val controls: RunControlsModel,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {
    private val mutable = MutableStateFlow(FailureRecoveryState())
    val uiState = mutable.asStateFlow()
    private val sync = ConversationHistorySync(history.service, dispatcher)
    private var job: Job? = null
    private var revision = 0L
    private var closed = false

    internal val generation: Long
        get() = revision

    init {
        viewModelScope.launch {
            history.uiState.collect {
                val selected = selection()
                if (mutable.value.selection != selected) refresh()
            }
        }
    }

    fun selection(): RecoverySelection? {
        if (closed || !authorized()) return null
        val state = history.uiState.value
        val thread = state.thread ?: return null
        val checkpoint = history.checkpoint(thread.id) ?: return null
        val transcript = state.transcript ?: return null
        val failure = latestAssistantFailure(checkpoint, transcript) ?: return null
        return RecoverySelection(
            thread.id,
            thread.agentId,
            failure.id,
            thread.selectedModel,
            thread.serviceTier == ChatArchiveChatThreadsItemServiceTier.PRIORITY,
        )
    }

    fun refresh() {
        if (closed || !authorized()) return
        val selected = selection()
        val ticket = ++revision
        job?.cancel()
        mutable.value =
            FailureRecoveryState(
                selected,
                if (selected == null) ChatReadPhase.Idle else ChatReadPhase.Loading,
            )
        if (selected == null) return
        job =
            viewModelScope.launch {
                try {
                    val checkpoint =
                        history.checkpoint(selected.threadId) ?: throw RecoveryUnavailable()
                    val data = resources(selected, checkpoint)
                    requireCurrent(selected)
                    if (ticket == revision)
                        mutable.value = FailureRecoveryState(selected, ChatReadPhase.Ready, data)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (selection() == selected && ticket == revision) {
                        report(error)
                        if (selection() == selected)
                            mutable.value = FailureRecoveryState(selected, ChatReadPhase.Failed)
                    }
                }
            }
    }

    internal suspend fun requireCurrent(selected: RecoverySelection, generation: Long = revision) {
        currentCoroutineContext().ensureActive()
        if (selection() != selected || revision != generation) throw RecoveryUnavailable()
    }

    internal suspend fun requireWritable(selected: RecoverySelection, generation: Long) {
        requireCurrent(selected, generation)
        val journal = controls.uiState.value.journal ?: throw RecoveryUnavailable()
        if (journal.pending.any { it.threadId == selected.threadId }) throw RecoveryUnavailable()
    }

    /** Fresh command prerequisites never acquire/complete the history owner's detail query. */
    internal suspend fun validate(
        selected: RecoverySelection,
        generation: Long = revision,
    ): FailureRecoveryData {
        requireCurrent(selected, generation)
        val checkpoint = sync.synchronize(selected.threadId, history.checkpoint(selected.threadId))
        requireCurrent(selected, generation)
        val failure = withContext(dispatcher) { latestAssistantFailure(checkpoint) }
        if (failure?.id != selected.failureId) throw RecoveryUnavailable()
        val detail = history.service.threadDetail(selected.threadId)
        requireCurrent(selected, generation)
        if (detail.cancellationRecoveryPending) throw RecoveryUnavailable()
        requireWritable(selected, generation)
        return resources(selected, checkpoint).also { requireWritable(selected, generation) }
    }

    private suspend fun resources(
        selected: RecoverySelection,
        checkpoint: HistoryCheckpoint,
    ): FailureRecoveryData {
        val failure =
            withContext(dispatcher) { latestAssistantFailure(checkpoint) }
                ?.takeIf { it.id == selected.failureId } ?: throw RecoveryUnavailable()
        val initial = classifyFailure(failure, null)
        if (initial.kind == FailureKind.Billing)
            return FailureRecoveryData(
                selected,
                failure,
                initial,
                billing = service.recoveryBilling(),
            )
        if (!initial.canContinue && initial.kind != FailureKind.Unknown)
            return FailureRecoveryData(selected, failure, initial)
        if (initial.kind == FailureKind.Unknown && (failure.runFailure || selected.model == null))
            return FailureRecoveryData(selected, failure, initial)
        val (catalog, models) =
            coroutineScope {
                val catalog = async { service.recoveryCatalog() }
                val models = async { service.recoveryModels() }
                catalog.await() to models.await()
            }
        requireCurrent(selected)
        val route =
            selected.model?.let { selectedModel ->
                models.models
                    .firstOrNull { it.model == selectedModel }
                    ?.memberEffective
                    ?.providerType
            }
        val personal =
            when (route) {
                RecoveryModelsModelsItemMemberEffectiveProviderType.CODEX_OAUTH_TOKEN ->
                    RecoveryFramework.Codex
                RecoveryModelsModelsItemMemberEffectiveProviderType.CLAUDE_CODE_OAUTH_TOKEN ->
                    RecoveryFramework.Claude
                else -> null
            }
        val classification = classifyFailure(failure, personal)
        val account =
            if (
                classification.kind == FailureKind.Usage &&
                    personal != null &&
                    personal == classification.framework
            ) {
                service.recoverySubscriptions().subscriptions.firstOrNull {
                    it.isActive != false &&
                        !it.needsReconnect &&
                        (it.type == RecoverySubscriptionsSubscriptionsItemType.CODEX_OAUTH_TOKEN &&
                            route ==
                                RecoveryModelsModelsItemMemberEffectiveProviderType
                                    .CODEX_OAUTH_TOKEN ||
                            it.type ==
                                RecoverySubscriptionsSubscriptionsItemType
                                    .CLAUDE_CODE_OAUTH_TOKEN &&
                                route ==
                                    RecoveryModelsModelsItemMemberEffectiveProviderType
                                        .CLAUDE_CODE_OAUTH_TOKEN) &&
                        when (it.framework) {
                            RecoverySubscriptionsSubscriptionsItemFramework.CODEX ->
                                personal == RecoveryFramework.Codex
                            RecoverySubscriptionsSubscriptionsItemFramework.CLAUDE_CODE ->
                                personal == RecoveryFramework.Claude
                        }
                }
            } else null
        requireCurrent(selected)
        val usage = account?.subscriptionUsage
        val five = usage?.fiveHour
        val week = usage?.weekly
        val times = buildList {
            if (
                classification.limit == RecoveryLimit.FiveHour ||
                    classification.limit == RecoveryLimit.Unknown &&
                        (five?.remainingPercent == 0.0 ||
                            five?.usedPercent?.let { it >= 100 } == true)
            )
                five?.resetAt?.let(::add)
            if (
                classification.limit == RecoveryLimit.Weekly ||
                    classification.limit == RecoveryLimit.Unknown &&
                        (week?.remainingPercent == 0.0 ||
                            week?.usedPercent?.let { it >= 100 } == true)
            )
                week?.resetAt?.let(::add)
        }
        return FailureRecoveryData(
            selected,
            failure,
            classification,
            catalog,
            account,
            resetTimes = times,
        )
    }

    private fun report(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            onFailure(error)
    }

    override fun onCleared() {
        closed = true
        revision++
        job?.cancel()
    }
}
