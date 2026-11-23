package ai.okou.android.connectors

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatConnectorAccessAccountsItem
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
)

internal data class ChatConnectorSave(val choice: ChatConnectorOverride, val saving: Boolean)

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
        readRevision++
        mutable.value = mutable.value.copy(save = ChatConnectorSave(changes.first(), saving = true))
        scope.launch {
            for (choice in changes) {
                if (!current(target)) return@launch
                mutable.value = mutable.value.copy(save = ChatConnectorSave(choice, saving = true))
                val accounts = confirmChange(threadId, choice)
                if (!current(target)) return@launch
                val snapshot = mutable.value
                if (accounts == null) {
                    mutable.value = snapshot.copy(save = ChatConnectorSave(choice, saving = false))
                    return@launch
                }
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

    private fun current(target: ComposerTarget) = authorized() && mutable.value.target == target.key

    private suspend fun confirmChange(
        threadId: String,
        choice: ChatConnectorOverride,
    ): List<ChatConnectorAccessAccountsItem>? =
        try {
            service.setChatOverride(threadId, choice)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            onError(error)
            // A lost response can follow a committed write. Check this account without replaying
            // it.
            if (
                authorized() &&
                    (error is ApiFailure.Network && !error.connectionFailed() ||
                        error is ApiFailure.IncompatibleResponse ||
                        error is ApiFailure.Http && (error.status >= 500 || error.status == 408))
            )
                readBack(threadId, choice)
            else null
        }

    private suspend fun readBack(threadId: String, choice: ChatConnectorOverride) =
        try {
            service.chatAccess(threadId, choice.slug).takeIf { accounts ->
                accounts.find { it.connectionId == choice.connectionId }?.overrideEnabled ==
                    choice.enabled
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            onError(error)
            null
        }
}
