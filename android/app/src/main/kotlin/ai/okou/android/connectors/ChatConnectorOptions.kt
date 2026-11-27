package ai.okou.android.connectors

import ai.okou.android.api.generated.ChatConnectorAccessAccountsItem
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import ai.okou.android.api.generated.ConnectorOverviewItemAccountsItem
import ai.okou.android.chat.ComposerTarget
import kotlin.time.Duration.Companion.minutes
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** A draft choice or an absolute, replayable change to one chat account. */
@Serializable
data class ChatConnectorOverride(val slug: String, val connectionId: String, val enabled: Boolean?)

internal data class ChatConnectorAccount(
    val account: ConnectorSavedAccount,
    val override: Boolean?,
)

internal data class ChatConnectorSummary(
    val entry: ConnectorEntry,
    val accounts: List<ConnectorOverviewItemAccountsItem>,
) {
    fun overrides() = accounts.mapNotNull { account ->
        account.overrideEnabled?.let {
            ChatConnectorOverride(entry.slug, account.connectionId, null)
        }
    }
}

internal data class ChatConnectorAccounts(
    val accounts: List<ChatConnectorAccount>,
    val memberAccess: Boolean,
)

internal data class ChatConnectorDetails(
    val accounts: ConnectorRead<ChatConnectorAccounts> = ConnectorRead(),
    val policies: ConnectorRead<Map<String, ConnectorMemberPolicy>> = ConnectorRead(),
)

internal enum class ChatConnectorSavePhase {
    Saving,
    Checking,
    Unconfirmed,
    Failed,
    AccountUnavailable,
}

internal data class ChatConnectorSave(
    val connectionId: String,
    val phase: ChatConnectorSavePhase,
    val pending: List<ChatConnectorOverride> = emptyList(),
) {
    val saving: Boolean
        get() = phase == ChatConnectorSavePhase.Saving || phase == ChatConnectorSavePhase.Checking

    val blocksSend: Boolean
        get() = pending.isNotEmpty()
}

internal data class ChatConnectorOptionsState(
    val target: String? = null,
    val overview: ConnectorRead<List<ChatConnectorSummary>> = ConnectorRead(),
    val details: Map<String, ChatConnectorDetails> = emptyMap(),
    val revision: Long = 0,
    val chatSaves: Map<String, ChatConnectorSave> = emptyMap(),
    val policySave: ChatConnectorSave? = null,
) {
    val save: ChatConnectorSave?
        get() = chatSaves[target] ?: policySave

    fun blockingPhase(key: String): ChatConnectorSavePhase? =
        chatSaves[key]?.takeIf { it.blocksSend }?.phase

    fun withChatSave(key: String, save: ChatConnectorSave?) =
        copy(chatSaves = if (save == null) chatSaves - key else chatSaves + (key to save))
}

/** The workspace owns writes and keeps confirmed reads for the active composer. */
internal class ChatConnectorOptions(
    private val service: ConnectorService,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val onError: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(ChatConnectorOptionsState())
    val state = mutable.asStateFlow()
    private var overviewRequest: Job? = null
    private val accountRequests = mutableMapOf<String, Job>()
    private var targetGeneration = 0L

    fun activate(key: String?) {
        val previous = mutable.value
        if (previous.target == key) return
        targetGeneration++
        overviewRequest?.cancel()
        overviewRequest = null
        accountRequests.values.forEach { it.cancel() }
        accountRequests.clear()
        mutable.value =
            ChatConnectorOptionsState(
                target = key,
                revision = previous.revision + 1,
                chatSaves = previous.chatSaves.filterValues { it.blocksSend },
            )
    }

    fun invalidate(slug: String) {
        val previous = mutable.value
        if (previous.target == null) return
        overviewRequest?.cancel()
        overviewRequest = null
        accountRequests.remove(slug)?.cancel()
        mutable.value =
            previous.copy(
                overview = previous.overview.copy(expiresAt = null),
                details = previous.details - slug,
                revision = previous.revision + 1,
            )
    }

    fun showOverview(target: ComposerTarget) {
        if (!current(target) || overviewRequest?.isActive == true) return
        if (mutable.value.overview.forEntry().data != null) return
        val request = scope.launch(start = CoroutineStart.LAZY) { readOverview(target) }
        overviewRequest = request
        request.start()
    }

    private suspend fun readOverview(target: ComposerTarget) {
        retryConnectorRead(
            read = { service.chatOverview(target.threadId) },
            canRead = { canRead(target) },
            onError = onError,
            publish = { next ->
                val snapshot = mutable.value
                val details =
                    if (next.data != null || next.failure == ConnectorReadFailure.Unavailable) {
                        val incoming = next.data.orEmpty().associateBy { it.entry.slug }
                        val old = snapshot.overview.data.orEmpty().associateBy { it.entry.slug }
                        val changed = old.keys.filterTo(mutableSetOf()) { incoming[it] != old[it] }
                        for (slug in changed) accountRequests.remove(slug)?.cancel()
                        snapshot.details - changed
                    } else snapshot.details
                mutable.value =
                    snapshot.copy(
                        overview = next.cached().retaining(snapshot.overview),
                        details = details,
                    )
            },
        )
    }

    fun showAccounts(target: ComposerTarget, slug: String) {
        if (!current(target) || accountRequests[slug]?.isActive == true) return
        val request = scope.launch(start = CoroutineStart.LAZY) { readAccounts(target, slug) }
        accountRequests[slug] = request
        request.start()
    }

    private suspend fun readAccounts(target: ComposerTarget, slug: String) {
        val snapshot = mutable.value
        val summary = snapshot.overview.data?.find { it.entry.slug == slug } ?: return
        val previous = snapshot.details[slug] ?: ChatConnectorDetails()
        if (previous.accounts.forEntry().data == null) {
            val memberAccess =
                snapshot.details.values.firstNotNullOfOrNull {
                    it.accounts.forEntry().data?.memberAccess
                }
            retryConnectorRead(
                read = { service.chatAccounts(summary, memberAccess) },
                canRead = { canRead(target) },
                onError = onError,
                publish = { next ->
                    updateDetails(slug) {
                        it.copy(accounts = next.cached().retaining(it.accounts))
                    }
                },
            )
        }
        val details = mutable.value.details[slug] ?: return
        if (
            details.accounts.forEntry().data?.memberAccess == true &&
                details.policies.forEntry().data == null
        ) {
            retryConnectorRead(
                read = { service.accountPolicies(slug) },
                canRead = { canRead(target) },
                onError = onError,
                publish = { next ->
                    updateDetails(slug) {
                        it.copy(policies = next.cached().retaining(it.policies))
                    }
                },
            )
        }
    }

    fun dismissFailure(target: ComposerTarget) {
        val snapshot = mutable.value
        val save = snapshot.save ?: return
        if (!current(target) || save.saving || save.blocksSend) return
        mutable.value =
            if (snapshot.policySave != null) snapshot.copy(policySave = null)
            else snapshot.withChatSave(target.key, null)
    }

    fun blocksSend(target: ComposerTarget): Boolean =
        mutable.value.blockingPhase(target.key) != null

    fun save(target: ComposerTarget, slug: String, changes: List<ChatConnectorOverride>) {
        val threadId = target.threadId ?: return
        if (!current(target) || changes.isEmpty() || saveInProgress()) return
        if (mutable.value.details[slug]?.accounts?.data?.memberAccess != false) return
        overviewRequest?.cancel()
        for (choice in changes) accountRequests.remove(choice.slug)?.cancel()
        val key = target.key
        val first =
            ChatConnectorSave(changes.first().connectionId, ChatConnectorSavePhase.Saving, changes)
        mutable.value = mutable.value.withChatSave(key, first).copy(policySave = null)
        scope.launch {
            for ((index, choice) in changes.withIndex()) {
                if (!authorized()) return@launch
                val accounts =
                    try {
                        service.setChatOverride(
                            threadId,
                            choice,
                            canReadBack = authorized,
                            onChecking = {
                                mutable.value =
                                    mutable.value.withChatSave(
                                        key,
                                        ChatConnectorSave(
                                            choice.connectionId,
                                            ChatConnectorSavePhase.Checking,
                                            changes.subList(index, changes.size),
                                        ),
                                    )
                            },
                        )
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        onError(error)
                        if (authorized()) {
                            val snapshot = mutable.value
                            val result =
                                when {
                                    snapshot.chatSaves[key]?.phase ==
                                        ChatConnectorSavePhase.Checking ->
                                        ChatConnectorSave(
                                            choice.connectionId,
                                            ChatConnectorSavePhase.Unconfirmed,
                                            listOf(choice),
                                        )
                                    snapshot.target == key ->
                                        ChatConnectorSave(
                                            choice.connectionId,
                                            ChatConnectorSavePhase.Failed,
                                        )
                                    else -> null
                                }
                            mutable.value = snapshot.withChatSave(key, result)
                        }
                        return@launch
                    }
                if (!authorized()) return@launch
                val remaining = changes.subList(index + 1, changes.size)
                applyReadback(
                    key,
                    choice,
                    accounts,
                    remaining.firstOrNull()?.let {
                        ChatConnectorSave(it.connectionId, ChatConnectorSavePhase.Saving, remaining)
                    },
                )
            }
        }
    }

    fun checkSave(target: ComposerTarget) {
        val threadId = target.threadId ?: return
        val snapshot = mutable.value
        val save = snapshot.save ?: return
        val choice = save.pending.singleOrNull() ?: return
        if (!current(target) || save.phase != ChatConnectorSavePhase.Unconfirmed) return
        overviewRequest?.cancel()
        accountRequests.remove(choice.slug)?.cancel()
        val key = target.key
        mutable.value =
            snapshot.withChatSave(key, save.copy(phase = ChatConnectorSavePhase.Checking))
        scope.launch {
            val accounts =
                try {
                    service.chatAccess(threadId, choice.slug)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    onError(error)
                    if (authorized()) mutable.value = mutable.value.withChatSave(key, save)
                    return@launch
                }
            if (!authorized()) return@launch
            val account = accounts.firstOrNull { it.connectionId == choice.connectionId }
            val result =
                when {
                    account == null ->
                        ChatConnectorSave(
                            choice.connectionId,
                            ChatConnectorSavePhase.AccountUnavailable,
                        )
                    account.overrideEnabled == choice.enabled -> null
                    // The original write can still land after an unchanged readback.
                    else -> save
                }
            applyReadback(key, choice, accounts, result)
        }
    }

    private fun applyReadback(
        key: String,
        choice: ChatConnectorOverride,
        accounts: List<ChatConnectorAccessAccountsItem>,
        save: ChatConnectorSave?,
    ) {
        val snapshot = mutable.value
        if (snapshot.target != key) {
            mutable.value = snapshot.withChatSave(key, save?.takeIf { it.blocksSend })
            return
        }
        val byId = accounts.associateBy { it.connectionId }
        val overview =
            snapshot.overview.data?.mapNotNull { summary ->
                if (summary.entry.slug != choice.slug) return@mapNotNull summary
                val updated =
                    summary.accounts.mapNotNull row@{ row ->
                        val account = byId[row.connectionId] ?: return@row null
                        row.copy(
                            displayName = account.displayName,
                            defaultEnabled = account.defaultEnabled,
                            isDefault = account.isDefault,
                            overrideEnabled = account.overrideEnabled,
                            enabled = account.enabled,
                        )
                    }
                summary.copy(accounts = updated).takeIf { updated.isNotEmpty() }
            }
        val details = snapshot.details[choice.slug]
        val existing = details?.accounts?.data
        val confirmedDetails =
            if (existing == null) snapshot.details
            else {
                val rows =
                    existing.accounts.mapNotNull { row ->
                        byId[row.account.id]?.let { account ->
                            ChatConnectorAccount(
                                row.account.copy(
                                    displayName = account.displayName,
                                    defaultEnabled = account.defaultEnabled,
                                ),
                                account.overrideEnabled,
                            )
                        }
                    }
                snapshot.details +
                    (choice.slug to
                        details.copy(
                            accounts = details.accounts.copy(data = existing.copy(accounts = rows)),
                        ))
            }
        mutable.value =
            snapshot
                .withChatSave(key, save)
                .copy(
                    overview = snapshot.overview.copy(data = overview),
                    details = confirmedDetails,
                )
    }

    fun savePolicy(
        target: ComposerTarget,
        slug: String,
        connectionId: String,
        policy: ConnectorAccountPolicyRequestPolicy,
    ) {
        if (!current(target) || saveInProgress()) return
        val details = mutable.value.details[slug] ?: return
        val accounts = details.accounts.data ?: return
        if (!accounts.memberAccess || details.policies.data?.containsKey(connectionId) != true)
            return
        if (accounts.accounts.none { it.account.id == connectionId }) return
        accountRequests.remove(slug)?.cancel()
        val generation = targetGeneration
        fun active() = current(target) && targetGeneration == generation
        val saving = ChatConnectorSave(connectionId, ChatConnectorSavePhase.Saving)
        mutable.value = mutable.value.withChatSave(target.key, null).copy(policySave = saving)
        scope.launch {
            val saved =
                try {
                    service.setAccountPolicy(slug, connectionId, policy)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    onError(error)
                    if (active()) {
                        mutable.value =
                            mutable.value.copy(
                                policySave = saving.copy(phase = ChatConnectorSavePhase.Failed),
                            )
                    }
                    return@launch
                }
            if (!active()) return@launch
            updateDetails(slug) {
                it.copy(
                    policies =
                        it.policies.copy(
                            data = it.policies.data.orEmpty() + (connectionId to saved),
                        ),
                )
            }
            mutable.value = mutable.value.copy(policySave = null)
        }
    }

    private fun updateDetails(
        slug: String,
        update: (ChatConnectorDetails) -> ChatConnectorDetails,
    ) {
        val snapshot = mutable.value
        val current = snapshot.details[slug] ?: ChatConnectorDetails()
        mutable.value = snapshot.copy(details = snapshot.details + (slug to update(current)))
    }

    private fun canRead(target: ComposerTarget) =
        current(target) && mutable.value.save?.saving != true

    private fun saveInProgress() = mutable.value.save?.let { it.saving || it.blocksSend } == true

    private fun <T> ConnectorRead<T>.cached() =
        if (data == null) this else copy(expiresAt = TimeSource.Monotonic.markNow() + 10.minutes)

    private fun current(target: ComposerTarget) = authorized() && mutable.value.target == target.key
}
