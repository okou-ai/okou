package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.EmailSubscription
import ai.okou.android.api.generated.EmailSubscriptionDeliveryStatus
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal val EmailSubscription.canReceive: Boolean
    get() = deliveryStatus == EmailSubscriptionDeliveryStatus.AVAILABLE && !email.isNullOrBlank()

internal enum class SettingsNotice {
    ModelAccountSwitchFailed,
    CreditBalanceRefreshFailed,
    EmailSubscriptionFailed,
    EmailSubscriptionUnconfirmed,
    ToolSaveFailed,
    ToolSaveUnconfirmed,
}

internal data class EmailSubscriptionState(
    val read: SettingsRead<EmailSubscription> = SettingsRead(),
    val desired: Boolean? = null,
    val unconfirmed: Boolean? = null,
    val updateFailed: Boolean = false,
) {
    val checked: Boolean?
        get() = read.value?.let { desired ?: it.subscribed }

    val canChange: Boolean
        get() = read.value?.canReceive == true && desired == null
}

/** The preference belongs to the account. Requests use the active authorized workspace. */
internal class EmailSubscriptionSettings(
    private val scope: CoroutineScope,
    private val service: WorkspaceSession,
    private val identity: WorkspaceIdentity,
    private val cache: WorkspaceSettingsCache?,
    private val authorized: () -> Boolean,
    private val onSessionFailure: (Exception) -> Unit,
    private val nowMillis: () -> Long,
    private val notice: (SettingsNotice) -> Unit,
) {
    private val mutable = MutableStateFlow(EmailSubscriptionState())
    val state = mutable.asStateFlow()

    private var panelOpen = false
    private var visible = false
    private var restored = false
    private var readRequested = false
    private var reading = false
    private var work: Job? = null

    fun setPanelOpen(open: Boolean) {
        panelOpen = open
        if (!open) {
            val current = mutable.value
            mutable.value =
                current.copy(updateFailed = false, read = current.read.copy(refreshFailure = null))
        }
    }

    fun visible(active: Boolean) {
        if (visible == active) return
        visible = active
        readRequested = active
        if (!active && reading) work?.cancel()
        synchronize()
    }

    fun subscribe(subscribed: Boolean) {
        val current = mutable.value
        if (!authorized() || !current.canChange || current.checked == subscribed) return
        mutable.value = current.copy(desired = subscribed, updateFailed = false)
        if (reading && work?.isActive == true) {
            readRequested = visible
            work?.cancel()
        }
        synchronize()
    }

    private fun synchronize() {
        if (work != null || !scope.isActive || !authorized()) return
        val current = mutable.value
        val write = current.desired != null && current.unconfirmed == null
        if (!write && (!readRequested || !visible)) return
        reading = !write
        if (reading) readRequested = false
        val job =
            scope.launch(start = CoroutineStart.LAZY) {
                if (write) save() else readVisible()
            }
        work = job
        // A rapid dismiss can cancel a scheduled read before its body starts.
        job.invokeOnCompletion {
            scope.launch {
                work = null
                reading = false
                synchronize()
            }
        }
        job.start()
    }

    private suspend fun readVisible() {
        if (!restored) {
            val stored = cache?.loadEmail(identity)
            requireOwner()
            val current = mutable.value
            mutable.value =
                current.copy(
                    read =
                        if (stored == null) SettingsRead()
                        else SettingsRead(stored.value, readAt = stored.readAt),
                )
            restored = true
        }
        refresh(mutable.value.unconfirmed)
    }

    private suspend fun refresh(attempted: Boolean?) {
        val before = mutable.value
        mutable.value =
            before.copy(
                read =
                    before.read.copy(
                        unavailable = before.read.value != null && before.read.unavailable,
                        refreshing = before.read.isStale(nowMillis()),
                        refreshFailure = null,
                    ),
            )
        try {
            val snapshot = fetch()
            publish(snapshot, nowMillis(), attempted)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            requireOwner()
            onSessionFailure(error)
            requireOwner()
            val current = mutable.value
            if (error is ApiFailure.Http && error.status == 403) {
                clearInaccessible(writeRejected = attempted != null)
            } else if (attempted == null) {
                mutable.value =
                    current.copy(
                        read =
                            current.read.copy(
                                unavailable = true,
                                refreshFailure =
                                    if (panelOpen && current.read.value != null)
                                        SettingsRefreshFailure()
                                    else null,
                            ),
                    )
            } else {
                mutable.value = current.copy(unconfirmed = attempted)
                if (current.unconfirmed == null && !panelOpen) {
                    notice(SettingsNotice.EmailSubscriptionUnconfirmed)
                }
            }
        } finally {
            val current = mutable.value
            mutable.value = current.copy(read = current.read.copy(refreshing = false))
        }
    }

    private suspend fun fetch(): EmailSubscription {
        var retries = settingsReadAttempts - 1
        while (true) {
            requireOwner()
            try {
                return service.emailSubscription().also { requireOwner() }
            } catch (error: Exception) {
                if (!error.retryableSettingsRead() || retries == 0) throw error
                retries--
                delay(settingsReadRetryDelayMillis)
            }
        }
    }

    private suspend fun save() {
        val current = mutable.value
        val attempted = checkNotNull(current.desired)
        val confirmed = checkNotNull(current.read.value)
        if (attempted == confirmed.subscribed || !confirmed.canReceive) {
            mutable.value = current.copy(desired = null)
            return
        }
        repeat(settingsReadAttempts) { attempt ->
            requireOwner()
            try {
                val result = service.updateEmailSubscription(attempted)
                requireOwner()
                if (result.subscribed == attempted) {
                    publish(confirmed.copy(subscribed = attempted), current.read.readAt, attempted)
                } else {
                    refresh(attempted)
                }
                return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                requireOwner()
                onSessionFailure(error)
                requireOwner()
                if (error is ApiFailure.Http && error.status == 403) {
                    clearInaccessible(writeRejected = true)
                    return
                }
                val undelivered = error is ApiFailure.Network && error.connectionFailed
                val throttled = error is ApiFailure.Http && error.status == 429
                val rejected =
                    error is ApiFailure.Http && error.status in 400..499 && error.status != 408
                if (!undelivered && !rejected) {
                    refresh(attempted)
                    return
                }
                if ((undelivered || throttled) && attempt < settingsReadAttempts - 1) {
                    delay(settingsReadRetryDelayMillis)
                    return@repeat
                }
                reject(mutable.value)
                return
            }
        }
    }

    private fun publish(value: EmailSubscription, readAt: Long?, attempted: Boolean?) {
        val resolved =
            mutable.value.copy(
                read = SettingsRead(value, readAt = readAt),
                desired = null,
                unconfirmed = null,
            )
        if (attempted != null && value.subscribed != attempted) reject(resolved)
        else mutable.value = resolved
        if (readAt != null) cache?.saveEmail(identity, ConfirmedSetting(value, readAt))
    }

    private fun clearInaccessible(writeRejected: Boolean) {
        cache?.saveEmail(identity, null)
        val cleared =
            mutable.value.copy(
                read = SettingsRead(unavailable = true),
                desired = null,
                unconfirmed = null,
            )
        if (writeRejected) reject(cleared) else mutable.value = cleared
    }

    private fun reject(state: EmailSubscriptionState) {
        mutable.value = state.copy(desired = null, unconfirmed = null, updateFailed = panelOpen)
        if (!panelOpen) notice(SettingsNotice.EmailSubscriptionFailed)
    }

    private suspend fun requireOwner() {
        currentCoroutineContext().ensureActive()
        if (!authorized()) throw CancellationException("Settings owner retired")
    }
}
