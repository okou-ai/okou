package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.graphics.Rect
import android.view.KeyEvent
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication

    @Test
    fun capturesNativeDefaultModelAndAuto() {
        val oldAuth = auth.state.value
        val oldPreferences = app.snapshotApiPreferences()
        val oldChat = app.chatService
        val oldRecovery = app.recoveryService
        val oldOnline = app.connectivity.value
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val oldLocale = localeManager.applicationLocales
        val oldSize = override("wm size")
        val oldDensity = override("wm density")
        val oldFont = device.executeShellCommand("settings get system font_scale").trim()
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val initialModelRead = AtomicBoolean(true)
            val allowModelRead = CountDownLatch(1)
            val respond = api.commandResponse
            api.commandResponse = { request ->
                if (request.method == "GET" && request.requestUrl?.encodedPath == "/api/user-model-preference") {
                    if (initialModelRead.getAndSet(false)) {
                        jsonResponse("{}").setResponseCode(503)
                    } else {
                        check(allowModelRead.await(20, TimeUnit.SECONDS))
                        respond(request)
                    }
                } else respond(request)
            }
            try {
                app.chatService = api.service
                app.recoveryService = api.service
                app.connectivity.value = true
                val user = "default-model-capture"
                auth.state.value = testAuthenticationState(user = user)
                app.restoreApiPreferences(mapOf(
                    Triple(BuildConfig.API_ORIGIN, user, "org-a") to testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
                ))
                device.executeShellCommand("wm size 1080x2340")
                device.executeShellCommand("wm density 420")
                device.executeShellCommand("settings put system font_scale 1.0")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(app)
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            var ready = false
                            scenario.onActivity {
                                val config = it.resources.configuration
                                ready = config.screenWidthDp in 400..420 &&
                                    config.fontScale == 1f &&
                                    config.locales[0].toLanguageTag().startsWith("zh")
                            }
                            return ready
                        }
                    }, TIMEOUT) == true)
                    app.connectivity.value = false
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            var offline = false
                            scenario.onActivity { activity ->
                                val session = ViewModelProvider(activity)[SessionModel::class.java]
                                offline = session.uiState.value.ready?.settings?.defaultModel
                                    ?.state?.value?.offline == true
                            }
                            return offline
                        }
                    }, TIMEOUT) == true)
                    openSettings()
                    val offlineEntry = text(R.string.settings_default_model)
                    text(R.string.chat_list_offline)
                    check(generateSequence(offlineEntry) { it.parent }.none { it.isClickable })
                    capture("08-settings-default-model-cold-offline.png")

                    app.connectivity.value = true
                    val readFailure = By.pkg(app.packageName)
                        .text(app.getString(R.string.chat_list_first_load_failed))
                    checkNotNull(device.wait(Until.findObject(readFailure), TIMEOUT)) {
                        "Expected the first read failure on the default-model row"
                    }
                    val unavailableEntry = text(R.string.settings_default_model)
                    check(generateSequence(unavailableEntry) { it.parent }.none { it.isClickable })
                    capture("09-settings-default-model-read-failure.png")
                    allowModelRead.countDown()
                    val recovered = By.pkg(app.packageName).text("GPT 5.6 Sol")
                    checkNotNull(device.wait(Until.findObject(recovered), TIMEOUT)) {
                        var state = "missing Settings owner"
                        scenario.onActivity { activity ->
                            val session = ViewModelProvider(activity)[SessionModel::class.java]
                            session.uiState.value.ready?.settings?.defaultModel?.state?.value?.let {
                                state = "offline=${it.offline}, failure=${it.failure}, selected=${it.selected?.id}"
                            }
                        }
                        "Default-model row did not recover in place ($state)"
                    }
                    val entry = clickable(text(R.string.settings_default_model))
                    capture("01-settings-default-model.png")

                    entry.click()
                    text(R.string.settings_auto_model_detail)
                    text(R.string.settings_model_effort)
                    clickable(text(R.string.settings_model_fast)).click()
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) =
                            fixture.preference["serviceTier"] == JsonPrimitive("priority")
                    }, TIMEOUT) == true)
                    capture("02-default-model-fast.png")

                    val auto = clickable(text(R.string.settings_auto_model))
                    auto.click()
                    text(R.string.settings_auto_model_detail)
                    device.waitForIdle()
                    check(!device.hasObject(By.pkg(app.packageName).text(app.getString(R.string.settings_model_effort))))
                    check(!device.hasObject(By.pkg(app.packageName).text(app.getString(R.string.settings_model_fast))))
                    capture("03-default-model-auto.png")

                    app.connectivity.value = false
                    clickable(text("GPT 5.6 Sol")).click()
                    check(
                        text(R.string.settings_model_offline).visibleBounds.bottom <=
                            text(R.string.settings_auto_model).visibleBounds.top
                    )
                    capture("04-default-model-offline.png")

                    app.connectivity.value = true
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) =
                            fixture.preference["selectedModel"] == JsonPrimitive("gpt-test")
                    }, TIMEOUT) == true)
                    device.pressBack()
                    val target = By.pkg(app.packageName).text(app.getString(R.string.settings_default_model))
                    repeat(12) {
                        if (device.findObject(target)?.let(::clickable)?.isFocused != true) {
                            device.pressKeyCode(KeyEvent.KEYCODE_TAB)
                            device.waitForIdle()
                        }
                    }
                    check(device.findObject(target)?.let(::clickable)?.isFocused == true)
                    device.pressKeyCode(KeyEvent.KEYCODE_ENTER)
                    text(R.string.settings_model_effort)
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) =
                            device.findObjects(By.pkg(app.packageName).text("GPT 5.6 Sol")).any { node ->
                                generateSequence(node) { it.parent }.any { it.isFocused }
                            }
                    }, TIMEOUT) == true)
                    capture("05-default-model-keyboard.png")

                    app.connectivity.value = false
                    text(R.string.settings_model_offline)
                    fixture.gptSortOrder = 3
                    app.connectivity.value = true
                    awaitModelOrder("Claude Sonnet 5", "GPT 5.6 Sol")

                    app.connectivity.value = false
                    text(R.string.settings_model_offline)
                    fixture.gptSortOrder = 1
                    app.connectivity.value = true
                    awaitModelOrder("GPT 5.6 Sol", "Claude Sonnet 5")

                    device.pressBack()
                    clickable(text(R.string.appearance)).click()
                    clickable(text(R.string.appearance_dark)).click()
                    device.waitForIdle()
                    val settingsList = checkNotNull(device.findObject(By.pkg(app.packageName).scrollable(true)))
                    settingsList.scrollUntil(Direction.UP, object : Condition<UiObject2, Boolean> {
                        override fun apply(container: UiObject2) = device.hasObject(target)
                    })
                    clickable(text(R.string.settings_default_model)).click()
                    clickable(text(R.string.settings_model_fast)).click()
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) =
                            fixture.preference["serviceTier"] == JsonPrimitive("priority")
                    }, TIMEOUT) == true)
                    capture("06-default-model-fast-dark.png")

                    device.pressBack()
                    device.executeShellCommand("wm size 1080x950")
                    check(device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            var ready = false
                            scenario.onActivity {
                                ready = it.resources.configuration.screenHeightDp in 270..479
                            }
                            return ready
                        }
                    }, TIMEOUT) == true)
                    if (!device.hasObject(By.pkg(app.packageName).text(app.getString(R.string.settings)))) {
                        openSettings()
                    }
                    clickable(text(R.string.settings_default_model)).click()
                    val autoDetail = text(R.string.settings_auto_model_detail)
                    val autoTop = autoDetail.visibleBounds.top
                    capture("diagnostic-short-window-before-scroll.png")
                    val titleBounds = headingBounds(R.string.settings_default_model)
                    check(titleBounds.top < 145) { "Expected a full-screen header at $titleBounds" }
                    val options = generateSequence(autoDetail) { it.parent }
                        .first { it.isScrollable }.visibleBounds
                    check(device.swipe(
                        options.centerX(), options.bottom - 40,
                        options.centerX(), options.top + 40, 30,
                    ))
                    val fast = By.pkg(app.packageName).text(app.getString(R.string.settings_model_fast))
                    checkNotNull(device.wait(Until.findObject(fast), TIMEOUT))
                    capture("07-default-model-short-window.png")
                    val after = headingBounds(R.string.settings_default_model)
                    check(after.top == titleBounds.top) { "Header moved from $titleBounds to $after" }
                    val autoDetailSelector = By.pkg(app.packageName).text(app.getString(R.string.settings_auto_model_detail))
                    check(device.findObject(autoDetailSelector)?.visibleBounds?.top?.let { it < autoTop } != false) {
                        "Options did not scroll"
                    }
                }
            } finally {
                allowModelRead.countDown()
                app.connectivity.value = oldOnline
                app.chatService = oldChat
                app.recoveryService = oldRecovery
                app.restoreApiPreferences(oldPreferences)
                auth.state.value = oldAuth
                localeManager.applicationLocales = oldLocale
                device.executeShellCommand("wm size ${oldSize ?: "reset"}")
                device.executeShellCommand("wm density ${oldDensity ?: "reset"}")
                if (oldFont.toFloatOrNull() == null) device.executeShellCommand("settings delete system font_scale")
                else device.executeShellCommand("settings put system font_scale $oldFont")
            }
        }
    }

    private fun override(command: String): String? = device.executeShellCommand(command)
        .lineSequence().firstOrNull { it.startsWith("Override ") }?.substringAfter(": ")

    private fun clickable(node: UiObject2) =
        generateSequence(node) { it.parent }.first { it.isClickable }

    private fun awaitModelOrder(first: String, second: String) {
        check(device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean {
                val heading = headingBounds(R.string.settings_default_model).bottom
                fun choice(label: String) = device.findObjects(By.pkg(app.packageName).text(label))
                    .firstOrNull { it.visibleBounds.top >= heading }
                val leading = choice(first) ?: return false
                val trailing = choice(second) ?: return false
                val gpt = if (first == "GPT 5.6 Sol") leading else trailing
                return leading.visibleBounds.top < trailing.visibleBounds.top &&
                    generateSequence(gpt) { it.parent }.any { it.isFocused }
            }
        }, TIMEOUT) == true) { "Expected $first before $second with GPT still focused" }
    }

    private fun headingBounds(resource: Int): Rect {
        val label = app.getString(resource)
        val candidates = device.findObjects(By.pkg(app.packageName).text(label))
        val heading = candidates.singleOrNull { node ->
            generateSequence(node) { it.parent }.none { it.isClickable || it.isScrollable }
        }
        return checkNotNull(heading) { "Missing fixed header $label in ${candidates.size} matches" }
            .visibleBounds
    }

    private fun openSettings() {
        val settings = device.findObject(By.pkg(app.packageName).desc(app.getString(R.string.settings)))
        if (settings != null) settings.click()
        else {
            checkNotNull(device.findObject(By.pkg(app.packageName)
                .desc(app.getString(R.string.chat_more_actions)))).click()
            text(R.string.settings).click()
        }
    }

    private fun text(resource: Int) = text(app.getString(resource))

    private fun text(label: String): UiObject2 {
        val target = By.pkg(app.packageName).text(label)
        if (!device.hasObject(target)) {
            val scroll = device.findObject(By.pkg(app.packageName).scrollable(true))
            scroll?.scrollUntil(Direction.DOWN, object : Condition<UiObject2, Boolean> {
                override fun apply(container: UiObject2) = device.hasObject(target)
            })
        }
        return checkNotNull(device.wait(Until.findObject(target), TIMEOUT)) { "Expected $label" }
    }

    private fun capture(name: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(name)
    }

    companion object {
        private const val TIMEOUT = 12_000L
    }
}
