package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.InstructionsApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import android.app.LocaleManager
import android.view.KeyEvent
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication

    @Test
    fun captureSettingsAndEveryDestination() {
        val priorSession = auth.state.value
        val priorAccount = auth.account.value
        val priorPreferences = app.snapshotApiPreferences()
        val priorInstructions = app.instructionsService
        val priorUpdates = app.updateOwner
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val priorLocale = localeManager.applicationLocales
        val priorFontScale = device.executeShellCommand("settings get system font_scale").trim()
        val priorSize = overrideValue("wm size")
        val priorDensity = overrideValue("wm density")
        val finishDownload = CompletableDeferred<File>()
        val instructions = InstructionsApiFixture()
        val owner = updates(finishDownload)
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            auth.state.value = testAuthenticationState(user = "settings-capture")
            auth.account.value = NativeAccount("settings-capture", "example@okou.test")
            app.restoreApiPreferences(
                mapOf(
                    Triple(BuildConfig.API_ORIGIN, "settings-capture", "org-a") to
                        testPreferences()
                            .copy(
                                locale = UserPreferencesLocale.ZH_HANS,
                                theme = UserPreferencesTheme.LIGHT,
                            )
                )
            )
            instructions.externalEdit("先给结论，再写关键依据。需要我的决定时，请指出最重要的取舍。")
            app.instructionsService = instructions.service
            app.updateOwner = owner
            setWindow("1080x2340", "440", "1.0")
            scenario = ActivityScenario.launch(MainActivity::class.java)
            awaitWindow(scenario, 360..430, 1f)
            tapDescription(R.string.chat_more_actions)
            tap(R.string.settings)
            waitForText(R.string.appearance)
            capture("01-settings.png")

            tap(R.string.appearance)
            waitForText(R.string.appearance_dark)
            capture("02-display-mode.png")
            backToSettings()

            tap(R.string.preference_color_theme)
            waitForText(R.string.palette_deep_lagoon)
            capture("03-color-theme.png")
            backToSettings()

            tap(R.string.preference_language)
            waitForText(R.string.language_en_us)
            capture("04-language.png")
            backToSettings()

            tap(R.string.settings_switch)
            waitForText("Workspace B")
            capture("05-workspace.png")
            backToSettings()

            tap(R.string.instructions_title)
            val editor =
                checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).clazz("android.widget.EditText")),
                        WAIT,
                    )
                )
            editor.text = "先给结论，再写关键依据。需要我决定时，请列出最重要的取舍。"
            checkNotNull(
                device.wait(
                    Until.findObject(
                        By.pkg(app.packageName)
                            .text(app.getString(R.string.instructions_save))
                            .enabled(true)
                    ),
                    WAIT,
                )
            )
            if (
                instrumentation.uiAutomation.windows.any {
                    it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
                }
            )
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            capture("06-instructions.png")
            backToSettings()

            tap(R.string.auth_sign_out)
            waitForText(R.string.settings_sign_out_title)
            capture("07-sign-out.png")
            backToSettings()

            tap(R.string.updates_title)
            waitForText(app.getString(R.string.updates_version, "99.0.0"))
            capture("08-update.png")
            tap(R.string.updates_download)
            waitForText(app.getString(R.string.updates_downloading, "50%"))
            capture("09-update-progress.png")
            tap(R.string.updates_close)
            waitForText(R.string.appearance)

            setWindow("1400x1000", "160", "1.0")
            awaitWindow(scenario, 1000..1500, 1f)
            tap(R.string.preference_color_theme)
            waitForText(R.string.palette_deep_lagoon)
            capture("10-wide-palette.png")
            backToSettings()

            setWindow("1080x2340", "440", "2.0")
            awaitWindow(scenario, 360..430, 2f)
            tap(R.string.preference_color_theme)
            waitForText(R.string.palette_default)
            capture("11-large-type-palette.png")
        } catch (failure: Throwable) {
            runCatching {
                    ScreenshotCapture.capture("settings-capture-failure.png")
                    TestStorage().openOutputFile("settings-capture-hierarchy.xml").use {
                        device.dumpWindowHierarchy(it)
                    }
                }
                .exceptionOrNull()
                ?.let(failure::addSuppressed)
            throw failure
        } finally {
            scenario?.close()
            owner.close()
            instructions.close()
            app.updateOwner = priorUpdates
            app.instructionsService = priorInstructions
            app.restoreApiPreferences(priorPreferences)
            auth.account.value = priorAccount
            auth.state.value = priorSession
            localeManager.applicationLocales = priorLocale
            device.executeShellCommand("wm size ${priorSize ?: "reset"}")
            device.executeShellCommand("wm density ${priorDensity ?: "reset"}")
            if (priorFontScale.toFloatOrNull() == null)
                device.executeShellCommand("settings delete system font_scale")
            else device.executeShellCommand("settings put system font_scale $priorFontScale")
        }
    }

    private fun backToSettings() {
        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        waitForText(R.string.appearance)
    }

    private fun tap(label: Int) = waitForText(label).click()

    private fun tapDescription(label: Int) =
        checkNotNull(
                device.wait(
                    Until.findObject(By.pkg(app.packageName).desc(app.getString(label))),
                    WAIT,
                )
            )
            .click()

    private fun waitForText(label: Int) = waitForText(app.getString(label))

    private fun waitForText(label: String): UiObject2 {
        val target = By.pkg(app.packageName).text(label)
        device.waitForIdle()
        if (!device.hasObject(target)) {
            val reveal =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(target)
                }
            val scroll = device.findObject(By.pkg(app.packageName).scrollable(true))
            if (scroll?.scrollUntil(Direction.UP, reveal) != true)
                scroll?.scrollUntil(Direction.DOWN, reveal)
        }
        return checkNotNull(device.wait(Until.findObject(target), WAIT)) {
            "Expected visible setting: $label"
        }
    }

    private fun capture(file: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(file)
    }

    private fun overrideValue(command: String) =
        device
            .executeShellCommand(command)
            .lineSequence()
            .firstOrNull { it.startsWith("Override ") }
            ?.substringAfter(": ")

    private fun setWindow(size: String, density: String, font: String) {
        device.executeShellCommand("wm size $size")
        device.executeShellCommand("wm density $density")
        device.executeShellCommand("settings put system font_scale $font")
    }

    private fun awaitWindow(
        scenario: ActivityScenario<MainActivity>,
        width: IntRange,
        font: Float,
    ) {
        assertTrue(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        var ready = false
                        scenario.onActivity { activity ->
                            val configuration = activity.resources.configuration
                            ready =
                                configuration.screenWidthDp in width &&
                                    configuration.fontScale == font &&
                                    configuration.locales[0].toLanguageTag().startsWith("zh")
                        }
                        return ready
                    }
                },
                WAIT,
            ) == true
        )
    }

    private fun updates(finish: CompletableDeferred<File>): AppUpdates {
        val release =
            AndroidUpdatesRelease(
                "99.0.0",
                24,
                42_000_000,
                "a".repeat(64),
                "https://static.okou.io/android-updates/releases/99.0.0/${"a".repeat(64)}.apk",
                "",
            )
        return AppUpdates(
            object : UpdateService {
                override suspend fun initialize() = Unit

                override suspend fun check() = AndroidUpdates(null, release)

                override suspend fun recover(release: AndroidUpdatesRelease): File? = null

                override suspend fun download(
                    release: AndroidUpdatesRelease,
                    progress: (Long) -> Unit,
                ): File {
                    progress(release.size / 2)
                    return finish.await()
                }

                override fun close() = Unit
            },
            object : UpdateStore {
                override suspend fun load(): UpdateRecord? = null

                override suspend fun save(record: UpdateRecord) = Unit
            },
            BuildConfig.VERSION_NAME,
            35,
        )
    }

    private companion object {
        const val WAIT = 15_000L
    }
}
