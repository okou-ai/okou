package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.NativeUpdateTest
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testPreferences
import android.app.LocaleManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.regex.Pattern
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
            NativeUpdateTest()
                .verifyJourney(::captureAndCancelInstaller, ScreenshotCapture::capture)
        } finally {
            app.restoreApiPreferences(preferences)
            locales.applicationLocales = originalLocales
        }
    }

    private fun captureAndCancelInstaller(device: UiDevice, app: TestOkouApplication) {
        val openSettings =
            By.pkg(app.packageName).text(app.getString(R.string.updates_open_settings))
        checkNotNull(device.wait(Until.findObject(openSettings), 10_000)).click()
        val sourceSwitch = By.pkg("com.android.settings").checkable(true)
        checkNotNull(device.wait(Until.findObject(sourceSwitch), 10_000)) {
                "Android source permission switch was not visible"
            }
            .click()
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) =
                        app.packageManager.canRequestPackageInstalls()
                },
                10_000,
            )
        ) {
            "Android did not grant installation-source permission"
        }
        device.pressBack()

        val installer = "com.android.packageinstaller"
        val cancel =
            By.pkg(installer).text(Pattern.compile("^(cancel|取消)$", Pattern.CASE_INSENSITIVE))
        val dismiss =
            checkNotNull(device.wait(Until.findObject(cancel), 15_000)) {
                "Android installer confirmation was not visible"
            }
        val update =
            By.pkg(installer)
                .text(Pattern.compile("^(update|install|更新|安装)$", Pattern.CASE_INSENSITIVE))
        checkNotNull(device.wait(Until.findObject(update), 10_000))
        device.waitForIdle()
        ScreenshotCapture.capture("android-installer.png")
        dismiss.click()
        check(device.wait(Until.gone(cancel), 10_000))
        // The managed device resets this grant on teardown. Revoking it in-process kills the
        // target.
    }
}
