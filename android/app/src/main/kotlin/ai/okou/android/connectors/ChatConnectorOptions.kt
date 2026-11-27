package ai.okou.android.connectors

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
}

internal data class ChatConnectorSave(
    val connectionId: String,
    val phase: ChatConnectorSavePhase,
    val pending: List<ChatConnectorOverride> = emptyList(),
) {
    val saving: Boolean
        get() = phase == ChatConnectorSavePhase.Saving || phase == ChatConnectorSavePhase.Checking
}

internal data class ChatConnectorOptionsState(
    val target: String? = null,
    val overview: ConnectorRead<List<ChatConnectorSummary>> = ConnectorRead(),
    val details: Map<String, ChatConnectorDetails> = emptyMap(),
    val revision: Long = 0,
    val save: ChatConnectorSave? = null,
)

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

    fun activate(key: String?) {
        val previous = mutable.value
        if (previous.target == key) return
        overviewRequest?.cancel()
        overviewRequest = null
        accountRequests.values.forEach { it.cancel() }
        accountRequests.clear()
        mutable.value = ChatConnectorOptionsState(target = key, revision = previous.revision + 1)
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
        if (current(target) && mutable.value.save?.saving != true)
            mutable.value = mutable.value.copy(save = null)
    }

    fun save(target: ComposerTarget, slug: String, changes: List<ChatConnectorOverride>) {
        val threadId = target.threadId ?: return
        if (!current(target) || changes.isEmpty() || mutable.value.save?.saving == true) return
        if (mutable.value.details[slug]?.accounts?.data?.memberAccess != false) return
        mutable.value =
            mutable.value.copy(
                save =
                    ChatConnectorSave(
                        changes.first().connectionId,
                        ChatConnectorSavePhase.Saving,
                        changes,
                    ),
            )
        scope.launch {
            for ((index, choice) in changes.withIndex()) {
                if (!current(target)) return@launch
                val saving =
                    ChatConnectorSave(
                        choice.connectionId,
                        ChatConnectorSavePhase.Saving,
                        changes.subList(index, changes.size),
                    )
                mutable.value = mutable.value.copy(save = saving)
                val accounts =
                    try {
                        service.setChatOverride(
                            threadId,
                            choice,
                            canReadBack = { current(target) },
                            onChecking = {
                                mutable.value =
                                    mutable.value.copy(
                                        save = saving.copy(phase = ChatConnectorSavePhase.Checking),
                                    )
                            },
                        )
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        onError(error)
                        if (current(target)) {
                            val snapshot = mutable.value
                            val phase =
                                if (snapshot.save?.phase == ChatConnectorSavePhase.Checking)
                                    ChatConnectorSavePhase.Unconfirmed
                                else ChatConnectorSavePhase.Failed
                            mutable.value =
                                snapshot.copy(
                                    save = saving.copy(phase = phase, pending = emptyList()),
                                )
                        }
                        return@launch
                    }
                if (!current(target)) return@launch
                val snapshot = mutable.value
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
                mutable.value = snapshot.copy(overview = snapshot.overview.copy(data = overview))
                if (choice.slug in snapshot.details)
                    updateDetails(choice.slug) { details ->
                        val data = details.accounts.data ?: return@updateDetails details
                        val rows =
                            data.accounts.mapNotNull { row ->
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
                        details.copy(
                            accounts = details.accounts.copy(data = data.copy(accounts = rows)),
                        )
                    }
            }
            if (current(target)) mutable.value = mutable.value.copy(save = null)
        }
    }

    fun savePolicy(
        target: ComposerTarget,
        slug: String,
        connectionId: String,
        policy: ConnectorAccountPolicyRequestPolicy,
    ) {
        if (!current(target) || mutable.value.save?.saving == true) return
        val details = mutable.value.details[slug] ?: return
        val accounts = details.accounts.data ?: return
        if (!accounts.memberAccess || details.policies.data?.containsKey(connectionId) != true)
            return
        if (accounts.accounts.none { it.account.id == connectionId }) return
        val saving = ChatConnectorSave(connectionId, ChatConnectorSavePhase.Saving)
        mutable.value = mutable.value.copy(save = saving)
        scope.launch {
            val saved =
                try {
                    service.setAccountPolicy(slug, connectionId, policy)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    onError(error)
                    if (current(target)) {
                        mutable.value =
                            mutable.value.copy(
                                save = saving.copy(phase = ChatConnectorSavePhase.Failed),
                            )
                    }
                    return@launch
                }
            if (!current(target)) return@launch
            updateDetails(slug) {
                it.copy(
                    policies =
                        it.policies.copy(
                            data = it.policies.data.orEmpty() + (connectionId to saved),
                        ),
                )
            }
            mutable.value = mutable.value.copy(save = null)
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

    private fun <T> ConnectorRead<T>.cached() =
        if (data == null) this else copy(expiresAt = TimeSource.Monotonic.markNow() + 10.minutes)

    private fun current(target: ComposerTarget) = authorized() && mutable.value.target == target.key
}
