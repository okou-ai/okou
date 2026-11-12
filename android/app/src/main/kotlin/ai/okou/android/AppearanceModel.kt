package ai.okou.android

import androidx.annotation.MainThread
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class AppearanceMode(val storedValue: String) {
    System("system"),
    Light("light"),
    Dark("dark");

    fun resolveDark(systemDark: Boolean): Boolean =
        when (this) {
            System -> systemDark
            Light -> false
            Dark -> true
        }
}

sealed interface AppearanceStatus {
    data object Loading : AppearanceStatus

    data object Ready : AppearanceStatus

    data class Saving(val requested: AppearanceMode) : AppearanceStatus

    data class AwaitingConfirmation(val requested: AppearanceMode) : AppearanceStatus

    data object ReadFailed : AppearanceStatus

    data class WriteFailed(val requested: AppearanceMode) : AppearanceStatus
}

data class AppearanceUiState(
    val mode: AppearanceMode = AppearanceMode.System,
    val status: AppearanceStatus = AppearanceStatus.Loading,
) {
    val canSelect: Boolean
        get() = status == AppearanceStatus.Ready || status is AppearanceStatus.WriteFailed
}

class AppearanceModel(private val store: DataStore<Preferences>) : ViewModel() {
    private val mutableState = MutableStateFlow(AppearanceUiState())
    val uiState = mutableState.asStateFlow()
    private var observation: Job? = null

    init {
        observePreferences()
    }

    private fun observePreferences() {
        observation?.cancel()
        mutableState.update { it.copy(status = AppearanceStatus.Loading) }
        observation =
            viewModelScope.launch {
                store.data
                    .map { preferences ->
                        val saved = preferences[MODE_KEY]
                        if (saved == null) AppearanceMode.System
                        else
                            AppearanceMode.entries.find { it.storedValue == saved }
                                ?: throw IOException("Unsupported stored appearance")
                    }
                    .catch { error ->
                        if (error !is IOException) throw error
                        mutableState.update { it.copy(status = AppearanceStatus.ReadFailed) }
                    }
                    .collect { mode ->
                        mutableState.update {
                            it.copy(
                                mode = mode,
                                status =
                                    when (val status = it.status) {
                                        AppearanceStatus.Loading,
                                        AppearanceStatus.ReadFailed -> AppearanceStatus.Ready
                                        is AppearanceStatus.AwaitingConfirmation ->
                                            if (mode == status.requested) AppearanceStatus.Ready
                                            else status
                                        else -> it.status
                                    },
                            )
                        }
                    }
            }
    }

    @MainThread
    fun selectMode(mode: AppearanceMode) {
        val state = mutableState.value
        if (!state.canSelect) return
        if (mode == state.mode) {
            mutableState.update { it.copy(status = AppearanceStatus.Ready) }
            return
        }
        mutableState.update { it.copy(status = AppearanceStatus.Saving(mode)) }
        viewModelScope.launch {
            try {
                store.edit { it[MODE_KEY] = mode.storedValue }
                // The data Flow is the only publisher of the confirmed mode.
                mutableState.update {
                    if (it.status is AppearanceStatus.Saving) {
                        it.copy(
                            status =
                                if (it.mode == mode) AppearanceStatus.Ready
                                else AppearanceStatus.AwaitingConfirmation(mode)
                        )
                    } else it
                }
            } catch (error: IOException) {
                mutableState.update { it.copy(status = AppearanceStatus.WriteFailed(mode)) }
            }
        }
    }

    @MainThread
    fun retry() {
        when (val status = mutableState.value.status) {
            AppearanceStatus.ReadFailed -> observePreferences()
            is AppearanceStatus.WriteFailed -> selectMode(status.requested)
            else -> Unit
        }
    }

    private companion object {
        val MODE_KEY = stringPreferencesKey("mode")
    }
}
