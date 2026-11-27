package ai.okou.android.settings

import ai.okou.android.FeedbackReceipt
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.boundedApiRetryDelayMillis
import ai.okou.android.api.generated.RecoveryBillingCreditBreakdownItem
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItemType
import ai.okou.android.api.generated.UsagePackCredits
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.contentReadStaleDelayMillis
import ai.okou.android.nextPaneFeedbackOrder
import ai.okou.android.state.SettingsDestination
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
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
            RecoverySubscriptionsSubscriptionsItemType.ANTIGRAVITY,
            RecoverySubscriptionsSubscriptionsItemType.BUILT_IN -> null
        }

internal class SettingsRefreshFailure {
    val order = nextPaneFeedbackOrder()
}

internal data class SettingsRead<T>(
    val value: T? = null,
    val unavailable: Boolean = false,
    val readAt: Long? = null,
    val refreshing: Boolean = false,
    val refreshFailure: SettingsRefreshFailure? = null,
) {
    val initialFailure: Boolean
        get() = value == null && unavailable
}

internal fun SettingsRead<*>.isStale(nowMillis: Long): Boolean {
    val confirmedAt = readAt ?: return false
    return confirmedAt > nowMillis || contentReadStaleDelayMillis(confirmedAt, nowMillis) == 0L
}

private val accountsSerializer = ListSerializer(RecoverySubscriptionsSubscriptionsItem.serializer())

private enum class WorkspaceSettingsResource(val cacheKey: String) {
    Accounts("accounts"),
    UsagePack("usage-pack"),
    WorkspaceCredits("workspace-credits"),
}

@Serializable
internal data class WorkspaceCreditSummary(
    val credits: Double,
    val creditBreakdown: List<RecoveryBillingCreditBreakdownItem>,
)

internal enum class AccountSwitchPhase {
    Submitting,
    Confirming,
    Unconfirmed,
}

internal data class AccountSwitch(val accountId: String, val phase: AccountSwitchPhase)

internal enum class SettingsNotice {
    ModelAccountSwitchFailed,
    EmailSubscriptionFailed,
    ImageModelSaveFailed,
    ToolSaveFailed,
    ToolSaveUnconfirmed,
}

internal data class WorkspaceSettingsState(
    val accounts: SettingsRead<List<RecoverySubscriptionsSubscriptionsItem>> = SettingsRead(),
    val usagePack: SettingsRead<UsagePackCredits> = SettingsRead(),
    val workspaceCredits: SettingsRead<WorkspaceCreditSummary> = SettingsRead(),
    val creditRefreshFailure: SettingsRefreshFailure? = null,
    val showWorkspaceCredits: Boolean = false,
    val switching: Map<ModelAccountProvider, AccountSwitch> = emptyMap(),
    val actionFailures: List<FeedbackReceipt<SettingsNotice>> = emptyList(),
)

/** Lives with the authorized workspace. Reading settings never participates in startup. */
class WorkspaceSettingsModel
internal constructor(
    private val service: WorkspaceSession,
    private val identity: WorkspaceIdentity,
    defaultModelStore: DefaultModelStore,
    initialWorkspaceAdmin: Boolean,
    private val readWorkspaceAdmin: suspend () -> Boolean,
    private val authorized: () -> Boolean,
    private val onSessionFailure: (Exception) -> Unit,
    private val cache: WorkspaceSettingsCache? = null,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val mutable =
        MutableStateFlow(WorkspaceSettingsState(showWorkspaceCredits = initialWorkspaceAdmin))
    internal val uiState = mutable.asStateFlow()
    internal val emailSubscription =
        EmailSubscriptionSettings(
            viewModelScope,
            service,
            identity,
            cache,
            authorized,
            ::reportSessionFailure,
            nowMillis,
            ::reportActionFailure,
        )
    internal val proactive =
        service.proactivePreferences?.let {
            ProactiveSettingsModel(
                viewModelScope,
                it,
                identity,
                cache,
                authorized,
                ::reportSessionFailure,
            )
        }
    internal val defaultModel =
        DefaultModelSettings(viewModelScope, service, identity, defaultModelStore, authorized) {
            reportSessionFailure(it)
        }
    internal val builtInTools =
        service.builtInTools?.let {
            BuiltInToolsSettings(
                viewModelScope,
                it,
                identity,
                cache,
                authorized,
                ::reportSessionFailure,
                notice = ::reportActionFailure,
            )
        }

    private var visible: SettingsDestination? = null
    private var restore: Job? = null
    private var restored = cache == null
    private var accountsRead: Job? = null
    private var usagePackRead: Job? = null
    private var workspaceCreditsRead: Job? = null
    private var creditFailureReported = false
    private val refreshTokens = mutableMapOf<WorkspaceSettingsResource, Any>()

    internal fun visible(destination: SettingsDestination?) {
        if (visible == destination) return
        visible = destination
        if (destination == null) mutable.update { it.copy(actionFailures = emptyList()) }
        if (destination != SettingsDestination.ModelAccounts) clearAccountRefreshFailure()
        if (
            destination != SettingsDestination.ModelAccounts &&
                mutable.value.switching.values.none { it.phase == AccountSwitchPhase.Confirming }
        )
            accountsRead?.cancel()
        if (destination != SettingsDestination.CreditBalance) {
            creditFailureReported = false
            mutable.update { it.copy(creditRefreshFailure = null) }
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
                    if (mutable.value.showWorkspaceCredits)
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

    private fun reportActionFailure(notice: SettingsNotice) {
        if (visible == null) return
        val receipt = FeedbackReceipt(notice)
        mutable.update { it.copy(actionFailures = it.actionFailures + receipt) }
    }

    internal fun dismissActionFailure(receipt: FeedbackReceipt<SettingsNotice>) {
        mutable.update { it.copy(actionFailures = it.actionFailures - receipt) }
    }

    internal fun dismissRefreshFailure(failure: SettingsRefreshFailure) {
        mutable.update {
            when {
                it.accounts.refreshFailure === failure ->
                    it.copy(accounts = it.accounts.copy(refreshFailure = null))
                it.creditRefreshFailure === failure -> it.copy(creditRefreshFailure = null)
                else -> it
            }
        }
    }

    private suspend fun <T> restore(
        resource: WorkspaceSettingsResource,
        serializer: KSerializer<T>,
    ): SettingsRead<T> {
        val confirmed =
            cache?.load(identity, resource.cacheKey, serializer) ?: return SettingsRead()
        return SettingsRead(confirmed.value, readAt = confirmed.readAt)
    }

    private fun canRead() = restored && authorized()

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
                onCachedFailure = ::reportCreditRefreshFailure,
            ) { data ->
                mutable.update { it.copy(usagePack = data) }
            }
        }
    }

    private fun refreshWorkspaceCredits() {
        if (workspaceCreditsRead?.isActive == true) return
        workspaceCreditsRead = viewModelScope.launch {
            read(
                WorkspaceSettingsResource.WorkspaceCredits,
                WorkspaceCreditSummary.serializer(),
                {
                    val billing = service.recoveryBilling()
                    WorkspaceCreditSummary(billing.credits, billing.creditBreakdown)
                },
                { mutable.value.workspaceCredits },
                onCachedFailure = ::reportCreditRefreshFailure,
                beforeFetch = ::confirmWorkspaceCreditAccess,
            ) { data ->
                mutable.update { it.copy(workspaceCredits = data) }
            }
        }
    }

    private suspend fun confirmWorkspaceCreditAccess(): Boolean {
        val admin = readWorkspaceAdmin()
        currentCoroutineContext().ensureActive()
        if (!authorized()) return false
        val current = mutable.value
        if (admin != current.showWorkspaceCredits) {
            mutable.value =
                current.copy(showWorkspaceCredits = admin, workspaceCredits = SettingsRead())
            if (!admin) {
                cache?.save(
                    identity,
                    WorkspaceSettingsResource.WorkspaceCredits.cacheKey,
                    WorkspaceCreditSummary.serializer(),
                    null,
                )
            }
        }
        return admin
    }

    private fun refreshAccounts() {
        val switching = mutable.value.switching.values
        if (switching.any { it.phase == AccountSwitchPhase.Submitting }) return
        if (
            visible != SettingsDestination.ModelAccounts &&
                switching.none { it.phase == AccountSwitchPhase.Confirming }
        )
            return
        if (accountsRead?.isActive == true) return
        accountsRead = viewModelScope.launch {
            clearAccountRefreshFailure()
            read(
                WorkspaceSettingsResource.Accounts,
                accountsSerializer,
                {
                    val subscriptions = service.recoverySubscriptions().subscriptions
                    val previousOrder =
                        mutable.value.accounts.value
                            .orEmpty()
                            .mapIndexed { index, item -> item.id to index }
                            .toMap()
                    subscriptions
                        .filter { it.provider != null }
                        .sortedBy {
                            previousOrder[it.id] ?: Int.MAX_VALUE
                        }
                },
                { mutable.value.accounts },
            ) { result ->
                val state = mutable.value
                val incoming = result.value
                if (result.unavailable) {
                    mutable.value =
                        state.copy(
                            accounts =
                                result.copy(
                                    refreshFailure =
                                        if (
                                            incoming != null &&
                                                visible == SettingsDestination.ModelAccounts
                                        )
                                            SettingsRefreshFailure()
                                        else null,
                                ),
                            switching =
                                state.switching.mapValues { (_, intent) ->
                                    if (intent.phase == AccountSwitchPhase.Confirming)
                                        intent.copy(phase = AccountSwitchPhase.Unconfirmed)
                                    else intent
                                },
                        )
                } else if (incoming == null) {
                    mutable.update { it.copy(accounts = result) }
                } else {
                    val verifying =
                        state.switching.filterValues { it.phase != AccountSwitchPhase.Submitting }
                    val rejected =
                        verifying
                            .filterValues { intent ->
                                incoming.none {
                                    it.id == intent.accountId && it.isActive == true
                                }
                            }
                            .keys
                    mutable.value =
                        state.copy(
                            accounts = result,
                            switching = state.switching - verifying.keys,
                        )
                    rejected.forEach { _ ->
                        reportActionFailure(SettingsNotice.ModelAccountSwitchFailed)
                    }
                }
            }
        }
    }

    private fun clearAccountRefreshFailure() {
        mutable.update { it.copy(accounts = it.accounts.copy(refreshFailure = null)) }
    }

    internal fun activate(accountId: String) {
        val state = mutable.value
        val account = state.accounts.value?.find { it.id == accountId } ?: return
        val provider = account.provider ?: return
        if (
            !authorized() ||
                account.isActive == true ||
                account.needsReconnect ||
                provider in state.switching
        )
            return

        accountsRead?.cancel()
        mutable.update { latest ->
            latest.copy(
                switching =
                    latest.switching +
                        (provider to AccountSwitch(accountId, AccountSwitchPhase.Submitting)),
            )
        }
        viewModelScope.launch {
            try {
                val reply = service.activateModelAccount(accountId)
                currentCoroutineContext().ensureActive()
                if (!authorized()) return@launch
                if (reply.id != accountId || reply.isActive != true) {
                    confirmSwitchByReading(provider, accountId)
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
                    mutable.update { it.copy(switching = it.switching - provider) }
                    reportActionFailure(SettingsNotice.ModelAccountSwitchFailed)
                } else {
                    confirmSwitchByReading(provider, accountId)
                }
            }
            refreshAccounts()
        }
    }

    private fun confirmSwitchByReading(provider: ModelAccountProvider, accountId: String) {
        mutable.update {
            it.copy(
                switching =
                    it.switching +
                        (provider to AccountSwitch(accountId, AccountSwitchPhase.Confirming)),
            )
        }
    }

    private suspend fun <T> read(
        resource: WorkspaceSettingsResource,
        serializer: KSerializer<T>,
        fetch: suspend () -> T,
        state: () -> SettingsRead<T>,
        onCachedFailure: () -> Unit = {},
        beforeFetch: (suspend () -> Boolean)? = null,
        publish: (SettingsRead<T>) -> Unit,
    ) {
        val token = Any()
        refreshTokens[resource] = token
        try {
            val before = state()
            if (before.initialFailure) publish(SettingsRead())
            showProgress(resource, before.isStale(nowMillis()))
            var checkAccess = beforeFetch
            var retries = 0
            while (canRead()) {
                try {
                    if (checkAccess?.invoke() == false) return
                    // A billing retry can reuse the role confirmed for this visible refresh.
                    checkAccess = null
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
                    val wait = error.boundedApiRetryDelayMillis(retries++)
                    if (wait != null) {
                        delay(wait)
                        currentCoroutineContext().ensureActive()
                        continue
                    }
                    val current = state()
                    val accessDenied = error is ApiFailure.Http && error.status == 403
                    if (accessDenied) cache?.save(identity, resource.cacheKey, serializer, null)
                    val value = current.value.takeUnless { accessDenied }
                    publish(
                        SettingsRead(
                            value,
                            unavailable = true,
                            readAt = current.readAt.takeIf { value != null },
                        ),
                    )
                    if (value != null) onCachedFailure()
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

    private fun reportCreditRefreshFailure() {
        if (visible != SettingsDestination.CreditBalance || creditFailureReported) return
        creditFailureReported = true
        mutable.update { it.copy(creditRefreshFailure = SettingsRefreshFailure()) }
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
