package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.boundedApiRetryDelayMillis
import ai.okou.android.api.boundedRetryDelayMillis
import ai.okou.android.auth.WorkspaceIdentity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

internal enum class ProactiveSaveFailure {
    Rejected,
    Unconfirmed,
}

internal data class ProactiveNotice(
    val setting: ProactiveSetting,
    val failure: ProactiveSaveFailure,
)

internal data class ProactiveChoice(val enabled: Boolean, val visit: Long)

internal data class ProactiveSettingState(
    val confirmed: ProactivePreference? = null,
    val choice: ProactiveChoice? = null,
    val checking: ProactiveChoice? = null,
    val readFailed: Boolean = false,
    val hidden: Boolean = false,
) {
    val pending: Boolean?
        get() = choice?.enabled

    val enabled: Boolean?
        get() = pending ?: confirmed?.enabled

    val canChoose: Boolean
        get() = confirmed != null && checking == null
}

/** Two independently readable settings, owned by the authorized workspace. */
internal class ProactiveSettingsModel(
    scope: CoroutineScope,
    service: ProactivePreferencesService,
    identity: WorkspaceIdentity,
    cache: WorkspaceSettingsCache?,
    authorized: () -> Boolean,
    onSessionFailure: (Exception) -> Unit,
) {
    private val mutableNotices = MutableSharedFlow<ProactiveNotice>(extraBufferCapacity = 4)
    val notices = mutableNotices.asSharedFlow()

    private val settings =
        ProactiveSetting.entries.associateWith { setting ->
            ProactiveSettingOwner(
                setting,
                scope,
                service,
                identity,
                cache,
                authorized,
                onSessionFailure,
            ) { failure ->
                mutableNotices.tryEmit(ProactiveNotice(setting, failure))
            }
        }
    val morningBrief = settings.getValue(ProactiveSetting.MorningBrief)
    val suggestions = settings.getValue(ProactiveSetting.Suggestions)

    fun visible(visible: Boolean) = settings.values.forEach { it.visible(visible) }

    fun refresh() = settings.values.forEach { it.refresh() }
}

/** Serializes one preference without holding the other setting while it reads or writes. */
internal class ProactiveSettingOwner(
    private val setting: ProactiveSetting,
    private val scope: CoroutineScope,
    private val service: ProactivePreferencesService,
    private val identity: WorkspaceIdentity,
    private val cache: WorkspaceSettingsCache?,
    private val authorized: () -> Boolean,
    private val onSessionFailure: (Exception) -> Unit,
    private val notice: (ProactiveSaveFailure) -> Unit,
) {
    private val mutable = MutableStateFlow(ProactiveSettingState())
    val state = mutable.asStateFlow()
    private var visit = 0L
    private var visible = false
    private var restored = false
    private var readRequested = false
    private var reading: Job? = null
    private var writing: Job? = null

    fun visible(value: Boolean) {
        if (visible == value) return
        visible = value
        if (value) {
            visit++
            refresh()
        } else {
            readRequested = false
            cancelRead()
        }
    }

    fun refresh() {
        if (!authorized() || !visible) return
        if (writing?.isActive == true || reading?.isActive == true) {
            readRequested = true
            return
        }
        readRequested = false
        reading = scope.launch {
            try {
                restore()
                val value = readPreference()
                val sent = mutable.value.checking
                publish(value)
                if (sent != null) resolve(sent, value)
                if (mutable.value.choice != null) submitChanges()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                failedRead(error)
            } finally {
                if (reading == currentCoroutineContext()[Job]) {
                    reading = null
                    refreshIfRequested()
                }
            }
        }
    }

    fun choose(enabled: Boolean) {
        val state = mutable.value
        if (!authorized() || !visible || !state.canChoose || state.hidden) return
        if (setting == ProactiveSetting.MorningBrief && state.confirmed?.needsTimezone == true)
            return
        if (
            state.pending == enabled ||
                state.choice == null && state.confirmed?.matches(enabled) == true
        )
            return
        cancelRead()
        mutable.value = state.copy(choice = ProactiveChoice(enabled, visit))
        submitChanges()
    }

    private fun cancelRead() {
        val retiring = reading
        // A cancellation can run the reader's cleanup on this dispatcher immediately.
        reading = null
        retiring?.cancel()
    }

    private fun refreshIfRequested() {
        if (!readRequested) return
        readRequested = false
        refresh()
    }

    private suspend fun restore() {
        if (restored) return
        val saved = cache?.load(identity, setting.cacheKey, ProactivePreference.serializer())
        requireCurrent()
        restored = true
        mutable.value = mutable.value.copy(confirmed = saved?.value)
    }

    private suspend fun readPreference(): ProactivePreference? {
        var retries = 0
        while (true) {
            try {
                return readOnce()
            } catch (error: ApiFailure) {
                val wait = error.boundedApiRetryDelayMillis(retries++) ?: throw error
                delay(wait)
            }
        }
    }

    private suspend fun readOnce(): ProactivePreference? {
        requireCurrent()
        return service.read(setting).also { requireCurrent() }
    }

    private fun submitChanges() {
        if (writing?.isActive == true || mutable.value.checking != null) return
        writing = scope.launch {
            try {
                while (true) {
                    val sent = mutable.value.choice ?: break
                    requireCurrent()
                    val before = mutable.value.confirmed
                    if (before?.matches(sent.enabled) == true) {
                        resolve(sent, before)
                        continue
                    }
                    write(sent)
                    if (mutable.value.checking != null) break
                }
            } finally {
                writing = null
                refreshIfRequested()
            }
        }
    }

    private suspend fun write(sent: ProactiveChoice) {
        val value =
            try {
                send(sent) ?: return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireCurrent()
                onSessionFailure(error)
                requireCurrent()
                if (error is ApiFailure.Network && error.connectionFailed) {
                    resolve(sent, mutable.value.confirmed, rejected = true)
                    return
                }
                if (
                    error is ApiFailure.Http &&
                        error.status in 400..499 &&
                        error.status !in setOf(408, 409, 429)
                ) {
                    if (error.status == 403) discardConfirmation()
                    resolve(sent, mutable.value.confirmed, rejected = true)
                    if (error.code == "MORNING_BRIEF_MISSING_TIMEZONE") readRequested = true
                    return
                }
                reconcile(sent)
                return
            }
        publish(value)
        resolve(sent, value)
    }

    private suspend fun send(sent: ProactiveChoice): ProactivePreference? {
        var retries = 0
        while (true) {
            try {
                return service.update(setting, sent.enabled).also { requireCurrent() }
            } catch (error: ApiFailure.Network) {
                if (!error.connectionFailed) throw error
                val wait = boundedRetryDelayMillis(retries++, error) ?: throw error
                delay(wait)
                requireCurrent()
                if (mutable.value.choice != sent) return null
            }
        }
    }

    private suspend fun reconcile(sent: ProactiveChoice) {
        try {
            val value = readPreference()
            publish(value)
            resolve(sent, value)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            requireCurrent()
            failedRead(error)
            if (error is ApiFailure.Http && error.status == 403) {
                resolve(sent, null, rejected = true)
                return
            }
            val remaining = mutable.value.choice.takeUnless { it == sent }
            mutable.value = mutable.value.copy(choice = remaining, checking = sent)
            if (remaining == null) notify(sent, ProactiveSaveFailure.Unconfirmed)
        }
    }

    private fun publish(value: ProactivePreference?) {
        if (value == null) {
            discardConfirmation()
        } else {
            mutable.value =
                mutable.value.copy(confirmed = value, readFailed = false, hidden = false)
            cache?.save(
                identity,
                setting.cacheKey,
                ProactivePreference.serializer(),
                ConfirmedSetting(value, System.currentTimeMillis()),
            )
        }
    }

    private fun discardConfirmation() {
        val hide = setting == ProactiveSetting.Suggestions
        mutable.value =
            mutable.value.copy(
                confirmed = null,
                choice = null,
                checking = null,
                readFailed = !hide,
                hidden = hide,
            )
        cache?.save(identity, setting.cacheKey, ProactivePreference.serializer(), null)
    }

    private fun resolve(
        sent: ProactiveChoice,
        value: ProactivePreference?,
        rejected: Boolean = false,
    ) {
        val current = mutable.value.choice == sent
        val remaining = mutable.value.choice.takeUnless { current }
        mutable.value = mutable.value.copy(choice = remaining, checking = null)
        if (remaining == null && (rejected || current && value?.matches(sent.enabled) != true)) {
            notify(sent, ProactiveSaveFailure.Rejected)
        }
    }

    private suspend fun failedRead(error: Exception) {
        requireCurrent()
        onSessionFailure(error)
        requireCurrent()
        if (error is ApiFailure.Http && error.status == 403) discardConfirmation()
        else mutable.value = mutable.value.copy(readFailed = true)
    }

    private fun notify(sent: ProactiveChoice, failure: ProactiveSaveFailure) {
        if (visible && sent.visit == visit) notice(failure)
    }

    private suspend fun requireCurrent() {
        currentCoroutineContext().ensureActive()
        if (!authorized()) throw CancellationException("Proactive preferences owner retired")
    }
}
