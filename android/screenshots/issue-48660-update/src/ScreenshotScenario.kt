package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.NativeUpdateTest
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testPreferences
import android.app.LocaleManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun captureUpdateJourney() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val locales = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocales = locales.applicationLocales
        val preferences = app.snapshotApiPreferences()
        app.restoreApiPreferences(
            preferences +
                (Triple(BuildConfig.API_ORIGIN, "user-a", "org-a") to
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                        ))
        )
        try {
            NativeUpdateTest().verifyJourney(ScreenshotCapture::capture)
        } finally {
            app.restoreApiPreferences(preferences)
            locales.applicationLocales = originalLocales
        }
    }
}
