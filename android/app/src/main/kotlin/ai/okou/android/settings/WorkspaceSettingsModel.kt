package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.RecoveryBillingCreditBreakdownItem
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItemType
import ai.okou.android.api.generated.UsagePackCredits
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.state.SettingsDestination
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

internal enum class ModelAccountProvider {
    ChatGPT,
    Claude,
}

internal val RecoverySubscriptionsSubscriptionsItem.provider: ModelAccountProvider?
    get() =
        when (type) {
            RecoverySubscriptionsSubscriptionsItemType.CODEX_OAUTH_TOKEN ->
                ModelAccountProvider.ChatGPT
            RecoverySubscriptionsSubscriptionsItemType.CLAUDE_CODE_OAUTH_TOKEN ->
                ModelAccountProvider.Claude
            RecoverySubscriptionsSubscriptionsItemType.OPENROUTER_CODEX,
            RecoverySubscriptionsSubscriptionsItemType.BUILT_IN -> null
        }

internal data class SettingsRead<T>(
    val value: T? = null,
    val unavailable: Boolean = false,
    val readAt: Long? = null,
    val refreshing: Boolean = false,
) {
    val initialFailure: Boolean
        get() = value == null && unavailable
}

private const val staleAfterMillis = 10 * 60_000L
private const val maxReadAttempts = 3
private const val readRetryDelayMillis = 3_000L
private val accountsSerializer = ListSerializer(RecoverySubscriptionsSubscriptionsItem.serializer())

internal enum class WorkspaceSettingsResource(val cacheKey: String) {
    Accounts("accounts"),
    UsagePack("usage-pack"),
    WorkspaceCredits("workspace-credits"),
}

@Serializable
internal data class WorkspaceCreditSummary(
    val credits: Double,
    val creditBreakdown: List<RecoveryBillingCreditBreakdownItem>,
)

internal data class WorkspaceSettingsState(
    val accounts: SettingsRead<List<RecoverySubscriptionsSubscriptionsItem>> = SettingsRead(),
    val usagePack: SettingsRead<UsagePackCredits> = SettingsRead(),
    val workspaceCredits: SettingsRead<WorkspaceCreditSummary> = SettingsRead(),
    val switching: Map<ModelAccountProvider, String> = emptyMap(),
    val switchFailures: Set<ModelAccountProvider> = emptySet(),
    val offline: Boolean = false,
)

/** Lives with the authorized workspace. Reading settings never participates in startup. */
class WorkspaceSettingsModel
internal constructor(
    private val service: WorkspaceSession,
    private val identity: WorkspaceIdentity,
    defaultModelStore: DefaultModelStore,
    internal val showWorkspaceCredits: Boolean,
    private val authorized: () -> Boolean,
    private val onSessionFailure: (Exception) -> Unit,
    connectivity: Flow<Boolean>,
    private val cache: WorkspaceSettingsCache? = null,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val mutable = MutableStateFlow(WorkspaceSettingsState())
    internal val uiState = mutable.asStateFlow()
    internal val defaultModel =
        DefaultModelSettings(viewModelScope, service, identity, defaultModelStore, authorized) {
            reportSessionFailure(it)
        }

    private var visible: SettingsDestination? = null
    private var restore: Job? = null
    private var restored = cache == null
    private var accountsRead: Job? = null
    private var usagePackRead: Job? = null
    private var workspaceCreditsRead: Job? = null
    private val verifying = mutableSetOf<ModelAccountProvider>()
    private val refreshTokens = mutableMapOf<WorkspaceSettingsResource, Any>()

    init {
        viewModelScope.launch {
            connectivity.collect { online ->
                defaultModel.online(online)
                val changed = mutable.value.offline == online
                mutable.update { it.copy(offline = !online) }
                if (changed) {
                    if (online) refresh()
                    else {
                        accountsRead?.cancel()
                        usagePackRead?.cancel()
                        workspaceCreditsRead?.cancel()
                    }
                }
            }
        }
    }

    internal fun visible(destination: SettingsDestination?) {
        if (visible == destination) return
        visible = destination
        if (destination != SettingsDestination.ModelAccounts && verifying.isEmpty())
            accountsRead?.cancel()
        if (destination != SettingsDestination.CreditBalance) {
            usagePackRead?.cancel()
            workspaceCreditsRead?.cancel()
        }
        if (
            !restored &&
                restore == null &&
                destination in
                    setOf(SettingsDestination.ModelAccounts, SettingsDestination.CreditBalance)
        ) {
            restore = viewModelScope.launch {
                val accounts = restore(WorkspaceSettingsResource.Accounts, accountsSerializer)
                val usagePack =
                    restore(WorkspaceSettingsResource.UsagePack, UsagePackCredits.serializer())
                val credits =
                    if (showWorkspaceCredits)
                        restore(
                            WorkspaceSettingsResource.WorkspaceCredits,
                            WorkspaceCreditSummary.serializer(),
                        )
                    else SettingsRead()
                if (!authorized()) return@launch
                mutable.update {
                    it.copy(accounts = accounts, usagePack = usagePack, workspaceCredits = credits)
                }
                restored = true
                refresh()
            }
        }
        refresh()
    }

    private suspend fun <T> restore(
        resource: WorkspaceSettingsResource,
        serializer: KSerializer<T>,
    ): SettingsRead<T> {
        val confirmed =
            cache?.load(identity, resource.cacheKey, serializer) ?: return SettingsRead()
        return SettingsRead(confirmed.value, readAt = confirmed.readAt)
    }

    internal fun retry(resource: WorkspaceSettingsResource) {
        if (!canRead()) return
        val state = mutable.value
        when (resource) {
            WorkspaceSettingsResource.Accounts -> {
                if (visible == SettingsDestination.ModelAccounts && state.accounts.initialFailure)
                    refreshAccounts()
            }
            WorkspaceSettingsResource.UsagePack -> {
                if (visible == SettingsDestination.CreditBalance && state.usagePack.initialFailure)
                    refreshUsagePack()
            }
            WorkspaceSettingsResource.WorkspaceCredits -> {
                if (
                    visible == SettingsDestination.CreditBalance &&
                        state.workspaceCredits.initialFailure
                )
                    refreshWorkspaceCredits()
            }
        }
    }

    private fun canRead() = restored && authorized() && !mutable.value.offline

    private fun refresh() {
        if (!canRead()) return
        refreshAccounts()
        if (visible == SettingsDestination.CreditBalance) {
            refreshUsagePack()
            refreshWorkspaceCredits()
        }
    }

    private fun refreshUsagePack() {
        if (usagePackRead?.isActive == true) return
        usagePackRead = viewModelScope.launch {
            read(
                WorkspaceSettingsResource.UsagePack,
                UsagePackCredits.serializer(),
                service::usagePackCredits,
                { mutable.value.usagePack },
            ) { data ->
                mutable.update { it.copy(usagePack = data) }
            }
        }
    }

    private fun refreshWorkspaceCredits() {
        if (!showWorkspaceCredits || workspaceCreditsRead?.isActive == true) return
        workspaceCreditsRead = viewModelScope.launch {
            read(
                WorkspaceSettingsResource.WorkspaceCredits,
                WorkspaceCreditSummary.serializer(),
                {
                    val billing = service.recoveryBilling()
                    WorkspaceCreditSummary(billing.credits, billing.creditBreakdown)
                },
                { mutable.value.workspaceCredits },
            ) { data ->
                mutable.update { it.copy(workspaceCredits = data) }
            }
        }
    }

    private fun refreshAccounts() {
        if (visible != SettingsDestination.ModelAccounts && verifying.isEmpty()) return
        if (mutable.value.switching.keys.any { it !in verifying }) return
        if (accountsRead?.isActive == true) return
        accountsRead = viewModelScope.launch {
            read(
                WorkspaceSettingsResource.Accounts,
                accountsSerializer,
                {
                    service.recoverySubscriptions().subscriptions.filter { it.provider != null }
                },
                { mutable.value.accounts },
            ) { result ->
                val state = mutable.value
                val incoming = result.value
                if (result.unavailable || incoming == null) {
                    mutable.update { it.copy(accounts = result) }
                } else {
                    val previousOrder =
                        state.accounts.value
                            .orEmpty()
                            .mapIndexed { index, item -> item.id to index }
                            .toMap()
                    val ordered = incoming.sortedBy { previousOrder[it.id] ?: Int.MAX_VALUE }
                    val rejected =
                        verifying.filterTo(mutableSetOf()) { provider ->
                            incoming.none {
                                it.id == state.switching[provider] && it.isActive == true
                            }
                        }
                    mutable.value =
                        state.copy(
                            accounts = result.copy(value = ordered),
                            switching = state.switching - verifying,
                            switchFailures = state.switchFailures + rejected,
                        )
                    verifying.clear()
                }
            }
        }
    }

    internal fun activate(accountId: String) {
        val state = mutable.value
        val account = state.accounts.value?.find { it.id == accountId } ?: return
        val provider = account.provider ?: return
        if (
            !authorized() ||
                state.offline ||
                account.isActive == true ||
                account.needsReconnect ||
                provider in state.switching
        )
            return

        accountsRead?.cancel()
        mutable.value =
            state.copy(
                switching = state.switching + (provider to accountId),
                switchFailures = state.switchFailures - provider,
            )
        viewModelScope.launch {
            try {
                val reply = service.activateModelAccount(accountId)
                currentCoroutineContext().ensureActive()
                if (!authorized()) return@launch
                if (reply.id != accountId || reply.isActive != true) {
                    verifying += provider
                } else {
                    mutable.update { latest ->
                        latest.copy(
                            accounts =
                                latest.accounts.copy(
                                    value =
                                        latest.accounts.value?.map {
                                            if (it.provider == provider)
                                                it.copy(isActive = it.id == accountId)
                                            else it
                                        },
                                ),
                            switching = latest.switching - provider,
                        )
                    }
                    val accounts = mutable.value.accounts
                    val values = accounts.value
                    val readAt = accounts.readAt
                    if (values != null && readAt != null) {
                        cache?.save(
                            identity,
                            WorkspaceSettingsResource.Accounts.cacheKey,
                            accountsSerializer,
                            ConfirmedSetting(values, readAt),
                        )
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                reportSessionFailure(error)
                if (!authorized()) return@launch
                if (
                    error is ApiFailure.Http &&
                        error.status in 400..499 &&
                        error.status !in setOf(404, 408, 409)
                ) {
                    mutable.update {
                        it.copy(
                            switching = it.switching - provider,
                            switchFailures = it.switchFailures + provider,
                        )
                    }
                } else {
                    verifying += provider
                }
            }
            refresh()
        }
    }

    private suspend fun <T> read(
        resource: WorkspaceSettingsResource,
        serializer: KSerializer<T>,
        fetch: suspend () -> T,
        state: () -> SettingsRead<T>,
        publish: (SettingsRead<T>) -> Unit,
    ) {
        val token = Any()
        refreshTokens[resource] = token
        try {
            val before = state()
            if (before.initialFailure) publish(SettingsRead())
            val age = before.readAt?.let { nowMillis() - it }
            showProgress(resource, age != null && (age < 0 || age > staleAfterMillis))
            for (attempt in 1..maxReadAttempts) {
                if (!canRead()) return
                try {
                    val data = fetch()
                    currentCoroutineContext().ensureActive()
                    if (authorized()) {
                        val readAt = nowMillis()
                        publish(SettingsRead(data, readAt = readAt))
                        cache?.save(
                            identity,
                            resource.cacheKey,
                            serializer,
                            ConfirmedSetting(data, readAt),
                        )
                    }
                    return
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    reportSessionFailure(error)
                    if (!authorized()) return
                    val retryable =
                        error is ApiFailure.Network ||
                            error is ApiFailure.Http &&
                                (error.status in 500..599 || error.status in setOf(408, 429))
                    if (retryable && attempt < maxReadAttempts) {
                        delay(readRetryDelayMillis)
                        continue
                    }
                    val current = state()
                    val value =
                        current.value.takeUnless { error is ApiFailure.Http && error.status == 403 }
                    publish(
                        SettingsRead(
                            value,
                            unavailable = true,
                            readAt = current.readAt.takeIf { value != null },
                        ),
                    )
                    if (value == null && current.value != null) {
                        cache?.save(identity, resource.cacheKey, serializer, null)
                    }
                    return
                }
            }
        } finally {
            if (refreshTokens[resource] === token) {
                refreshTokens.remove(resource)
                showProgress(resource, false)
            }
        }
    }

    private fun showProgress(resource: WorkspaceSettingsResource, refreshing: Boolean) {
        mutable.update {
            when (resource) {
                WorkspaceSettingsResource.Accounts ->
                    it.copy(accounts = it.accounts.copy(refreshing = refreshing))
                WorkspaceSettingsResource.UsagePack ->
                    it.copy(usagePack = it.usagePack.copy(refreshing = refreshing))
                WorkspaceSettingsResource.WorkspaceCredits ->
                    it.copy(workspaceCredits = it.workspaceCredits.copy(refreshing = refreshing))
            }
        }
    }

    private fun reportSessionFailure(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            onSessionFailure(error)
    }
}
