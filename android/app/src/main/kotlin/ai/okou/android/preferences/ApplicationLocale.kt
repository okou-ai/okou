package ai.okou.android.preferences

import ai.okou.android.api.generated.UserPreferencesLocale
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import java.util.Locale

fun UserPreferencesLocale.languageTag(): String =
    Locale.forLanguageTag(name.replace('_', '-')).toLanguageTag()

/** Invoked on Main only after the root verifies the presented workspace generation. */
internal fun applyApplicationLocale(locale: UserPreferencesLocale) =
    updateApplicationLocales(LocaleListCompat.forLanguageTags(locale.languageTag()))

internal fun resetApplicationLocale() =
    updateApplicationLocales(LocaleListCompat.getEmptyLocaleList())

private fun updateApplicationLocales(requested: LocaleListCompat) {
    if (AppCompatDelegate.getApplicationLocales() != requested) {
        AppCompatDelegate.setApplicationLocales(requested)
    }
}
