package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.InstructionsApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.view.KeyEvent
import android.view.accessibility.AccessibilityWindowInfo
import androidx.lifecycle.ViewModelProvider
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
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication
    private val wait = 10_000L

    @Test
    fun capturePersonalInstructions() {
        val priorSession = auth.state.value
        val priorAccount = auth.account.value
        val priorPreferences = app.snapshotApiPreferences()
        val priorService = app.instructionsService
        val priorOnline = app.connectivity.value
        val locales = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val priorLocales = locales.applicationLocales
        val priorFont = device.executeShellCommand("settings get system font_scale").trim()
        val priorSize = overrideValue("wm size")
        val priorDensity = overrideValue("wm density")
        val baseline = "# 回复偏好\n先给结论，用 **简体中文** 回复。\n技术术语可加 `code` 标记。"
        val draft = baseline.replace("先给结论", "先给一句结论")
        InstructionsApiFixture().use { fixture ->
            try {
                auth.state.value = testAuthenticationState()
                auth.account.value = NativeAccount("user-a", "example@okou.test")
                app.restoreApiPreferences(
                    mapOf(
                        Triple(BuildConfig.API_ORIGIN, "user-a", "org-a") to
                            testPreferences()
                                .copy(
                                    locale = UserPreferencesLocale.ZH_HANS,
                                    theme = UserPreferencesTheme.LIGHT,
                                )
                    )
                )
                fixture.externalEdit(baseline)
                app.instructionsService = fixture.service
                app.connectivity.value = true
                device.executeShellCommand("wm size 1080x2340")
                device.executeShellCommand("wm density 440")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    assertEventually("phone, Chinese locale and default type size") {
                        var ready = false
                        scenario.onActivity { activity ->
                            val config = activity.resources.configuration
                            ready =
                                config.screenWidthDp in 360..430 &&
                                    config.fontScale == 1f &&
                                    config.locales[0].language == "zh"
                        }
                        ready
                    }
                    device.awaitChatList(app)
                    val settings = By.pkg(app.packageName).desc(app.getString(R.string.settings))
                    val settingsButton = device.findObject(settings)
                    if (settingsButton != null) {
                        settingsButton.click()
                    } else {
                        val more =
                            By.pkg(app.packageName).desc(app.getString(R.string.chat_more_actions))
                        checkNotNull(device.wait(Until.findObject(more), wait)).click()
                        text(R.string.settings).click()
                    }
                    text(R.string.instructions_title).click()
                    val field = By.pkg(app.packageName).clazz("android.widget.EditText")
                    val saveLabel = app.getString(R.string.instructions_save)
                    val save = By.pkg(app.packageName).text(saveLabel)
                    assertEventually("ready instructions with unchanged content") {
                        device.findObject(field)?.text == baseline &&
                            device.findObject(save)?.isEnabled == false
                    }
                    capture("01-instructions-markdown.png")

                    val editor = checkNotNull(device.findObject(field))
                    editor.click()
                    if (keyboardVisible()) check(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                    assertEventually("editor focused with keyboard hidden") {
                        !keyboardVisible() && device.findObject(field)?.isFocused == true
                    }
                    checkNotNull(device.findObject(field)).text = draft
                    app.connectivity.value = false
                    assertEventually("offline instructions with an enabled Save action") {
                        var offline = false
                        scenario.onActivity { activity ->
                            offline =
                                ViewModelProvider(activity)[SessionModel::class.java]
                                    .uiState
                                    .value
                                    .ready
                                    ?.chats
                                    ?.uiState
                                    ?.value
                                    ?.offline == true
                        }
                        offline &&
                            device.findObject(field)?.text == draft &&
                            device.findObject(save)?.isEnabled == true
                    }
                    checkNotNull(device.findObject(save)).click()
                    text(R.string.instructions_save_when_online)
                    check(fixture.requests.none { it.method == "PUT" })
                    capture("02-instructions-offline.png")

                    if (device.findObject(field)?.isFocused != true) {
                        checkNotNull(device.findObject(field)).click()
                    }
                    assertEventually("draft has text focus before scaling") {
                        device.findObject(field)?.isFocused == true
                    }
                    device.executeShellCommand("settings put system font_scale 1.3")
                    assertEventually("font scale and focused draft restored after recreation") {
                        var font = 0f
                        scenario.onActivity { activity ->
                            font = activity.resources.configuration.fontScale
                        }
                        font == 1.3f &&
                            device.findObject(field)?.let { it.text == draft && it.isFocused } ==
                                true
                    }
                    if (keyboardVisible()) check(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                    text(R.string.instructions_save_when_online)
                    capture("03-instructions-large-type.png")

                    app.connectivity.value = true
                    val hint =
                        By.pkg(app.packageName)
                            .text(app.getString(R.string.instructions_save_when_online))
                    assertEventually("reconnect preserves the draft and clears feedback") {
                        !device.hasObject(hint) && device.findObject(field)?.text == draft
                    }
                    check(fixture.requests.none { it.method == "PUT" })
                }
            } catch (failure: Throwable) {
                runCatching {
                        ScreenshotCapture.capture("instructions-capture-failure.png")
                        TestStorage().openOutputFile("instructions-capture-hierarchy.xml").use {
                            device.dumpWindowHierarchy(it)
                        }
                    }
                    .exceptionOrNull()
                    ?.let(failure::addSuppressed)
                throw failure
            } finally {
                app.connectivity.value = priorOnline
                app.instructionsService = priorService
                app.restoreApiPreferences(priorPreferences)
                auth.state.value = priorSession
                auth.account.value = priorAccount
                locales.applicationLocales = priorLocales
                device.executeShellCommand("wm size ${priorSize ?: "reset"}")
                device.executeShellCommand("wm density ${priorDensity ?: "reset"}")
                if (priorFont == "null")
                    device.executeShellCommand("settings delete system font_scale")
                else device.executeShellCommand("settings put system font_scale $priorFont")
            }
        }
    }

    private fun assertEventually(label: String, condition: () -> Boolean) {
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(unused: UiDevice) = condition()
                },
                wait,
            ) == true
        ) {
            label
        }
    }

    private fun text(label: Int): UiObject2 {
        val title = app.getString(label)
        val target = By.pkg(app.packageName).text(title)
        if (!device.hasObject(target)) {
            val nearby = device.findObject(By.pkg(app.packageName).scrollable(true))
            val visible =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(unused: UiObject2) = device.hasObject(target)
                }
            if (nearby?.scrollUntil(Direction.UP, visible) != true) {
                nearby?.scrollUntil(Direction.DOWN, visible)
            }
        }
        return checkNotNull(device.wait(Until.findObject(target), wait)) { title }
    }

    private fun keyboardVisible() =
        instrumentation.uiAutomation.windows.any {
            it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
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
}
