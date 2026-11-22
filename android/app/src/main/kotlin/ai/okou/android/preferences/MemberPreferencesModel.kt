package ai.okou.android.preferences

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UpdatePreferencesRequestColorTheme
import ai.okou.android.api.generated.UpdatePreferencesRequestLocale
import ai.okou.android.api.generated.UpdatePreferencesRequestTheme
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.WorkspaceSession
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

enum class PreferenceStatus {
    Ready,
    Saving,
    Refreshing,
    SaveFailed,
    RefreshFailed,
}

data class PreferenceChange(
    val colorTheme: UserPreferencesColorTheme? = null,
    val locale: UserPreferencesLocale? = null,
    val theme: UserPreferencesTheme? = null,
    val timezone: String? = null,
    val timezoneToReconcile: String? = null,
    val cloudBrowser: Boolean? = null,
) {
    val timezoneToWrite: String?
        get() = timezone ?: timezoneToReconcile

    fun request() =
        UpdatePreferencesRequest(
            timezone = timezoneToWrite,
            colorTheme = colorTheme?.let { UpdatePreferencesRequestColorTheme.valueOf(it.name) },
            locale = locale?.let { UpdatePreferencesRequestLocale.valueOf(it.name) },
            theme = theme?.let { UpdatePreferencesRequestTheme.valueOf(it.name) },
            cloudBrowserEnabledByDefault = cloudBrowser,
        )

    fun after(sent: PreferenceChange): PreferenceChange? {
        val writtenTimezone = sent.timezoneToWrite
        return PreferenceChange(
                colorTheme = colorTheme.takeUnless { it == sent.colorTheme },
                locale = locale.takeUnless { it == sent.locale },
                theme = theme.takeUnless { it == sent.theme },
                timezone = timezone.takeUnless { it == writtenTimezone },
                timezoneToReconcile = timezoneToReconcile.takeIf { writtenTimezone == null },
                cloudBrowser = cloudBrowser.takeUnless { it == sent.cloudBrowser },
            )
            .takeUnless { it == PreferenceChange() }
    }

    fun afterReadback(confirmed: UserPreferences): PreferenceChange? {
        val remaining = after(confirmed.asChoice())
        // Reading preferences confirms the stored value, but only the write confirms its schedules.
        val timezone = timezoneToReconcile?.takeIf { it == confirmed.timezone } ?: return remaining
        return (remaining ?: PreferenceChange()).copy(timezoneToReconcile = timezone)
    }
}

private fun UserPreferences.asChoice() =
    PreferenceChange(
        colorTheme = colorTheme,
        locale = locale,
        theme = theme,
        timezone = timezone,
        cloudBrowser = cloudBrowserEnabledByDefault,
    )

data class MemberPreferencesState(
    val confirmed: UserPreferences,
    val pending: PreferenceChange? = null,
    val status: PreferenceStatus = PreferenceStatus.Ready,
    val recovering: Boolean = false,
) {
    val busy: Boolean
        get() = status == PreferenceStatus.Saving || status == PreferenceStatus.Refreshing

    val colorTheme: UserPreferencesColorTheme
        get() = pending?.colorTheme ?: confirmed.colorTheme ?: UserPreferencesColorTheme.DEFAULT

    val theme: UserPreferencesTheme
        get() = pending?.theme ?: confirmed.theme ?: UserPreferencesTheme.SYSTEM

    val timezone: String
        get() = pending?.timezone ?: checkNotNull(confirmed.timezone)

    val cloudBrowser: Boolean
        get() = pending?.cloudBrowser ?: confirmed.cloudBrowserEnabledByDefault

    val supportedLocales: List<UserPreferencesLocale>
        get() = confirmed.supportedLocales.map { UserPreferencesLocale.valueOf(it.name) }

    val locale: UserPreferencesLocale
        get() =
            (pending?.locale ?: checkNotNull(confirmed.locale)).takeIf { it in supportedLocales }
                ?: UserPreferencesLocale.EN_US
}

private fun MemberPreferencesState.afterTimezoneConflict(
    sent: PreferenceChange
): MemberPreferencesState {
    // The timezone endpoint returns this conflict after saving the fields and before finishing
    // Morning Brief reconciliation. Keep the schedule repair pending and acknowledge the values.
    val timezone = checkNotNull(sent.timezoneToWrite)
    val remaining = pending?.after(sent) ?: PreferenceChange()
    return copy(
        confirmed =
            confirmed.copy(
                colorTheme = sent.colorTheme ?: confirmed.colorTheme,
                locale = sent.locale ?: confirmed.locale,
                theme = sent.theme ?: confirmed.theme,
                timezone = timezone,
                cloudBrowserEnabledByDefault =
                    sent.cloudBrowser ?: confirmed.cloudBrowserEnabledByDefault,
            ),
        pending = remaining.copy(timezoneToReconcile = timezone),
    )
}

/** Workspace-owned confirmed data and explicit user intent; native locale state is presentation. */
class MemberPreferencesModel(
    initial: UserPreferences,
    private val service: WorkspaceSession,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    connectivity: Flow<Boolean> = emptyFlow(),
    initialPending: PreferenceChange? = null,
) : ViewModel() {
    private val mutable =
        MutableStateFlow(MemberPreferencesState(initial, initialPending?.afterReadback(initial)))
    val uiState = mutable.asStateFlow()
    private var retired = false
    private var online = true
    private var request: Job? = null
    private var recovery: Job? = null
    private var retryDelay = 5_000L
    private var readRequested = false
    private var settingsVisible = false
    private var needsWriteReadback = false

    init {
        viewModelScope.launch {
            connectivity.collect { connected ->
                val reconnected = connected && !online
                online = connected
                if (!connected) {
                    recovery?.cancel()
                    recovery = null
                } else if (reconnected) {
                    retryDelay = 5_000L
                    if (mutable.value.pending == null && settingsVisible) readRequested = true
                    if (
                        mutable.value.recovering ||
                            mutable.value.status != PreferenceStatus.SaveFailed
                    )
                        synchronize()
                }
            }
        }
        if (mutable.value.pending != null) synchronize()
    }

    private fun current() = !retired && authorized()

    fun selectTheme(value: UserPreferencesTheme) {
        val state = mutable.value
        if (state.theme != value) select((state.pending ?: PreferenceChange()).copy(theme = value))
    }

    fun selectColorTheme(value: UserPreferencesColorTheme) {
        val state = mutable.value
        if (state.colorTheme != value)
            select((state.pending ?: PreferenceChange()).copy(colorTheme = value))
    }

    fun selectLocale(value: UserPreferencesLocale) {
        val state = mutable.value
        if (value in state.supportedLocales && state.locale != value)
            select((state.pending ?: PreferenceChange()).copy(locale = value))
    }

    fun selectTimezone(value: String) {
        val state = mutable.value
        if (state.timezone != value)
            select((state.pending ?: PreferenceChange()).copy(timezone = value))
    }

    fun setCloudBrowser(enabled: Boolean) {
        val state = mutable.value
        if (state.cloudBrowser != enabled) {
            select((state.pending ?: PreferenceChange()).copy(cloudBrowser = enabled))
        }
    }

    private fun select(change: PreferenceChange) {
        if (!current()) return
        mutable.value = mutable.value.copy(pending = change, recovering = !online)
        readRequested = false
        clearRecovery()
        synchronize()
    }

    fun refresh() {
        if (!current() || request != null || mutable.value.pending != null) return
        readRequested = true
        synchronize()
    }

    fun refreshFromForeground() = refresh()

    internal fun settingsVisibilityChanged(visible: Boolean) {
        settingsVisible = visible
        if (visible) refresh()
        else if (mutable.value.pending == null) {
            readRequested = false
            clearRecovery()
        }
    }

    fun retry() {
        if (!current()) return
        clearRecovery()
        val state = mutable.value
        if (state.pending == null) readRequested = true
        else if (!online) mutable.value = state.copy(recovering = true)
        synchronize()
    }

    private fun synchronize() {
        if (!current() || !online || request != null || recovery != null) return
        val change = mutable.value.pending
        if (change == null && !readRequested) return
        readRequested = false
        val saving = change != null
        val verifying = saving && needsWriteReadback
        val pendingForWrite =
            change?.let {
                if (verifying || it.timezoneToWrite == null) it
                else it.copy(timezoneToReconcile = it.timezoneToWrite)
            }
        mutable.value =
            mutable.value.copy(
                pending = pendingForWrite,
                status = if (saving) PreferenceStatus.Saving else PreferenceStatus.Refreshing,
                recovering = false,
            )
        val job =
            viewModelScope.launch(start = CoroutineStart.LAZY) {
                var success = false
                try {
                    val confirmed =
                        if (change == null || verifying) service.preferences()
                        else {
                            // A failed or unreadable reply can follow a committed write.
                            needsWriteReadback = true
                            service.updatePreferences(change.request())
                        }
                    currentCoroutineContext().ensureActive()
                    if (current()) {
                        val latest = mutable.value.pending
                        val pending =
                            when {
                                verifying -> latest?.afterReadback(confirmed)
                                change != null -> latest?.after(change)
                                else -> latest
                            }
                        needsWriteReadback = false
                        mutable.value = MemberPreferencesState(confirmed, pending)
                        retryDelay = 5_000L
                        success = true
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    fail(error, saving, sent = change.takeUnless { verifying })
                } finally {
                    request = null
                    if (success) synchronize()
                }
            }
        request = job
        job.start()
    }

    private fun clearRecovery() {
        recovery?.cancel()
        recovery = null
        retryDelay = 5_000L
    }

    private fun fail(error: Exception, saving: Boolean, sent: PreferenceChange?) {
        if (!current()) return
        // Authorization/update failures retire the parent workspace before another publication.
        onFailure(error)
        if (!current()) return
        val conflict = error is ApiFailure.Http && error.status == 409 && error.code == "CONFLICT"
        val state =
            if (conflict && sent?.timezoneToWrite != null) mutable.value.afterTimezoneConflict(sent)
            else mutable.value
        val pending = state.pending != null
        val recoverable =
            when (error) {
                is ApiFailure.Network,
                is IOException -> true
                is ApiFailure.Http ->
                    error.status == 408 || error.status == 429 || error.status in 500..599
                else -> false
            }
        mutable.value =
            state.copy(
                status =
                    if (saving) PreferenceStatus.SaveFailed else PreferenceStatus.RefreshFailed,
                recovering = recoverable,
            )
        if (pending && !saving || recoverable && (pending || settingsVisible)) {
            readRequested = !pending
            if (online) {
                val wait = retryDelay
                retryDelay = (retryDelay * 2).coerceAtMost(60_000L)
                recovery =
                    viewModelScope.launch {
                        delay(wait)
                        recovery = null
                        synchronize()
                    }
            }
        }
    }

    override fun onCleared() {
        retired = true
    }
}
