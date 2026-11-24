package ai.okou.android.connectors

import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import ai.okou.android.chat.ComposerTarget
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
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

internal data class ChatConnectorGroup(
    val entry: ConnectorEntry,
    val accounts: List<ChatConnectorAccount>,
    val memberAccess: Boolean = false,
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
) {
    val saving: Boolean
        get() = phase == ChatConnectorSavePhase.Saving || phase == ChatConnectorSavePhase.Checking
}

internal data class ChatConnectorOptionsState(
    val target: String? = null,
    val read: ConnectorRead<List<ChatConnectorGroup>> = ConnectorRead(),
    val save: ChatConnectorSave? = null,
)

/** The workspace owns writes. Read demand follows the visible account picker. */
internal class ChatConnectorOptions(
    private val service: ConnectorService,
    private val scope: CoroutineScope,
    private val authorized: () -> Boolean,
    private val onError: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(ChatConnectorOptionsState())
    val state = mutable.asStateFlow()
    private var readRevision = 0L

    suspend fun show(target: ComposerTarget, offline: Boolean) {
        if (!authorized()) return
        if (mutable.value.target != target.key)
            mutable.value = ChatConnectorOptionsState(target.key)
        if (mutable.value.save?.saving == true) return
        val revision = ++readRevision
        if (offline) return
        retryConnectorRead(
            read = { service.chatAccounts(target.threadId) },
            canRead = { current(target) && revision == readRevision },
            onError = onError,
            publish = { next ->
                val previous = mutable.value
                mutable.value = previous.copy(read = next.retaining(previous.read))
            },
        )
    }

    fun close(target: ComposerTarget) {
        if (mutable.value.target != target.key || mutable.value.save?.saving == true) return
        readRevision++
        mutable.value = ChatConnectorOptionsState()
    }

    fun save(target: ComposerTarget, changes: List<ChatConnectorOverride>) {
        val threadId = target.threadId ?: return
        if (!current(target) || changes.isEmpty() || mutable.value.save?.saving == true) return
        if (mutable.value.read.data.orEmpty().any { it.memberAccess }) return
        readRevision++
        mutable.value =
            mutable.value.copy(
                save =
                    ChatConnectorSave(changes.first().connectionId, ChatConnectorSavePhase.Saving),
            )
        scope.launch {
            for (choice in changes) {
                if (!current(target)) return@launch
                val saving = ChatConnectorSave(choice.connectionId, ChatConnectorSavePhase.Saving)
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
                            mutable.value = snapshot.copy(save = saving.copy(phase = phase))
                        }
                        return@launch
                    }
                if (!current(target)) return@launch
                val snapshot = mutable.value
                val byId = accounts.associateBy { it.connectionId }
                val groups =
                    snapshot.read.data.orEmpty().mapNotNull { group ->
                        if (group.entry.slug != choice.slug) return@mapNotNull group
                        val updated =
                            group.accounts.mapNotNull row@{ row ->
                                val account = byId[row.account.id] ?: return@row null
                                ChatConnectorAccount(
                                    row.account.copy(
                                        displayName = account.displayName,
                                        defaultEnabled = account.defaultEnabled,
                                    ),
                                    account.overrideEnabled,
                                )
                            }
                        group.copy(accounts = updated).takeIf { updated.isNotEmpty() }
                    }
                mutable.value = snapshot.copy(read = snapshot.read.copy(data = groups))
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
        val group = mutable.value.read.data?.find { it.entry.slug == slug } ?: return
        if (!group.memberAccess || group.accounts.none { it.account.id == connectionId }) return
        readRevision++
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
            val snapshot = mutable.value
            val groups =
                snapshot.read.data.orEmpty().map { entry ->
                    if (entry.entry.slug != slug) return@map entry
                    entry.copy(
                        accounts =
                            entry.accounts.map { row ->
                                if (row.account.id == connectionId)
                                    row.copy(account = row.account.copy(policy = saved))
                                else row
                            },
                    )
                }
            mutable.value = snapshot.copy(read = snapshot.read.copy(data = groups), save = null)
        }
    }

    private fun current(target: ComposerTarget) = authorized() && mutable.value.target == target.key
}
