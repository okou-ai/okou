package ai.okou.android.settings

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.MorningBriefPreference
import ai.okou.android.api.generated.MorningBriefPreferenceStatus
import ai.okou.android.api.generated.ProactiveSuggestionsPreference
import ai.okou.android.api.generated.ProactiveSuggestionsPreferenceStatus
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable

internal enum class ProactiveSetting(val cacheKey: String) {
    MorningBrief("morning-brief"),
    Suggestions("suggestions-with-feed"),
}

@Serializable
internal enum class ProactiveStatus {
    Preparing,
    Enabled,
    Paused,
    Error,
}

@Serializable
internal data class ProactivePreference(
    val enabled: Boolean,
    val status: ProactiveStatus,
    val needsTimezone: Boolean,
    val cardsEnabled: Boolean? = null,
) {
    val partial: Boolean
        get() = cardsEnabled != null && cardsEnabled != enabled

    fun matches(choice: Boolean) = !partial && enabled == choice
}

class ProactivePreferencesService internal constructor(private val api: ApiClient) {
    internal suspend fun read(setting: ProactiveSetting): ProactivePreference? =
        when (setting) {
            ProactiveSetting.MorningBrief -> api.morningBriefPreference().toPreference()
            ProactiveSetting.Suggestions -> readSuggestions()
        }

    private suspend fun readSuggestions(): ProactivePreference? {
        if (api.featureSwitches().effectiveSwitches["agentSuggestion"] != true) return null
        return try {
            coroutineScope {
                val sources = async { api.suggestionFeedSources() }
                api.proactiveSuggestionsPreference().toPreference(sources.await().suggestions)
            }
        } catch (error: ApiFailure.Http) {
            if (error.status == 403) null else throw error
        }
    }

    internal suspend fun update(setting: ProactiveSetting, enabled: Boolean): ProactivePreference =
        when (setting) {
            ProactiveSetting.MorningBrief -> api.setMorningBriefPreference(enabled).toPreference()
            ProactiveSetting.Suggestions -> {
                val saved = api.setProactiveSuggestionsWithFeed(enabled)
                // The response confirms the automation preference. The same transaction sets
                // card delivery to the requested value, even if schedule preparation failed.
                saved.toPreference(enabled)
            }
        }
}

private fun MorningBriefPreference.toPreference() =
    ProactivePreference(
        enabled,
        when (status) {
            MorningBriefPreferenceStatus.PREPARING -> ProactiveStatus.Preparing
            MorningBriefPreferenceStatus.ENABLED -> ProactiveStatus.Enabled
            MorningBriefPreferenceStatus.PAUSED -> ProactiveStatus.Paused
            MorningBriefPreferenceStatus.ERROR -> ProactiveStatus.Error
        },
        unavailableReason != null,
    )

private fun ProactiveSuggestionsPreference.toPreference(cardsEnabled: Boolean) =
    ProactivePreference(
        enabled,
        when (status) {
            ProactiveSuggestionsPreferenceStatus.PREPARING -> ProactiveStatus.Preparing
            ProactiveSuggestionsPreferenceStatus.ENABLED -> ProactiveStatus.Enabled
            ProactiveSuggestionsPreferenceStatus.PAUSED -> ProactiveStatus.Paused
            ProactiveSuggestionsPreferenceStatus.ERROR -> ProactiveStatus.Error
        },
        unavailableReason != null,
        cardsEnabled,
    )
