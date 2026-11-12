package ai.okou.android.preferences

import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UpdatePreferencesRequestColorTheme
import ai.okou.android.api.generated.UpdatePreferencesRequestLocale
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.auth.WorkspaceSession
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
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
) {
    fun request() =
        UpdatePreferencesRequest(
            colorTheme = colorTheme?.let { UpdatePreferencesRequestColorTheme.valueOf(it.name) },
            locale = locale?.let { UpdatePreferencesRequestLocale.valueOf(it.name) },
        )
}

data class MemberPreferencesState(
    val confirmed: UserPreferences,
    val pending: PreferenceChange? = null,
    val status: PreferenceStatus = PreferenceStatus.Ready,
) {
    val busy: Boolean
        get() = status == PreferenceStatus.Saving || status == PreferenceStatus.Refreshing

    val colorTheme: UserPreferencesColorTheme
        get() = pending?.colorTheme ?: confirmed.colorTheme ?: UserPreferencesColorTheme.DEFAULT

    val supportedLocales: List<UserPreferencesLocale>
        get() = confirmed.supportedLocales.map { UserPreferencesLocale.valueOf(it.name) }

    val locale: UserPreferencesLocale
        get() =
            (pending?.locale ?: checkNotNull(confirmed.locale)).takeIf { it in supportedLocales }
                ?: UserPreferencesLocale.EN_US
}

/** Workspace-owned confirmed data and explicit user intent; native locale state is presentation. */
class MemberPreferencesModel(
    initial: UserPreferences,
    private val service: WorkspaceSession,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
) : ViewModel() {
    private val mutable = MutableStateFlow(MemberPreferencesState(initial))
    val uiState = mutable.asStateFlow()
    private var retired = false

    private fun current() = !retired && authorized()

    fun selectColorTheme(value: UserPreferencesColorTheme) {
        val state = mutable.value
        if (
            !current() || state.busy || state.pending == null && state.confirmed.colorTheme == value
        )
            return
        save((state.pending ?: PreferenceChange()).copy(colorTheme = value))
    }

    fun selectLocale(value: UserPreferencesLocale) {
        val state = mutable.value
        if (
            !current() ||
                state.busy ||
                value !in state.supportedLocales ||
                state.pending == null && state.confirmed.locale == value
        )
            return
        save((state.pending ?: PreferenceChange()).copy(locale = value))
    }

    private fun save(change: PreferenceChange) {
        if (!current() || mutable.value.busy) return
        mutable.value = mutable.value.copy(pending = change, status = PreferenceStatus.Saving)
        viewModelScope.launch {
            try {
                val saved = service.updatePreferences(change.request())
                currentCoroutineContext().ensureActive()
                if (current()) mutable.value = MemberPreferencesState(saved)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                fail(error, PreferenceStatus.SaveFailed)
            }
        }
    }

    fun refresh() {
        if (!current() || mutable.value.busy) return
        mutable.value = mutable.value.copy(status = PreferenceStatus.Refreshing)
        viewModelScope.launch {
            try {
                val saved = service.preferences()
                currentCoroutineContext().ensureActive()
                if (current()) mutable.value = MemberPreferencesState(saved)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                fail(error, PreferenceStatus.RefreshFailed)
            }
        }
    }

    fun refreshFromForeground() {
        // Locale recreation may resume after a failed save; explicit readback owns discarding
        // intent.
        if (mutable.value.pending == null) refresh()
    }

    fun retry() {
        val state = mutable.value
        when (state.status) {
            PreferenceStatus.SaveFailed -> state.pending?.let(::save)
            PreferenceStatus.RefreshFailed -> refresh()
            else -> Unit
        }
    }

    private fun fail(error: Exception, status: PreferenceStatus) {
        if (!current()) return
        // Authorization/update failures retire the parent workspace before another publication.
        onFailure(error)
        if (current()) mutable.value = mutable.value.copy(status = status)
    }

    override fun onCleared() {
        retired = true
    }
}
