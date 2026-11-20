package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.testPreferences
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import android.app.LocaleManager
import android.os.Build
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun captureDefaultDark() =
        capture("default-dark", UserPreferencesColorTheme.DEFAULT, UserPreferencesTheme.DARK)

    @Test
    fun captureGoldenHourLight() =
        capture(
            "golden-hour-light",
            UserPreferencesColorTheme.GOLDEN_HOUR,
            UserPreferencesTheme.LIGHT,
        )

    private fun capture(
        name: String,
        palette: UserPreferencesColorTheme,
        theme: UserPreferencesTheme,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val locales = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocales = locales.applicationLocales
        val originalPreferences = app.snapshotApiPreferences()
        val originalOwner = app.updateOwner
        val release =
            AndroidUpdatesRelease(
                "99.0.0",
                24,
                10_200_000,
                "a".repeat(64),
                "https://static.okou.io/android-updates/releases/99.0.0/${"a".repeat(64)}.apk",
                "",
            )
        val candidate = AtomicReference(release.copy(version = BuildConfig.VERSION_NAME))
        val checkGate = CompletableDeferred<Unit>()
        val owner =
            AppUpdates(
                object : UpdateService {
                    override suspend fun initialize() = Unit

                    override suspend fun check(): AndroidUpdates {
                        checkGate.await()
                        return AndroidUpdates(null, candidate.get())
                    }

                    override suspend fun recover(release: AndroidUpdatesRelease): File? = null

                    override suspend fun download(
                        release: AndroidUpdatesRelease,
                        progress: (Long) -> Unit,
                    ): File {
                        progress(release.size / 2)
                        awaitCancellation()
                    }

                    override fun close() = Unit
                },
                object : UpdateStore {
                    override suspend fun load(): UpdateRecord? = null

                    override suspend fun save(record: UpdateRecord) = Unit
                },
                BuildConfig.VERSION_NAME,
                Build.VERSION.SDK_INT,
            )
        try {
            app.restoreApiPreferences(
                originalPreferences +
                    (Triple(BuildConfig.API_ORIGIN, "user-a", "org-a") to
                        testPreferences()
                            .copy(
                                locale = UserPreferencesLocale.ZH_HANS,
                                colorTheme = palette,
                                theme = theme,
                            ))
            )
            app.updateOwner = owner
            ActivityScenario.launch(MainActivity::class.java).use {
                fun text(label: String) =
                    checkNotNull(
                        device.wait(Until.findObject(By.pkg(app.packageName).text(label)), 10_000)
                    ) {
                        "Expected visible native text: $label"
                    }
                fun text(resource: Int) = text(app.getString(resource))
                fun screenshot(state: String) {
                    device.waitForIdle()
                    ScreenshotCapture.capture("$state-$name.png")
                }

                device.awaitChatList(app)
                val settings = By.pkg(app.packageName).desc(app.getString(R.string.settings))
                checkNotNull(device.wait(Until.findObject(settings), 10_000)).click()
                text(R.string.updates_title).click()
                text(R.string.updates_checking)
                text(R.string.updates_check_in_progress)
                screenshot("checking")
                checkGate.complete(Unit)
                text(R.string.updates_current)
                candidate.set(release)
                text(R.string.updates_check).click()
                val updateTarget = app.getString(R.string.updates_target, release.version)
                text(updateTarget)
                device.pressBack()
                check(device.wait(Until.gone(By.pkg(app.packageName).text(updateTarget)), 10_000))
                text(R.string.updates_title)
                device.pressBack()
                device.awaitChatList(app)
                text(R.string.updates_toolbar).click()
                text("50%").click()
                text(updateTarget)
                val progress = app.getString(R.string.updates_downloading, "50%")
                text(progress)
                screenshot("progress")
                text(R.string.updates_close).click()
                check(device.wait(Until.gone(By.pkg(app.packageName).text(updateTarget)), 10_000))
                owner.requireUpdate(RequiredUpdate(release.version))
                text(R.string.updates_required)
                text(progress)
                screenshot("required-progress")
            }
        } finally {
            owner.close()
            app.updateOwner = originalOwner
            app.restoreApiPreferences(originalPreferences)
            locales.applicationLocales = originalLocales
        }
    }
}
