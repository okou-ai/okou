package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatConnectorAccessAccountsItem
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import ai.okou.android.api.generated.ConnectorOverviewItemAccountsItem
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.isFreshMemorySnapshot
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** A draft choice or an absolute change to one chat account. */
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
    Failed,
}

internal data class ChatConnectorSave(
    val connectionId: String,
    val phase: ChatConnectorSavePhase,
    val pending: List<ChatConnectorOverride> = emptyList(),
) {
    val saving: Boolean
        get() = phase == ChatConnectorSavePhase.Saving

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
        get() = policySave?.takeIf { it.saving } ?: chatSaves[target] ?: policySave

    fun blockingPhase(key: String): ChatConnectorSavePhase? =
        chatSaves[key]?.takeIf { it.blocksSend }?.phase

    fun withChatSave(key: String, save: ChatConnectorSave?) =
        copy(chatSaves = if (save == null) chatSaves - key else chatSaves + (key to save))
}

private data class ConfirmedMemberPolicy(
    val value: ConnectorMemberPolicy?,
    val confirmedAt: TimeMark,
)

private class MemberPolicyRead(val accountIds: Set<String>, val job: Job)

/** The workspace owns member policies and the reads for the active composer. */
internal class ChatConnectorOptions(
    private val service: ConnectorService,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val clock: TimeSource,
    private val onError: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(ChatConnectorOptionsState())
    val state = mutable.asStateFlow()
    private var overviewRequest: Job? = null
    private val accountRequests = mutableMapOf<String, Job>()
    private val policyRequests = mutableMapOf<String, MemberPolicyRead>()
    private val recentPolicies = mutableMapOf<String, Map<String, ConfirmedMemberPolicy>>()
    private var targetGeneration = 0L
    private var readFailureRound = 0L

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
                policySave = previous.policySave?.takeIf { it.saving },
            )
    }

    fun invalidate(slug: String, changedConnection: String? = null) {
        changedConnection?.let { forgetPolicy(slug, it) }
        cancelDetails(slug)
        val previous = mutable.value
        if (previous.target == null) return
        overviewRequest?.cancel()
        overviewRequest = null
        mutable.value =
            previous.copy(
                overview = previous.overview.copy(confirmedAt = null),
                details = previous.details - slug,
                revision = previous.revision + 1,
            )
    }

    fun showOverview(target: ComposerTarget, opening: Boolean) {
        if (!canRead(target)) return
        val snapshot = mutable.value
        val previous = snapshot.overview
        val fresh = previous.forEntry()
        val active = overviewRequest?.isActive == true
        if (!opening && (fresh.data != null || active)) return
        val visible = if (opening) fresh else previous.confirmed()
        if (visible != previous) mutable.value = snapshot.copy(overview = visible)
        if (active) return
        val request =
            scope.launch(start = CoroutineStart.LAZY) {
                readOverview(target, previous.data)
            }
        overviewRequest = request
        request.start()
    }

    private suspend fun readOverview(
        target: ComposerTarget,
        previous: List<ChatConnectorSummary>?,
    ) {
        retryConnectorRead(
            read = { service.chatOverview(target.threadId) },
            canRead = { canRead(target) },
            onError = onError,
            publish = { next ->
                val snapshot = mutable.value
                val details =
                    if (next.data != null || next.failure == ConnectorReadFailure.Unavailable) {
                        val incoming = next.data.orEmpty().associateBy { it.entry.slug }
                        val old = previous.orEmpty().associateBy { it.entry.slug }
                        if (next.data != null) {
                            retainOverviewPolicies(incoming)
                            for (slug in policyRequests.keys - incoming.keys) cancelPolicyRead(slug)
                        }
                        val changed =
                            (snapshot.details.keys + accountRequests.keys).filter {
                                incoming[it] == null || incoming[it] != old[it]
                            }
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

    fun showAccounts(target: ComposerTarget, slug: String, opening: Boolean) {
        if (!canRead(target)) return
        val snapshot = mutable.value
        val summary = snapshot.overview.data?.find { it.entry.slug == slug } ?: return
        val previous = snapshot.details[slug] ?: ChatConnectorDetails()
        val visible =
            if (opening) {
                val accounts = previous.accounts.forEntry()
                val rows = accounts.data
                val policies =
                    if (rows?.memberAccess == false) ConnectorRead()
                    else
                        cachedPolicies(
                            slug,
                            rows?.accounts?.map { it.account.id }
                                ?: summary.accounts.map { it.connectionId },
                        )
                ChatConnectorDetails(accounts, policies)
            } else previous
        if (visible != previous) updateDetails(slug) { visible }
        if (visible.accounts.data != null) {
            showPolicies(target, slug)
            return
        }
        if (accountRequests[slug]?.isActive == true) return
        if (visible.accounts.failureRound != null)
            updateDetails(slug) { it.copy(accounts = it.accounts.confirmed()) }
        val memberAccess =
            snapshot.details.values.firstNotNullOfOrNull {
                it.accounts.forEntry().data?.memberAccess
            }
        val request =
            scope.launch(start = CoroutineStart.LAZY) {
                retryConnectorRead(
                    read = { service.chatAccounts(summary, memberAccess) },
                    canRead = { canRead(target) },
                    onError = onError,
                    publish = { next ->
                        val accounts = next.cached()
                        if (next.data?.memberAccess == false) {
                            recentPolicies.clear()
                            policyRequests.values.toList().forEach { it.job.cancel() }
                            policyRequests.clear()
                        } else if (next.failure == ConnectorReadFailure.Unavailable) {
                            recentPolicies.remove(slug)
                            cancelPolicyRead(slug)
                        }
                        updateDetails(slug) {
                            val policies =
                                when {
                                    next.failure == ConnectorReadFailure.Unavailable ||
                                        next.data?.memberAccess == false -> ConnectorRead()
                                    next.data != null ->
                                        cachedPolicies(
                                            slug,
                                            next.data.accounts.map { it.account.id },
                                        )
                                    else -> it.policies
                                }
                            it.copy(
                                accounts = accounts.retaining(it.accounts),
                                policies = policies,
                            )
                        }
                    },
                )
                showPolicies(target, slug)
            }
        accountRequests[slug] = request
        request.start()
    }

    private fun showPolicies(target: ComposerTarget, slug: String) {
        if (!canRead(target)) return
        val details = mutable.value.details[slug] ?: return
        val accounts = details.accounts.data ?: return
        if (!accounts.memberAccess) return
        val inFlight = policyRequests[slug]?.takeIf { it.job.isActive }
        if (inFlight != null) {
            if (accounts.accounts.all { it.account.id in inFlight.accountIds }) return
            // A newly observed account may be absent from the older policy response.
            cancelPolicyRead(slug)
        }
        if (accounts.accounts.isEmpty() || details.policies.confirmedAt != null) return
        val ids = accounts.accounts.mapTo(HashSet()) { it.account.id }
        val request =
            scope.launch(start = CoroutineStart.LAZY) {
                try {
                    retryConnectorRead(
                        read = { service.accountPolicies(slug) },
                        canRead = authorized,
                        onError = onError,
                        publish = { publishPolicies(slug, ids, it.cached()) },
                    )
                } finally {
                    if (policyRequests[slug]?.job === coroutineContext.job)
                        policyRequests.remove(slug)
                }
            }
        policyRequests[slug] = MemberPolicyRead(ids, request)
        request.start()
    }

    private fun publishPolicies(
        slug: String,
        requestedIds: Set<String>,
        read: ConnectorRead<Map<String, ConnectorMemberPolicy>>,
    ) {
        val current = mutable.value.details[slug]?.accounts?.data?.takeIf { it.memberAccess }
        val ids = current?.accounts?.map { it.account.id } ?: requestedIds
        val values = read.data
        if (values != null) {
            val confirmedAt = checkNotNull(read.confirmedAt)
            recentPolicies[slug] = ids.associateWith {
                ConfirmedMemberPolicy(values[it], confirmedAt)
            }
        } else if (read.failure == ConnectorReadFailure.Unavailable) {
            recentPolicies.remove(slug)
        }
        if (current != null) {
            updateDetails(slug) {
                val policies =
                    if (values == null) read.retaining(it.policies)
                    else read.copy(data = values.filterKeys(ids.toSet()::contains))
                it.copy(policies = policies)
            }
        }
    }

    private fun cachedPolicies(
        slug: String,
        ids: List<String>,
    ): ConnectorRead<Map<String, ConnectorMemberPolicy>> {
        val saved = recentPolicies[slug] ?: return ConnectorRead()
        val fresh = ids.mapNotNull { id ->
            saved[id]?.takeIf { it.confirmedAt.isFreshMemorySnapshot() }?.let { id to it }
        }
        val values = fresh.mapNotNull { (id, policy) -> policy.value?.let { id to it } }.toMap()
        val confirmedAt =
            fresh
                .takeIf { it.size == ids.size }
                ?.maxByOrNull { it.second.confirmedAt.elapsedNow() }
                ?.second
                ?.confirmedAt
        return ConnectorRead(
            data = values.takeIf { it.isNotEmpty() || confirmedAt != null },
            confirmedAt = confirmedAt,
        )
    }

    private fun retainOverviewPolicies(incoming: Map<String, ChatConnectorSummary>) {
        recentPolicies.entries.removeAll { entry ->
            val ids = incoming[entry.key]?.accounts.orEmpty().mapTo(HashSet()) { it.connectionId }
            val retained =
                entry.value.filter { (id, policy) ->
                    id in ids && policy.confirmedAt.isFreshMemorySnapshot()
                }
            if (retained.isNotEmpty()) entry.setValue(retained)
            retained.isEmpty()
        }
    }

    private fun forgetPolicy(slug: String, connectionId: String) {
        val saved = recentPolicies[slug] ?: return
        val retained = saved - connectionId
        if (retained.isEmpty()) recentPolicies.remove(slug) else recentPolicies[slug] = retained
    }

    private fun cancelDetails(slug: String) {
        accountRequests.remove(slug)?.cancel()
        cancelPolicyRead(slug)
    }

    private fun cancelPolicyRead(slug: String) {
        policyRequests.remove(slug)?.job?.cancel()
    }

    fun dismissFailure(target: ComposerTarget) {
        val snapshot = mutable.value
        val save = snapshot.save ?: return
        if (!current(target) || save.saving) return
        mutable.value =
            if (snapshot.policySave != null) snapshot.copy(policySave = null)
            else snapshot.withChatSave(target.key, null)
    }

    fun blocksSend(target: ComposerTarget): Boolean =
        mutable.value.blockingPhase(target.key) != null

    fun save(target: ComposerTarget, slug: String, changes: List<ChatConnectorOverride>) {
        val threadId = target.threadId ?: return
        if (!current(target) || changes.isEmpty() || saveInProgress()) return
        val snapshot = mutable.value
        if (snapshot.details[slug]?.accounts?.data?.memberAccess != false) return
        overviewRequest?.cancel()
        for (choice in changes) cancelDetails(choice.slug)
        val key = target.key
        val first =
            ChatConnectorSave(changes.first().connectionId, ChatConnectorSavePhase.Saving, changes)
        mutable.value =
            snapshot
                .withChatSave(key, first)
                .copy(revision = snapshot.revision + 1, policySave = null)
        scope.launch {
            for ((index, choice) in changes.withIndex()) {
                if (!authorized()) return@launch
                val accounts =
                    try {
                        service.setChatOverride(threadId, choice)
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        onError(error)
                        if (authorized()) {
                            val snapshot = mutable.value
                            val failure =
                                ChatConnectorSave(
                                    choice.connectionId,
                                    ChatConnectorSavePhase.Failed,
                                )
                            mutable.value =
                                snapshot.withChatSave(
                                    key,
                                    failure.takeIf { snapshot.target == key },
                                )
                        }
                        return@launch
                    }
                if (!authorized()) return@launch
                val remaining = changes.subList(index + 1, changes.size)
                applyWriteReceipt(
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

    private fun applyWriteReceipt(
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
        // The scoped response lacks the metadata needed to display newly connected accounts.
        val retainedAccountCount =
            overview?.find { it.entry.slug == choice.slug }?.accounts?.size ?: 0
        val hasNewAccounts = accounts.size > retainedAccountCount
        val overviewConfirmation = snapshot.overview.confirmedAt.takeUnless { hasNewAccounts }
        val details = snapshot.details[choice.slug]
        val existing = details?.accounts?.data
        val confirmedDetails =
            if (hasNewAccounts || accounts.isEmpty()) snapshot.details - choice.slug
            else if (existing == null) snapshot.details
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
                    overview =
                        snapshot.overview.copy(data = overview, confirmedAt = overviewConfirmation),
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
        cancelDetails(slug)
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
                    if (authorized()) {
                        if (error is ApiFailure.Http && error.status in 403..404) {
                            forgetPolicy(slug, connectionId)
                            if (mutable.value.details[slug] != null)
                                updateDetails(slug) {
                                    it.copy(
                                        policies =
                                            it.policies.copy(
                                                data = it.policies.data?.minus(connectionId),
                                                confirmedAt = null,
                                            ),
                                    )
                                }
                        }
                        mutable.value =
                            mutable.value.copy(
                                policySave =
                                    saving.copy(phase = ChatConnectorSavePhase.Failed).takeIf {
                                        active()
                                    },
                            )
                    }
                    return@launch
                }
            if (!authorized()) return@launch
            applyPolicyReceipt(slug, connectionId, saved)
            mutable.value = mutable.value.copy(policySave = null)
        }
    }

    fun applyPolicyReceipt(slug: String, connectionId: String, value: ConnectorMemberPolicy) {
        if (!authorized()) return
        cancelPolicyRead(slug)
        recentPolicies[slug] =
            recentPolicies[slug].orEmpty() +
                (connectionId to ConfirmedMemberPolicy(value, clock.markNow()))
        val accounts = mutable.value.details[slug]?.accounts?.data ?: return
        if (!accounts.memberAccess || accounts.accounts.none { it.account.id == connectionId })
            return
        updateDetails(slug) {
            it.copy(
                policies =
                    it.policies.copy(data = it.policies.data.orEmpty() + (connectionId to value)),
            )
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

    private fun saveInProgress() = mutable.value.save?.saving == true

    private fun <T> ConnectorRead<T>.cached() =
        when {
            data != null -> copy(confirmedAt = clock.markNow())
            failure == ConnectorReadFailure.Unavailable -> this
            else -> copy(failureRound = ++readFailureRound)
        }

    private fun current(target: ComposerTarget) = authorized() && mutable.value.target == target.key
}
