package ai.okou.android.preferences

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.boundedRetryDelayMillis
import ai.okou.android.api.finiteReadRetryDelays
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UpdatePreferencesRequestColorTheme
import ai.okou.android.api.generated.UpdatePreferencesRequestLocale
import ai.okou.android.api.generated.UpdatePreferencesRequestTheme
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.WorkspaceSession
import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

private const val preferenceRefreshMillis = 10 * 60_000L

enum class PreferenceStatus {
    Ready,
    Saving,
    Refreshing,
    SaveFailed,
    SaveUnconfirmed,
    RefreshFailed,
}

internal sealed interface PreferenceSaveNotice {
    class Unconfirmed : PreferenceSaveNotice

    class Rejected(
        val timezoneOnly: Boolean,
        val rolledBack: Boolean,
        val keptAppearance: Boolean,
    ) : PreferenceSaveNotice
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

    internal fun includesAnyOf(sent: PreferenceChange): Boolean =
        (sent.theme != null && sent.theme == theme) ||
            (sent.colorTheme != null && sent.colorTheme == colorTheme) ||
            (sent.locale != null && sent.locale == locale) ||
            (sent.timezoneToWrite != null && sent.timezoneToWrite == timezoneToWrite) ||
            (sent.cloudBrowser != null && sent.cloudBrowser == cloudBrowser)
}

private fun UserPreferences.asChoice() =
    PreferenceChange(
        colorTheme = colorTheme,
        locale = locale,
        theme = theme,
        timezone = timezone,
        cloudBrowser = cloudBrowserEnabledByDefault,
    )

private fun UserPreferences.withSavedFields(sent: PreferenceChange, response: UserPreferences) =
    copy(
        colorTheme = if (sent.colorTheme != null) response.colorTheme else colorTheme,
        locale = if (sent.locale != null) response.locale else locale,
        theme = if (sent.theme != null) response.theme else theme,
        timezone = if (sent.timezoneToWrite != null) response.timezone else timezone,
        cloudBrowserEnabledByDefault =
            if (sent.cloudBrowser != null) response.cloudBrowserEnabledByDefault
            else cloudBrowserEnabledByDefault,
    )

data class MemberPreferencesState(
    val confirmed: UserPreferences,
    val pending: PreferenceChange? = null,
    val status: PreferenceStatus = PreferenceStatus.Ready,
    val recovering: Boolean = false,
    internal val timezoneConfirmation: Long = 0,
    internal val localTheme: UserPreferencesTheme? = null,
    internal val localColorTheme: UserPreferencesColorTheme? = null,
) {
    val busy: Boolean
        get() = status == PreferenceStatus.Saving || status == PreferenceStatus.Refreshing

    val colorTheme: UserPreferencesColorTheme
        get() =
            pending?.colorTheme
                ?: localColorTheme
                ?: confirmed.colorTheme
                ?: UserPreferencesColorTheme.DEFAULT

    val theme: UserPreferencesTheme
        get() = pending?.theme ?: localTheme ?: confirmed.theme ?: UserPreferencesTheme.SYSTEM

    internal val localSnapshot: CachedMemberPreferences
        get() =
            CachedMemberPreferences(
                theme,
                colorTheme,
                locale = confirmed.locale?.let(::supportedLocale),
                timezone = confirmed.timezone,
                cloudBrowser = confirmed.cloudBrowserEnabledByDefault,
            )

    val timezone: String
        get() = pending?.timezone ?: checkNotNull(confirmed.timezone)

    internal val timezoneScheduleUpdatePending: Boolean
        get() =
            pending?.timezone == null &&
                pending?.timezoneToReconcile?.let { it == confirmed.timezone } == true

    val cloudBrowser: Boolean
        get() = pending?.cloudBrowser ?: confirmed.cloudBrowserEnabledByDefault

    val supportedLocales: List<UserPreferencesLocale>
        get() = confirmed.supportedLocales.map { UserPreferencesLocale.valueOf(it.name) }

    val locale: UserPreferencesLocale
        get() = supportedLocale(pending?.locale ?: checkNotNull(confirmed.locale))

    private fun supportedLocale(locale: UserPreferencesLocale): UserPreferencesLocale =
        locale.takeIf { it in supportedLocales } ?: UserPreferencesLocale.EN_US
}

private fun MemberPreferencesState.afterTimezoneConflict(
    sent: PreferenceChange,
): MemberPreferencesState {
    // The timezone endpoint returns this conflict after saving the fields and before finishing
    // Morning Brief reconciliation. Keep the schedule repair pending and acknowledge the values.
    val timezone = checkNotNull(sent.timezoneToWrite)
    val remaining = pending?.after(sent)
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
        pending = (remaining ?: PreferenceChange()).copy(timezoneToReconcile = timezone),
        status = if (remaining == null) PreferenceStatus.SaveFailed else PreferenceStatus.Ready,
        recovering = false,
        timezoneConfirmation = timezoneConfirmation + 1,
        localTheme = localTheme.takeUnless { sent.theme != null },
        localColorTheme = localColorTheme.takeUnless { sent.colorTheme != null },
    )
}

/** Workspace-owned confirmed data and explicit user intent; native locale state is presentation. */
class MemberPreferencesModel(
    initial: UserPreferences,
    private val service: WorkspaceSession,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
    initialPending: PreferenceChange? = null,
    private val monotonicMillis: () -> Long = SystemClock::elapsedRealtime,
) : ViewModel() {
    private class Recovery(val job: Job, val protectsReadback: Boolean)

    private val mutable =
        MutableStateFlow(MemberPreferencesState(initial, initialPending?.afterReadback(initial)))
    val uiState = mutable.asStateFlow()
    private val saveNotice = MutableStateFlow<PreferenceSaveNotice?>(null)
    internal val notices = saveNotice.asStateFlow()
    private var retired = false
    private var request: Job? = null
    private var recovery: Recovery? = null
    private var saveFailures = 0
    private var readFailures = 0
    private var readRequested = false
    private var needsWriteReadback = false
    private var failedWrite: PreferenceChange? = null
    private var foreground = false
    private var settingsOpen = false
    private var nextRefreshAt = monotonicMillis() + preferenceRefreshMillis
    private var refreshTimer: Job? = null

    init {
        if (mutable.value.pending != null) synchronize()
    }

    private fun current() = !retired && authorized()

    internal fun dismissNotice(notice: PreferenceSaveNotice) {
        if (saveNotice.value === notice) saveNotice.value = null
    }

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

    fun selectTimezone(value: String, missingOnServer: Boolean = false) {
        if (!current()) return
        val state = mutable.value
        if (state.pending?.timezoneToWrite != value && (state.timezone != value || missingOnServer))
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
        saveNotice.value = null
        if (recovery?.protectsReadback == true) {
            mutable.value = mutable.value.copy(pending = change)
            return
        }
        if ((!needsWriteReadback || request == null) && saveFailures <= finiteReadRetryDelays.size)
            saveFailures = 0
        mutable.value = mutable.value.copy(pending = change, recovering = false)
        readRequested = false
        clearRecovery()
        synchronize()
    }

    internal fun refresh() {
        if (!current() || request != null || recovery != null) return
        if (mutable.value.pending != null) {
            if (mutable.value.status == PreferenceStatus.SaveUnconfirmed) synchronize()
            return
        }
        readFailures = 0
        readRequested = true
        synchronize()
    }

    internal fun foreground(active: Boolean) {
        if (foreground == active) return
        foreground = active
        if (active) {
            if (mutable.value.status == PreferenceStatus.SaveUnconfirmed) refresh()
            scheduleRefresh()
        } else {
            pauseRefresh()
        }
    }

    internal fun showSettings(visible: Boolean) {
        if (settingsOpen == visible) return
        settingsOpen = visible
        if (visible) {
            pauseRefresh()
            if (mutable.value.status == PreferenceStatus.SaveUnconfirmed) refresh()
        } else {
            scheduleRefresh()
        }
    }

    private fun scheduleRefresh() {
        refreshTimer?.cancel()
        refreshTimer = null
        if (
            !current() ||
                !foreground ||
                settingsOpen ||
                request != null ||
                recovery != null ||
                mutable.value.pending != null
        )
            return
        val timer =
            viewModelScope.launch(start = CoroutineStart.LAZY) {
                delay((nextRefreshAt - monotonicMillis()).coerceAtLeast(0))
                refreshTimer = null
                refresh()
            }
        refreshTimer = timer
        timer.start()
    }

    private fun pauseRefresh() {
        refreshTimer?.cancel()
        refreshTimer = null
        val state = mutable.value
        if (state.status != PreferenceStatus.Refreshing) return
        readRequested = false
        clearRecovery()
        mutable.value = state.copy(status = PreferenceStatus.Ready, recovering = false)
        request?.let { read ->
            // Release the slot even if cancellation happens before the request starts.
            read.invokeOnCompletion {
                viewModelScope.launch { finishRequest(read, continueSync = true) }
            }
            read.cancel()
        }
    }

    private fun finishRequest(job: Job, continueSync: Boolean) {
        if (request !== job) return
        request = null
        if (continueSync) synchronize()
        scheduleRefresh()
    }

    fun retry() {
        if (!current() || recovery?.protectsReadback == true) return
        clearRecovery()
        if (mutable.value.pending == null) readRequested = true
        synchronize()
    }

    internal fun pendingForWorkspaceRestore(): PreferenceChange? {
        val pending = mutable.value.pending
        val sent = failedWrite
        if (saveFailures <= finiteReadRetryDelays.size || sent == null) return pending
        return pending?.after(sent)
    }

    private fun synchronize() {
        if (!current() || request != null || recovery != null) return
        val change = mutable.value.pending
        if (change == null && !readRequested) return
        refreshTimer?.cancel()
        refreshTimer = null
        readRequested = false
        val saving = change != null
        val verifying = saving && needsWriteReadback
        val finalReadback = verifying && saveFailures > finiteReadRetryDelays.size
        val wasUnconfirmed = mutable.value.status == PreferenceStatus.SaveUnconfirmed
        val pendingForWrite = change?.let {
            if (verifying || it.timezoneToWrite == null) it
            else it.copy(timezoneToReconcile = it.timezoneToWrite)
        }
        mutable.value =
            mutable.value.copy(
                pending = pendingForWrite,
                status =
                    when {
                        wasUnconfirmed -> PreferenceStatus.SaveUnconfirmed
                        saving -> PreferenceStatus.Saving
                        else -> PreferenceStatus.Refreshing
                    },
                recovering = false,
            )
        val job =
            viewModelScope.launch(start = CoroutineStart.LAZY) {
                var continueSync = false
                try {
                    val response =
                        if (change == null || verifying) service.preferences()
                        else {
                            // A failed or unreadable reply can follow a committed write.
                            needsWriteReadback = true
                            service.updatePreferences(change.request())
                        }
                    currentCoroutineContext().ensureActive()
                    if (current()) {
                        if (change == null || verifying) {
                            nextRefreshAt = monotonicMillis() + preferenceRefreshMillis
                        }
                        val state = mutable.value
                        val confirmed =
                            if (change != null && !verifying)
                                state.confirmed.withSavedFields(change, response)
                            else response
                        val latest = state.pending
                        val pending =
                            when {
                                verifying -> latest?.afterReadback(confirmed)
                                change != null -> latest?.after(change)
                                else -> latest
                            }
                        needsWriteReadback = false
                        val timezoneSaved =
                            change?.timezoneToWrite?.let { it == confirmed.timezone } == true
                        val updated =
                            state.copy(
                                confirmed = confirmed,
                                pending = pending,
                                status = PreferenceStatus.Ready,
                                recovering = false,
                                timezoneConfirmation =
                                    if (timezoneSaved) state.timezoneConfirmation + 1
                                    else state.timezoneConfirmation,
                                localTheme =
                                    state.localTheme.takeIf {
                                        change != null &&
                                            (change.theme == null ||
                                                verifying && change.theme != confirmed.theme)
                                    },
                                localColorTheme =
                                    state.localColorTheme.takeIf {
                                        change != null &&
                                            (change.colorTheme == null ||
                                                verifying &&
                                                    change.colorTheme != confirmed.colorTheme)
                                    },
                            )
                        val failed = failedWrite
                        val rejected = failed.takeIf { finalReadback }
                        failedWrite = null
                        if (
                            !verifying ||
                                finalReadback ||
                                failed == null ||
                                pending?.includesAnyOf(failed) != true
                        )
                            saveFailures = 0
                        readFailures = 0
                        if (finalReadback && saveNotice.value is PreferenceSaveNotice.Unconfirmed)
                            saveNotice.value = null
                        val settled =
                            if (rejected == null) updated else finishRejected(updated, rejected)
                        mutable.value = settled
                        continueSync = settled.status == PreferenceStatus.Ready
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    continueSync = fail(error, saving, sent = change.takeUnless { verifying })
                } finally {
                    val job = checkNotNull(currentCoroutineContext()[Job])
                    finishRequest(job, continueSync || (change == null && job.isCancelled))
                }
            }
        request = job
        job.start()
    }

    private fun clearRecovery() {
        recovery?.job?.cancel()
        recovery = null
        readFailures = 0
    }

    private fun fail(error: Exception, saving: Boolean, sent: PreferenceChange?): Boolean {
        if (!current()) return false
        // Authorization/update failures retire the parent workspace before another publication.
        onFailure(error)
        if (!current()) return false
        // The preferences endpoint rejects invalid input before committing any fields.
        if (
            error is ApiFailure.Http &&
                error.status == 400 &&
                error.code == "BAD_REQUEST" &&
                sent?.timezone != null
        ) {
            val state = mutable.value
            val restored = state.pending?.copy(timezoneToReconcile = sent.timezoneToReconcile)
            val settled =
                finishRejected(
                    state.copy(pending = restored),
                    PreferenceChange(timezone = sent.timezone),
                )
            mutable.value = settled
            saveFailures = 0
            failedWrite = null
            needsWriteReadback = restored?.timezoneToReconcile != null
            return settled.status == PreferenceStatus.Ready || needsWriteReadback
        }
        val conflict = error is ApiFailure.Http && error.status == 409 && error.code == "CONFLICT"
        if (conflict && sent?.timezoneToWrite != null) {
            saveFailures = 0
            failedWrite = null
            val state = mutable.value.afterTimezoneConflict(sent)
            mutable.value = state
            // New selections can proceed after readback. A schedule repair alone waits for Retry.
            return state.status == PreferenceStatus.Ready
        }
        val state = mutable.value
        val pending = state.pending != null
        val recoverable =
            when (error) {
                is ApiFailure.Network,
                is ApiFailure.IncompatibleResponse,
                is IOException -> true
                is ApiFailure.Http ->
                    error.status == 408 || error.status == 429 || error.status in 500..599
                else -> false
            }
        if (!saving) {
            if (pending) return true
            val wait = if (recoverable) boundedRetryDelayMillis(readFailures++, error) else null
            val retry = wait != null
            mutable.value =
                state.copy(
                    status =
                        if (retry) PreferenceStatus.Refreshing else PreferenceStatus.RefreshFailed,
                    recovering = retry,
                )
            readRequested = retry
            if (wait != null) scheduleRecovery(wait)
            else nextRefreshAt = monotonicMillis() + preferenceRefreshMillis
            return false
        }
        if (
            sent != null &&
                error is ApiFailure.Http &&
                error.status == 400 &&
                error.code == "BAD_REQUEST"
        ) {
            saveFailures = 0
            failedWrite = null
            needsWriteReadback = false
            val settled = finishRejected(state, sent)
            mutable.value = settled
            return settled.status == PreferenceStatus.Ready
        }
        if (sent != null) failedWrite = sent
        val wait = if (recoverable) boundedRetryDelayMillis(saveFailures, error) else null
        saveFailures = if (wait != null) saveFailures + 1 else finiteReadRetryDelays.size + 1
        if (wait != null) {
            mutable.value = state.copy(status = PreferenceStatus.SaveFailed, recovering = true)
            val serverDelay = (error as? ApiFailure.Http)?.retryAfterSeconds ?: 0L
            scheduleRecovery(wait, protectsReadback = needsWriteReadback && serverDelay > 0)
            return false
        }
        if (sent != null) return true // Last write still needs authoritative readback.
        if (state.status != PreferenceStatus.SaveUnconfirmed)
            saveNotice.value = PreferenceSaveNotice.Unconfirmed()
        mutable.value = state.copy(status = PreferenceStatus.SaveUnconfirmed, recovering = false)
        return false
    }

    private fun finishRejected(
        state: MemberPreferencesState,
        sent: PreferenceChange,
    ): MemberPreferencesState {
        val latest = state.pending
        val theme = sent.theme?.takeIf { it == latest?.theme }
        val palette = sent.colorTheme?.takeIf { it == latest?.colorTheme }
        val timezone = sent.timezone != null && sent.timezone == latest?.timezone
        val other =
            (sent.locale != null && sent.locale == latest?.locale) ||
                (sent.cloudBrowser != null && sent.cloudBrowser == latest?.cloudBrowser)
        val keptAppearance = theme != null || palette != null
        if (timezone || other || keptAppearance)
            saveNotice.value =
                PreferenceSaveNotice.Rejected(
                    timezone && !other,
                    timezone || other,
                    keptAppearance,
                )
        val remaining =
            latest?.copy(timezoneToReconcile = null)?.after(sent.copy(timezoneToReconcile = null))
        val repair = latest?.timezoneToReconcile?.takeIf { it == state.confirmed.timezone }
        return state.copy(
            pending =
                if (repair == null) remaining
                else (remaining ?: PreferenceChange()).copy(timezoneToReconcile = repair),
            status =
                if (repair != null && remaining == null) PreferenceStatus.SaveFailed
                else PreferenceStatus.Ready,
            recovering = false,
            localTheme = theme ?: state.localTheme,
            localColorTheme = palette ?: state.localColorTheme,
        )
    }

    private fun scheduleRecovery(wait: Long, protectsReadback: Boolean = false) {
        val failedRequest = checkNotNull(request)
        val job =
            viewModelScope.launch(start = CoroutineStart.LAZY) {
                delay(wait)
                // A zero-second delay can finish before the failed request releases its slot.
                failedRequest.join()
                recovery = null
                synchronize()
            }
        recovery = Recovery(job, protectsReadback)
        job.start()
    }

    override fun onCleared() {
        retired = true
    }
}
