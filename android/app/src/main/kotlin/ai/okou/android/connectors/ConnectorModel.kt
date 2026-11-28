package ai.okou.android.connectors

import ai.okou.android.MemorySnapshotClock
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import ai.okou.android.api.generated.ConnectorDetailConnectorAuthMethodsItemGrantKind
import ai.okou.android.normalizedRenameName
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.util.Locale
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl

internal const val CONNECTOR_ACCOUNT_NAME_LIMIT = 255
internal const val CONNECTOR_EXTERNAL_CODE_LIMIT = 4096
private const val RECENT_READ_LIMIT = 8

internal data class ConnectorBrowseFilter(val keyword: String?, val category: String?) {
    companion object {
        fun of(query: String, category: String?): ConnectorBrowseFilter? =
            when {
                category != null -> ConnectorBrowseFilter(null, category)
                query.isNotBlank() ->
                    ConnectorBrowseFilter(query.trim().lowercase(Locale.ROOT), null)
                else -> null
            }
    }
}

internal data class ConnectorMatches(
    val filter: ConnectorBrowseFilter,
    val entries: ConnectorRead<ConnectorBrowse> = ConnectorRead(),
)

internal enum class ConnectorProblem {
    Failed,
    Network,
    BrowserUnavailable,
    AuthorizationIncomplete,
    DeviceAuthorizationDenied,
    DeviceCodeExpired,
    DeviceAuthorizationFailed,
    AuthorizationUnconfirmed,
    VerificationPending,
    VerificationNetwork,
}

internal enum class ConnectorResult {
    Authorized,
    Renamed,
    Disconnected,
}

internal data class ConnectorAction(
    val target: ConnectorAccountTarget,
    val busy: Boolean = false,
    val authorization: ConnectorAuthorization? = null,
    val browserOpened: Boolean = false,
    val problem: ConnectorProblem? = null,
    val result: ConnectorResult? = null,
) {
    val reconciling: Boolean
        get() = authorization is ConnectorAuthorization.Receipt

    val blocksOtherActions: Boolean
        get() = busy || authorization != null

    val awaitingExternalReceipt: Boolean
        get() =
            authorization is ConnectorAuthorization.External &&
                (problem == ConnectorProblem.VerificationPending ||
                    problem == ConnectorProblem.VerificationNetwork)
}

internal data class ConnectorImpact(val accountId: String, val read: ConnectorRead<Long>)

internal data class ConnectorUiState(
    val browse: ConnectorRead<ConnectorBrowse> = ConnectorRead(),
    val connected: ConnectorRead<Map<String, ConnectedService>> = ConnectorRead(),
    val matches: ConnectorMatches? = null,
    val slug: String? = null,
    val selectedPreview: ConnectorEntry? = null,
    val detail: ConnectorRead<ConnectorServiceDetail> = ConnectorRead(),
    val accounts: ConnectorRead<List<ConnectorSavedAccount>> = ConnectorRead(),
    val cachedAccounts: ConnectorRead<List<ConnectorSavedAccount>>? = null,
    val permissions: ConnectorRead<List<ConnectorPermission>> = ConnectorRead(),
    val impact: ConnectorImpact? = null,
    val action: ConnectorAction? = null,
) {
    val canChangeAccounts: Boolean
        get() = accounts.data != null && action?.blocksOtherActions != true

    val selectedAccountContent: List<ConnectorSavedAccount>?
        get() {
            val selected = slug ?: return null
            accounts.data?.let {
                return it
            }
            if (accounts.failure == ConnectorReadFailure.Unavailable) return null
            val overview = connected.data
            overview?.get(selected)?.accounts?.let {
                return it
            }
            val cached = cachedAccounts?.data ?: return null
            // A confirmed overview takes precedence over an earlier detail snapshot.
            return if (overview != null) emptyList() else cached
        }

    fun accountsFor(slug: String): List<ConnectorSavedAccount> =
        if (this.slug == slug) selectedAccountContent.orEmpty()
        else connected.data?.get(slug)?.accounts.orEmpty()
}

private data class ServiceReadSnapshot(
    val detail: ConnectorRead<ConnectorServiceDetail>,
    val accounts: ConnectorRead<List<ConnectorSavedAccount>>,
    val permissions: ConnectorRead<List<ConnectorPermission>>,
)

class ConnectorModel(
    private val service: ConnectorService,
    private val authorized: () -> Boolean,
    private val clock: TimeSource = TimeSource.Monotonic,
    private val snapshotClock: TimeSource = MemorySnapshotClock,
    private val sessionFailure: (Exception) -> Unit,
) : ViewModel() {
    private val mutableState = MutableStateFlow(ConnectorUiState())
    internal val uiState = mutableState.asStateFlow()
    internal var renameEditor by mutableStateOf<ConnectorRenameEditor?>(null)
        private set

    internal val chatOptions =
        ChatConnectorOptions(
            service,
            viewModelScope,
            authorized,
            snapshotClock,
            ::reportSessionFailure,
        )
    private val recentMatches =
        LinkedHashMap<ConnectorBrowseFilter, ConnectorRead<ConnectorBrowse>>(
            RECENT_READ_LIMIT,
            0.75f,
            true,
        )
    private val recentServices =
        LinkedHashMap<String, ServiceReadSnapshot>(RECENT_READ_LIMIT, 0.75f, true)
    private var browseJob: Job? = null
    private var connectedJob: Job? = null
    private var inspectionJob: Job? = null
    private var matchesJob: Job? = null
    private var detailJob: Job? = null
    private var accountsJob: Job? = null
    private var permissionJob: Job? = null
    private var impactJob: Job? = null
    private var actionJob: Job? = null
    private var deviceJob: Job? = null
    private var verificationJob: Job? = null
    private var verificationFailures = 0
    private var readFailureRound = 0L
    private var permissionsRequested = false
    private var open = false
    private var foreground = true
    private var filter: ConnectorBrowseFilter? = null
    private var authorizationDeadline: TimeMark? = null
    private var pendingExternalCode: String? = null

    override fun onCleared() {
        renameEditor = null
    }

    internal fun setOpen(open: Boolean) {
        if (this.open == open) return
        this.open = open
        if (open) {
            mutableState.update { state ->
                val accounts = state.accounts.confirmed().retaining(state.cachedAccounts).forEntry()
                state.copy(
                    browse = state.browse.forEntry(),
                    connected = state.connected.forEntry(),
                    matches = state.matches?.let { it.copy(entries = it.entries.forEntry()) },
                    detail = state.detail.forEntry(),
                    accounts =
                        ConnectorRead(
                            failure = accounts.failure,
                            confirmedAt = accounts.confirmedAt,
                        ),
                    cachedAccounts = accounts.takeIf { it.data != null },
                    permissions = state.permissions.forEntry(),
                )
            }
            refreshVisible()
        } else {
            hidePermissions()
            clearImpact()
            pauseReads()
        }
    }

    internal fun pause() {
        foreground = false
        pauseReads()
    }

    private fun pauseReads() {
        cancelReads()
        impactJob?.cancel()
        verificationJob?.cancel()
    }

    internal fun resume() {
        foreground = true
        if (open) refreshVisible()
    }

    internal fun enterDirectoryTab(connected: Boolean) {
        mutableState.update { state ->
            val matches = state.matches?.let { it.copy(entries = it.entries.forEntry()) }
            if (connected) state.copy(connected = state.connected.forEntry(), matches = matches)
            else state.copy(browse = state.browse.forEntry(), matches = matches)
        }
        if (open && foreground) {
            refreshDirectory(browse = !connected, accounts = connected)
            refreshMatches()
        }
    }

    private fun refreshVisible() {
        if (!foreground) return
        refreshDirectory()
        refreshMatches()
        refreshDetail()
        if (permissionsRequested) refreshPermissions()
        mutableState.value.impact?.let { refreshImpact(it.accountId) }
        checkAuthorization()
    }

    private fun refreshDirectory(browse: Boolean = true, accounts: Boolean = true) {
        if (browse && browseJob?.isActive != true) {
            browseJob = viewModelScope.launch {
                if (!canLoad()) return@launch
                val startedAt = snapshotClock.markNow()
                mutableState.update { it.copy(browse = it.browse.starting(startedAt)) }
                load({ service.discover(null, null) }) { read ->
                    val unavailable = read.failure == ConnectorReadFailure.Unavailable
                    if (unavailable) {
                        matchesJob?.cancel()
                        recentMatches.clear()
                    }
                    mutableState.update { state ->
                        state.copy(
                            browse = read.retaining(state.browse),
                            selectedPreview = state.selectedPreview.takeUnless { unavailable },
                            matches =
                                if (unavailable) state.matches?.copy(entries = read)
                                else state.matches,
                        )
                    }
                }
            }
        }
        if (accounts && pendingAuthorizationTarget() == null && connectedJob?.isActive != true) {
            connectedJob = viewModelScope.launch {
                if (!canLoad()) return@launch
                val startedAt = snapshotClock.markNow()
                mutableState.update { it.copy(connected = it.connected.starting(startedAt)) }
                load(service::connected) { read ->
                    val value = read.data
                    mutableState.update { state ->
                        val connected = value?.mapValues { (slug, service) ->
                            val statuses =
                                state.connected.data?.get(slug)?.accounts.orEmpty().associate {
                                    it.id to it.status
                                }
                            service.withStatuses(statuses)
                        }
                        state.copy(
                            connected = read.copy(data = connected).retaining(state.connected),
                        )
                    }
                    if (value != null) inspectConnected(value)
                }
            }
        }
    }

    private fun inspectConnected(connected: Map<String, ConnectedService>) {
        inspectionJob?.cancel()
        inspectionJob = viewModelScope.launch {
            load({ service.inspect(connected) }) { read ->
                val statuses = read.data
                if (statuses != null) {
                    mutableState.update { state ->
                        val data =
                            state.connected.data?.mapValues { (_, service) ->
                                service.withStatuses(statuses, preserveScopeMismatch = true)
                            }
                        state.copy(connected = state.connected.copy(data = data))
                    }
                }
            }
        }
    }

    internal fun setFilter(next: ConnectorBrowseFilter?) {
        if (next == filter) return
        filter = next
        matchesJob?.cancel()
        matchesJob = null
        val matches = next?.let {
            ConnectorMatches(it, recentMatches[it]?.forEntry() ?: ConnectorRead())
        }
        mutableState.update { it.copy(matches = matches) }
        if (open && foreground) refreshMatches()
    }

    private fun refreshMatches() {
        val selected = filter ?: return
        if (matchesJob?.isActive == true) return
        matchesJob = viewModelScope.launch {
            if (selected.keyword != null) delay(250)
            if (!canLoad()) return@launch
            val startedAt = snapshotClock.markNow()
            mutableState.update { state ->
                val matches = state.matches?.takeIf { it.filter == selected } ?: return@update state
                state.copy(matches = matches.copy(entries = matches.entries.starting(startedAt)))
            }
            load({ service.discover(selected.keyword, selected.category) }) { read ->
                if (filter != selected) return@load
                if (read.isConfirmed) recentMatches.rememberRead(selected, read)
                mutableState.update { state ->
                    val previous = state.matches?.takeIf { it.filter == selected }
                    state.copy(
                        matches = ConnectorMatches(selected, read.retaining(previous?.entries)),
                        selectedPreview =
                            state.selectedPreview.takeUnless {
                                read.failure == ConnectorReadFailure.Unavailable
                            },
                    )
                }
            }
        }
    }

    internal fun select(slug: String?, preview: ConnectorEntry? = null) {
        val previous = mutableState.value
        if (previous.slug == slug) {
            if (preview != null && previous.detail.failure != ConnectorReadFailure.Unavailable) {
                mutableState.update { it.copy(selectedPreview = preview) }
            }
            return
        }
        renameEditor = null
        previous.slug?.let { previousSlug ->
            val snapshot =
                ServiceReadSnapshot(
                    previous.detail.confirmed(),
                    previous.accounts.confirmed().retaining(previous.cachedAccounts),
                    previous.permissions.confirmed(),
                )
            if (
                snapshot.detail.isConfirmed ||
                    snapshot.accounts.isConfirmed ||
                    snapshot.permissions.isConfirmed
            ) {
                recentServices.rememberRead(previousSlug, snapshot)
            } else recentServices.remove(previousSlug)
        }
        cancelDetailReads()
        hidePermissions()
        impactJob?.cancel()
        impactJob = null
        val cached = slug?.let(recentServices::get)
        val accounts = cached?.accounts?.forEntry()
        val detail = cached?.detail?.forEntry() ?: ConnectorRead()
        mutableState.update {
            it.copy(
                slug = slug,
                selectedPreview =
                    preview.takeUnless { detail.failure == ConnectorReadFailure.Unavailable },
                detail = detail,
                accounts =
                    ConnectorRead(failure = accounts?.failure, confirmedAt = accounts?.confirmedAt),
                cachedAccounts = accounts?.takeIf { it.data != null },
                permissions = cached?.permissions?.forEntry() ?: ConnectorRead(),
                impact = null,
            )
        }
        refreshDetail()
    }

    private fun refreshDetail() {
        val slug = mutableState.value.slug ?: return
        if (detailJob?.isActive != true) {
            clearColdReadFailure(mutableState.value.detail) {
                it.copy(detail = it.detail.confirmed())
            }
            detailJob = viewModelScope.launch {
                load({ service.detail(slug) }) { read ->
                    val unavailable = read.failure == ConnectorReadFailure.Unavailable
                    if (unavailable) {
                        invalidateRename(slug)
                        permissionJob?.cancel()
                        permissionJob = null
                    }
                    mutableState.update { state ->
                        state.copy(
                            detail = read.retaining(state.detail),
                            selectedPreview = state.selectedPreview.takeUnless { unavailable },
                            permissions =
                                if (unavailable)
                                    ConnectorRead(
                                        failure = read.failure,
                                        confirmedAt = read.confirmedAt,
                                    )
                                else state.permissions,
                        )
                    }
                }
            }
        }
        if (pendingAuthorizationTarget()?.slug != slug && accountsJob?.isActive != true) {
            val state = mutableState.value
            if (state.selectedAccountContent == null) {
                clearColdReadFailure(state.accounts) { it.copy(accounts = it.accounts.confirmed()) }
            }
            accountsJob = viewModelScope.launch {
                load({ service.accounts(slug) }) { read ->
                    if (read.data != null) publishAccounts(slug, read.data)
                    else {
                        val unavailable = read.failure == ConnectorReadFailure.Unavailable
                        if (unavailable) invalidateRename(slug)
                        mutableState.update { state ->
                            state.copy(
                                accounts = read.retaining(state.accounts),
                                cachedAccounts = state.cachedAccounts.takeUnless { unavailable },
                                connected =
                                    if (unavailable)
                                        state.connected.copy(
                                            data = state.connected.data?.minus(slug),
                                        )
                                    else state.connected,
                            )
                        }
                    }
                }
            }
        }
    }

    internal fun showPermissions() {
        if (!permissionsRequested) {
            mutableState.update { it.copy(permissions = it.permissions.forEntry()) }
        }
        permissionsRequested = true
        refreshPermissions()
    }

    internal fun hidePermissions() {
        permissionsRequested = false
        permissionJob?.cancel()
        permissionJob = null
    }

    private fun refreshPermissions() {
        val slug = mutableState.value.slug ?: return
        if (permissionJob?.isActive == true) return
        clearColdReadFailure(mutableState.value.permissions) {
            it.copy(permissions = it.permissions.confirmed())
        }
        permissionJob = viewModelScope.launch {
            load({ service.permissions(slug) }) { read ->
                mutableState.update { state ->
                    state.copy(permissions = read.retaining(state.permissions))
                }
            }
        }
    }

    internal fun prepareDisconnect(id: String) {
        if (!canStart() || currentAccount(id) == null) return
        impactJob?.cancel()
        impactJob = null
        mutableState.update { it.copy(impact = ConnectorImpact(id, ConnectorRead())) }
        refreshImpact(id)
    }

    internal fun clearImpact() {
        impactJob?.cancel()
        impactJob = null
        mutableState.update { it.copy(impact = null) }
    }

    private fun refreshImpact(id: String) {
        val slug = mutableState.value.slug ?: return
        if (impactJob?.isActive == true) return
        impactJob = viewModelScope.launch {
            retryConnectorRead(
                read = { service.impact(slug, id) },
                canRead = { authorized() && open && foreground },
                onError = ::reportSessionFailure,
                publish = { read ->
                    mutableState.update { state ->
                        state.copy(
                            impact = ConnectorImpact(id, read.retaining(state.impact?.read)),
                        )
                    }
                },
            )
        }
    }

    internal fun openRename(id: String, fallbackName: String) {
        if (!canStart()) return
        val state = mutableState.value
        val slug = state.slug ?: return
        if (state.detail.failure == ConnectorReadFailure.Unavailable) return
        val account = state.accounts.data?.firstOrNull { it.id == id } ?: return
        renameEditor =
            ConnectorRenameEditor(
                slug,
                id,
                account.displayName ?: account.identity ?: fallbackName,
            )
    }

    internal fun submitRename(editor: ConnectorRenameEditor, name: String) {
        if (renameEditor === editor) rename(editor.accountId, name)
    }

    internal fun closeRename(editor: ConnectorRenameEditor) {
        if (renameEditor === editor) renameEditor = null
    }

    private fun invalidateRename(slug: String) {
        if (renameEditor?.target?.slug == slug) renameEditor = null
    }

    internal fun rename(id: String, name: String) {
        val label = normalizedRenameName(name)
        if (label.isEmpty() || label.length > CONNECTOR_ACCOUNT_NAME_LIMIT) return
        val state = mutableState.value
        val slug = state.slug ?: return
        val account = state.accounts.data.orEmpty().firstOrNull { it.id == id } ?: return
        val confirmedName = account.displayName ?: account.identity
        if (confirmedName != null && label == normalizedRenameName(confirmedName)) return
        val target = ConnectorAccountTarget(slug, id)
        change(target, ConnectorResult.Renamed) {
            val saved = service.rename(target.slug, id, label)
            replaceAccount(target, id) { it.copy(displayName = saved) }
        }
    }

    internal fun setDefaultEnabled(id: String, enabled: Boolean) {
        val target = currentAccount(id) ?: return
        if (
            mutableState.value.accountsFor(target.slug).find { it.id == id }?.status !=
                ConnectorAccountStatus.Connected
        )
            return
        change(target) {
            val saved = service.setDefaultEnabled(target.slug, id, enabled)
            replaceAccount(target, id) { it.copy(defaultEnabled = saved) }
        }
    }

    internal fun setMemberPolicy(id: String, choice: ConnectorAccountPolicyRequestPolicy) {
        val target = currentAccount(id) ?: return
        if (mutableState.value.accountsFor(target.slug).find { it.id == id }?.policy == null) return
        change(target) {
            val saved = service.setAccountPolicy(target.slug, id, choice)
            replaceAccount(target, id) { it.copy(policy = saved) }
            chatOptions.applyPolicyReceipt(target.slug, id, saved)
        }
    }

    internal fun disconnect(id: String) {
        val target = currentAccount(id) ?: return
        val impact = mutableState.value.impact ?: return
        if (impact.accountId != id || impact.read.data == null) return
        change(target, ConnectorResult.Disconnected) {
            service.disconnect(target.slug, id)
            replaceAccount(target, id) { null }
        }
    }

    private fun change(
        target: ConnectorAccountTarget,
        result: ConnectorResult? = null,
        write: suspend () -> Unit,
    ) {
        if (!canStart()) return
        runAction(ConnectorAction(target), refreshOnFailure = false) {
            write()
            if (!authorized()) return@runAction
            complete(target, result)
            if (open && foreground) {
                refreshDirectory()
                refreshDetail()
            }
        }
    }

    internal fun startAuthorization(id: String?, methodId: String, values: Map<String, String>) {
        val state = mutableState.value
        val detail = state.detail.data ?: return
        val target =
            if (id == null) ConnectorAccountTarget(detail.entry.slug, null)
            else currentAccount(id) ?: return
        val method = detail.methods.firstOrNull { it.id == methodId } ?: return
        if (
            state.action?.target == target &&
                state.action.problem == ConnectorProblem.AuthorizationUnconfirmed
        )
            return
        if (
            id != null &&
                state.accountsFor(target.slug).find { it.id == id }?.authMethod != methodId
        )
            return
        if (!canStart()) return
        val mayAuthorize =
            method.grantKind == ConnectorDetailConnectorAuthMethodsItemGrantKind.MANUAL ||
                method.grantKind == ConnectorDetailConnectorAuthMethodsItemGrantKind.NONE ||
                method.grantKind == ConnectorDetailConnectorAuthMethodsItemGrantKind.AUTOMATIC
        runAction(ConnectorAction(target), mayAuthorize = mayAuthorize) {
            when (val step = service.start(target, method, values)) {
                is ConnectorAuthorization.Receipt -> finishAuthorization(target, step.connectionId)
                else -> {
                    val deadline =
                        clock.markNow() +
                            when (step) {
                                is ConnectorAuthorization.Device -> step.expiresIn
                                is ConnectorAuthorization.External -> step.expiresIn
                                else -> 15.minutes
                            }
                    authorizationDeadline = deadline
                    updateAction { it.copy(authorization = step) }
                    if (step is ConnectorAuthorization.Device) {
                        trackDeviceAuthorization(target, step, deadline)
                    }
                }
            }
        }
    }

    internal fun openBrowser(launch: (HttpUrl) -> Boolean) {
        val action = mutableState.value.action ?: return
        if (!open || !authorized() || action.busy || action.awaitingExternalReceipt) return
        val step = action.authorization ?: return
        if (authorizationExpired()) {
            // The device job may still be receiving the result of a poll sent before expiry.
            if (step !is ConnectorAuthorization.Device) {
                updateAction {
                    it.copy(
                        authorization = null,
                        problem = ConnectorProblem.AuthorizationIncomplete,
                    )
                }
            }
            return
        }
        val url =
            when (step) {
                is ConnectorAuthorization.Browser -> step.url
                is ConnectorAuthorization.Device -> step.url
                is ConnectorAuthorization.External -> step.url
                else -> return
            }
        if (!launch(url)) {
            updateAction { it.copy(problem = ConnectorProblem.BrowserUnavailable) }
            return
        }
        updateAction { it.copy(browserOpened = true, problem = null) }
    }

    private fun trackDeviceAuthorization(
        target: ConnectorAccountTarget,
        step: ConnectorAuthorization.Device,
        deadline: TimeMark,
    ) {
        deviceJob?.cancel()
        deviceJob = viewModelScope.launch {
            val opened =
                withTimeoutOrNull(-deadline.elapsedNow()) {
                    mutableState.first {
                        it.action?.authorization == step && it.action.browserOpened
                    }
                }
            if (opened == null) {
                endDeviceAuthorization(step, ConnectorProblem.DeviceCodeExpired)
                return@launch
            }
            var interval = step.interval
            var outcomeUncertain = false
            while (!deadline.hasPassedNow()) {
                delay(minOf(interval.coerceAtLeast(1.seconds), -deadline.elapsedNow()))
                if (deadline.hasPassedNow()) break
                try {
                    when (val result = service.pollDevice(target.slug, step)) {
                        is ConnectorDeviceResult.Waiting -> interval = result.interval
                        is ConnectorDeviceResult.Complete -> {
                            val action = mutableState.value.action ?: return@launch
                            runAction(action) {
                                finishAuthorization(target, result.connectionId)
                            }
                            return@launch
                        }
                        is ConnectorDeviceResult.Terminal -> {
                            endDeviceAuthorization(step, result.problem())
                            return@launch
                        }
                    }
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    reportSessionFailure(error)
                    if (!error.hasUncertainResponse()) {
                        if (outcomeUncertain) break
                        endDeviceAuthorization(step, ConnectorProblem.DeviceAuthorizationFailed)
                        return@launch
                    }
                    outcomeUncertain = outcomeUncertain || !error.connectionFailed()
                    interval = maxOf(interval, 5.seconds)
                }
            }
            if (outcomeUncertain && mutableState.value.action?.authorization == step) {
                authorizationDeadline = null
                updateAction {
                    it.copy(
                        authorization = ConnectorAuthorization.DeviceVerification(step),
                        browserOpened = false,
                        problem = ConnectorProblem.VerificationPending,
                    )
                }
                checkAuthorization()
            } else {
                endDeviceAuthorization(step, ConnectorProblem.DeviceCodeExpired)
            }
        }
    }

    private fun endDeviceAuthorization(
        step: ConnectorAuthorization,
        problem: ConnectorProblem,
    ) {
        if (mutableState.value.action?.authorization != step) return
        authorizationDeadline = null
        updateAction {
            it.copy(authorization = null, browserOpened = false, problem = problem)
        }
    }

    internal fun completeExternal(code: String) {
        val action = mutableState.value.action ?: return
        val step = action.authorization as? ConnectorAuthorization.External ?: return
        val trimmed = code.trim()
        if (
            !open ||
                action.busy ||
                action.awaitingExternalReceipt ||
                trimmed.length !in 1..CONNECTOR_EXTERNAL_CODE_LIMIT
        )
            return
        if (authorizationExpired()) {
            updateAction {
                it.copy(authorization = null, problem = ConnectorProblem.AuthorizationIncomplete)
            }
            return
        }
        submitExternalCode(action, step, trimmed)
    }

    internal fun checkExternalAuthorization() {
        val action = mutableState.value.action ?: return
        val step = action.authorization as? ConnectorAuthorization.External ?: return
        val code = pendingExternalCode ?: return
        if (!open || !action.awaitingExternalReceipt) return
        // The server can still return the receipt of a completed session after its expiry.
        submitExternalCode(action, step, code)
    }

    private fun submitExternalCode(
        action: ConnectorAction,
        step: ConnectorAuthorization.External,
        code: String,
    ) {
        runAction(action) {
            pendingExternalCode = code
            val connectionId =
                try {
                    service.completeExternal(action.target.slug, step, code)
                } catch (error: ApiFailure.Http) {
                    if (!action.awaitingExternalReceipt || error.status != 400) throw error
                    // A 400 can also mean that the original exchange is still completing.
                    updateAction { it.copy(problem = ConnectorProblem.VerificationPending) }
                    return@runAction
                }
            pendingExternalCode = null
            finishAuthorization(action.target, connectionId)
        }
    }

    internal fun checkAuthorization() {
        val action = mutableState.value.action ?: return
        if (!open || action.busy || actionJob?.isActive == true) return
        when (val step = action.authorization) {
            is ConnectorAuthorization.Receipt ->
                runAction(action) { finishAuthorization(action.target, step.connectionId) }
            is ConnectorAuthorization.DeviceVerification -> {
                runAction(action) {
                    val result =
                        try {
                            service.pollDevice(action.target.slug, step.attempt)
                        } catch (error: Exception) {
                            if (error is CancellationException) throw error
                            reportSessionFailure(error)
                            updateAction {
                                it.copy(
                                    problem =
                                        if (error is ApiFailure.Network)
                                            ConnectorProblem.VerificationNetwork
                                        else ConnectorProblem.VerificationPending,
                                )
                            }
                            return@runAction
                        }
                    when (result) {
                        is ConnectorDeviceResult.Waiting ->
                            updateAction { it.copy(problem = ConnectorProblem.VerificationPending) }
                        is ConnectorDeviceResult.Complete ->
                            finishAuthorization(action.target, result.connectionId)
                        is ConnectorDeviceResult.Terminal ->
                            endDeviceAuthorization(step, result.problem())
                    }
                }
            }
            is ConnectorAuthorization.Browser -> {
                if (!action.browserOpened) return
                runAction(action) {
                    var receipt = service.oauthCompletion(action.target.slug, step.attemptId)
                    if (receipt == null) {
                        delay(700)
                        receipt = service.oauthCompletion(action.target.slug, step.attemptId)
                    }
                    if (receipt != null) finishAuthorization(action.target, receipt)
                    else
                        updateAction {
                            it.copy(
                                authorization =
                                    it.authorization.takeUnless { authorizationExpired() },
                                problem = ConnectorProblem.AuthorizationIncomplete,
                            )
                        }
                }
            }
            else -> Unit
        }
    }

    private suspend fun finishAuthorization(target: ConnectorAccountTarget, receipt: String) {
        if (target.connectionId != null && target.connectionId != receipt) {
            updateAction { it.copy(authorization = null) }
            throw ApiFailure.IncompatibleResponse()
        }
        updateAction {
            val externalCodeSessionId =
                when (val previous = it.authorization) {
                    is ConnectorAuthorization.External -> previous.sessionId
                    is ConnectorAuthorization.Receipt -> previous.externalCodeSessionId
                    else -> null
                }
            it.copy(
                authorization = ConnectorAuthorization.Receipt(receipt, externalCodeSessionId),
            )
        }
        val connected = service.accountIsConnected(target.slug, receipt)
        val accounts = service.accounts(target.slug)
        if (!authorized()) return
        if (
            !connected ||
                accounts.none {
                    it.id == receipt && it.status == ConnectorAccountStatus.Connected
                }
        ) {
            updateAction {
                it.copy(
                    authorization = null,
                    problem = ConnectorProblem.AuthorizationIncomplete,
                )
            }
            return
        }
        invalidateConnectionReads()
        publishAccounts(target.slug, accounts)
        complete(ConnectorAccountTarget(target.slug, receipt), ConnectorResult.Authorized)
        if (open) {
            refreshDirectory()
            refreshDetail()
        }
    }

    internal fun dismissAction() {
        val action = mutableState.value.action
        if (action?.busy == true) return
        if (action?.reconciling == true) {
            val receipt = action.authorization as? ConnectorAuthorization.Receipt
            if (receipt?.externalCodeSessionId != null) {
                updateAction { it.copy(authorization = receipt.copy(externalCodeSessionId = null)) }
            }
            return
        }
        deviceJob?.cancel()
        deviceJob = null
        verificationJob?.cancel()
        verificationJob = null
        verificationFailures = 0
        authorizationDeadline = null
        pendingExternalCode = null
        mutableState.update { it.copy(action = null) }
    }

    private fun authorizationExpired() = authorizationDeadline?.hasPassedNow() == true

    private fun pendingAuthorizationTarget(): ConnectorAccountTarget? =
        mutableState.value.action?.takeIf { it.authorization != null }?.target

    private fun currentAccount(id: String): ConnectorAccountTarget? {
        val state = mutableState.value
        val slug = state.slug ?: return null
        return if (state.accounts.data.orEmpty().any { it.id == id })
            ConnectorAccountTarget(slug, id)
        else null
    }

    private fun canStart(): Boolean =
        authorized() &&
            open &&
            foreground &&
            actionJob?.isActive != true &&
            mutableState.value.canChangeAccounts

    private fun invalidateConnectionReads() {
        browseJob?.cancel()
        connectedJob?.cancel()
        inspectionJob?.cancel()
        cancelDetailReads()
        mutableState.update {
            if (it.browse.startedAt == null && it.connected.startedAt == null) it
            else
                it.copy(
                    browse = it.browse.copy(startedAt = null),
                    connected = it.connected.copy(startedAt = null),
                )
        }
    }

    private fun cancelReads() {
        invalidateConnectionReads()
        matchesJob?.cancel()
        permissionJob?.cancel()
        mutableState.update { state ->
            val matches = state.matches ?: return@update state
            if (matches.entries.startedAt == null) state
            else
                state.copy(matches = matches.copy(entries = matches.entries.copy(startedAt = null)))
        }
    }

    private fun cancelDetailReads() {
        detailJob?.cancel()
        accountsJob?.cancel()
    }

    private fun replaceAccount(
        target: ConnectorAccountTarget,
        id: String,
        replace: (ConnectorSavedAccount) -> ConnectorSavedAccount?,
    ) {
        if (!authorized()) return
        val slug = target.slug
        fun update(accounts: List<ConnectorSavedAccount>) = accounts.mapNotNull {
            if (it.id == id) replace(it) else it
        }

        invalidateConnectionReads()
        recentServices[slug]?.let { cached ->
            recentServices[slug] =
                cached.copy(
                    accounts = cached.accounts.copy(data = cached.accounts.data?.let(::update)),
                )
        }
        mutableState.update { state ->
            val overview = state.connected.data
            val service = overview?.get(slug)
            val updated =
                if (overview == null || service == null) overview
                else {
                    val accounts = update(service.accounts)
                    if (accounts.isEmpty()) overview - slug
                    else overview + (slug to service.copy(accounts = accounts))
                }
            state.copy(
                connected = state.connected.copy(data = updated),
                accounts =
                    if (state.slug == slug)
                        state.accounts.copy(data = state.accounts.data?.let(::update))
                    else state.accounts,
                cachedAccounts =
                    if (state.slug == slug)
                        state.cachedAccounts?.let { it.copy(data = it.data?.let(::update)) }
                    else state.cachedAccounts,
            )
        }
    }

    private fun publishAccounts(slug: String, accounts: List<ConnectorSavedAccount>) {
        val editor = renameEditor
        if (
            editor != null &&
                editor.target.slug == slug &&
                accounts.none { it.id == editor.accountId }
        ) {
            closeRename(editor)
        }
        val confirmed = ConnectorRead(accounts, confirmedAt = snapshotClock.markNow())
        val cached = recentServices[slug]
        if (cached != null) recentServices[slug] = cached.copy(accounts = confirmed)
        mutableState.update { state ->
            val knownServices = state.connected.data
            // The account read has no catalog data. Keep the overview's current entry.
            val entry =
                knownServices?.get(slug)?.entry
                    ?: state.detail.data?.entry?.takeIf { it.slug == slug }
                    ?: cached?.detail?.data?.entry
            val services =
                when {
                    knownServices == null -> null
                    accounts.isEmpty() -> knownServices - slug
                    entry != null -> knownServices + (slug to ConnectedService(entry, accounts))
                    else -> knownServices
                }
            state.copy(
                connected = state.connected.copy(data = services),
                accounts = if (state.slug == slug) confirmed else state.accounts,
                cachedAccounts = if (state.slug == slug) null else state.cachedAccounts,
            )
        }
    }

    private fun runAction(
        action: ConnectorAction,
        mayAuthorize: Boolean = false,
        refreshOnFailure: Boolean = true,
        block: suspend () -> Unit,
    ) {
        if (!authorized() || actionJob?.isActive == true) return
        mutableState.update { it.copy(action = action.copy(busy = true, problem = null)) }
        actionJob = viewModelScope.launch {
            try {
                block()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                reportSessionFailure(error)
                val definitive =
                    error is ApiFailure.Http &&
                        error.status in 400..499 &&
                        error.status != 408 &&
                        error.status != 429
                val connectionFailed = error.connectionFailed()
                val uncertain = error.hasUncertainResponse()
                val canRetryBrowserReceipt = uncertain && !authorizationExpired()
                updateAction {
                    val checkExternalSession =
                        it.authorization is ConnectorAuthorization.External &&
                            (action.awaitingExternalReceipt || uncertain && !connectionFailed)
                    val verifying =
                        !definitive &&
                            (it.reconciling ||
                                it.awaitingBrowserReceipt && canRetryBrowserReceipt ||
                                checkExternalSession)
                    it.copy(
                        authorization =
                            if (definitive && it.reconciling) null else it.authorization,
                        problem =
                            when {
                                verifying && connectionFailed ->
                                    ConnectorProblem.VerificationNetwork
                                verifying -> ConnectorProblem.VerificationPending
                                connectionFailed -> ConnectorProblem.Network
                                mayAuthorize && uncertain ->
                                    ConnectorProblem.AuthorizationUnconfirmed
                                else -> ConnectorProblem.Failed
                            },
                    )
                }
                if (
                    mutableState.value.action?.problem == ConnectorProblem.AuthorizationUnconfirmed
                ) {
                    // The user can inspect the saved accounts after closing the form.
                    // A read started before the attempt cannot establish that list.
                    invalidateConnectionReads()
                    mutableState.update { state ->
                        if (state.slug != action.target.slug) state
                        else
                            state.copy(
                                accounts = ConnectorRead(),
                                cachedAccounts =
                                    state.accounts.takeIf { it.data != null }
                                        ?: state.cachedAccounts,
                            )
                    }
                }
                if (refreshOnFailure && open && foreground) {
                    refreshDirectory()
                    refreshDetail()
                }
            } finally {
                if (
                    action.authorization is ConnectorAuthorization.External &&
                        (!authorized() ||
                            mutableState.value.action?.awaitingExternalReceipt != true)
                )
                    pendingExternalCode = null
                updateAction { it.copy(busy = false) }
                scheduleVerification()
            }
        }
    }

    private fun scheduleVerification() {
        val action = mutableState.value.action
        val authReadback =
            action?.authorization is ConnectorAuthorization.Receipt ||
                action?.let {
                    it.awaitingBrowserReceipt &&
                        (it.problem == ConnectorProblem.VerificationPending ||
                            it.problem == ConnectorProblem.VerificationNetwork)
                } == true
        if (
            !open ||
                !foreground ||
                !authorized() ||
                verificationJob?.isActive == true ||
                !authReadback
        )
            return
        val wait =
            when (verificationFailures++) {
                0 -> 2.seconds
                1 -> 8.seconds
                else -> 30.seconds
            }
        verificationJob = viewModelScope.launch {
            delay(wait)
            verificationJob = null
            if (open && foreground) checkAuthorization()
        }
    }

    private fun complete(target: ConnectorAccountTarget, result: ConnectorResult?) {
        authorizationDeadline = null
        verificationFailures = 0
        val changedConnection =
            target.connectionId.takeIf {
                result == ConnectorResult.Authorized || result == ConnectorResult.Disconnected
            }
        chatOptions.invalidate(target.slug, changedConnection)
        mutableState.update { it.copy(action = ConnectorAction(target, result = result)) }
    }

    private fun updateAction(update: (ConnectorAction) -> ConnectorAction) {
        if (authorized())
            mutableState.update { state -> state.copy(action = state.action?.let(update)) }
    }

    private fun reportSessionFailure(error: Exception) {
        if (
            error is ApiFailure.Unauthenticated ||
                error is ApiFailure.UpdateRequired ||
                error is ApiFailure.Http && error.status == 401
        )
            sessionFailure(error)
    }

    private inline fun clearColdReadFailure(
        read: ConnectorRead<*>,
        update: (ConnectorUiState) -> ConnectorUiState,
    ) {
        if (read.data == null && read.failureRound != null) mutableState.update(update)
    }

    private fun canLoad(): Boolean = authorized() && open && foreground

    private suspend fun <T : Any> load(read: suspend () -> T, publish: (ConnectorRead<T>) -> Unit) =
        retryConnectorRead(
            read,
            canRead = ::canLoad,
            onError = ::reportSessionFailure,
            publish = {
                publish(
                    if (it.isConfirmed) it.copy(confirmedAt = snapshotClock.markNow())
                    else it.copy(failureRound = ++readFailureRound),
                )
            },
        )
}

private fun <T> ConnectorRead<T>.starting(startedAt: TimeMark): ConnectorRead<T> =
    (if (data == null) confirmed() else this).copy(startedAt = startedAt)

private fun <K, V> LinkedHashMap<K, V>.rememberRead(key: K, value: V) {
    this[key] = value
    if (size > RECENT_READ_LIMIT) remove(keys.first())
}

private fun ConnectorDeviceResult.Terminal.problem() =
    when (this) {
        ConnectorDeviceResult.Terminal.Denied -> ConnectorProblem.DeviceAuthorizationDenied
        ConnectorDeviceResult.Terminal.Expired -> ConnectorProblem.DeviceCodeExpired
        ConnectorDeviceResult.Terminal.Failed -> ConnectorProblem.DeviceAuthorizationFailed
    }

private val ConnectorAction.awaitingBrowserReceipt: Boolean
    get() = browserOpened && authorization is ConnectorAuthorization.Browser

private fun ConnectedService.withStatuses(
    statuses: Map<String, ConnectorAccountStatus>,
    preserveScopeMismatch: Boolean = false,
): ConnectedService =
    copy(
        accounts =
            accounts.map { account ->
                val status = statuses[account.id] ?: account.status
                if (
                    preserveScopeMismatch &&
                        account.status == ConnectorAccountStatus.UpdatePermissions &&
                        status == ConnectorAccountStatus.Connected
                )
                    account
                else account.copy(status = status)
            },
    )

internal fun recommendedConnectors(entries: List<ConnectorEntry>): List<ConnectorEntry> =
    entries
        .asSequence()
        .filter { it.rank != null }
        .groupBy { it.category }
        .values
        .filter { it.size >= 4 }
        .mapNotNull {
            it.minWithOrNull(compareBy({ entry -> entry.rank }, { entry -> entry.name }))
        }
        .sortedWith(compareBy({ it.rank }, { it.name }))
        .take(6)
