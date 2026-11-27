package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.DefaultModelPreferenceServiceTier
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.openChatListSettings
import ai.okou.android.preferences.PreferenceStatus
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
            as TestOkouApplication
    private val chinese =
        app.createConfigurationContext(
            Configuration(app.resources.configuration).apply {
                setLocales(LocaleList.forLanguageTags("zh-Hans"))
            },
        )

    @Test
    fun settingsRejectsALateReadAndStillSavesTheCloudBrowserPreference() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousPreferences = app.initialPreferences
        val previousApiPreferences = app.snapshotApiPreferences()
        val previousRead = app.screenshotPreferenceRead
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locale.applicationLocales
        val readStarted = CompletableDeferred<Unit>()
        val readResponse = CompletableDeferred<Unit>()
        val readReturned = CompletableDeferred<Unit>()
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            try {
                val user = "settings-refresh-${UUID.randomUUID()}"
                app.chatService = api.service
                app.recoveryService = api.service
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                        cloudBrowserEnabledByDefault = false,
                    )
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(chinese)
                    lateinit var session: SessionModel
                    scenario.onActivity { session = ViewModelProvider(it)[SessionModel::class.java] }
                    val preferences = runBlocking {
                        withTimeout(12_000) {
                            session.uiState.mapNotNull { it.ready?.preferences }.first()
                        }
                    }
                    app.screenshotPreferenceRead = { snapshot ->
                        readStarted.complete(Unit)
                        withContext(NonCancellable) {
                            readResponse.await()
                            readReturned.complete(Unit)
                            snapshot.copy(timezone = "UTC", cloudBrowserEnabledByDefault = true)
                        }
                    }
                    // Start the same ordinary read used by the foreground timer.
                    scenario.onActivity { preferences.refresh() }
                    runBlocking { withTimeout(12_000) { readStarted.await() } }
                    device.openChatListSettings(chinese)
                    await(label(R.string.settings_cloud_browser))
                    await(By.pkg(app.packageName).scrollable(true)).scroll(Direction.DOWN, 0.67f)
                    scenario.onActivity {
                        check(preferences.uiState.value.status == PreferenceStatus.Ready)
                    }
                    readResponse.complete(Unit)
                    runBlocking { withTimeout(12_000) { readReturned.await() } }
                    device.waitForIdle()
                    await(timezone())
                    val before = await(switch(checked = false))
                    val bounds = before.visibleBounds
                    ScreenshotCapture.capture("01-settings-after-late-read.png")

                    before.click()
                    val after = await(switch(checked = true))
                    check(after.visibleBounds == bounds)
                    await(timezone())
                    runBlocking {
                        withTimeout(12_000) {
                            preferences.uiState.first { it.confirmed.cloudBrowserEnabledByDefault }
                        }
                    }
                    device.waitForIdle()
                    ScreenshotCapture.capture("02-settings-after-save.png")
                }
            } finally {
                readResponse.complete(Unit)
                app.screenshotPreferenceRead = previousRead
                app.initialPreferences = previousPreferences
                app.restoreApiPreferences(previousApiPreferences)
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                auth.state.value = previousSession
                auth.account.value = previousAccount
                locale.applicationLocales = previousLocales
            }
        }
    }

    private fun switch(checked: Boolean) =
        By.pkg(app.packageName)
            .checkable(true)
            .enabled(true)
            .checked(checked)
            .hasDescendant(label(R.string.settings_cloud_browser))

    @Test
    fun defaultModelShowsActualFastMultiplierAndResetsOnModelSwitch() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousPreferences = app.initialPreferences
        val previousApiPreferences = app.snapshotApiPreferences()
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locale.applicationLocales
        val sol = "gpt-6.2-sol"
        val solLabel = "GPT 6.2 Sol"
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api, gptModel = sol, gptLabel = solLabel)
            fixture.gptFastUsageMultiplier = 2.0
            try {
                val user = "settings-fast-${UUID.randomUUID()}"
                app.chatService = api.service
                app.recoveryService = api.service
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = UserPreferencesTheme.LIGHT,
                    timezone = "Asia/Shanghai",
                )
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    device.awaitChatList(chinese)
                    lateinit var session: SessionModel
                    scenario.onActivity { session = ViewModelProvider(it)[SessionModel::class.java] }
                    val model = runBlocking {
                        withTimeout(12_000) {
                            val owner = session.uiState.mapNotNull { it.ready?.settings?.defaultModel }.first()
                            owner.state.first { it.record?.confirmed?.selectedModel == sol }
                            owner
                        }
                    }
                    fun awaitSaved(id: String?, fast: Boolean) = runBlocking {
                        withTimeout(12_000) {
                            model.state.first {
                                it.pending == null && it.selected?.id == id &&
                                    (it.record?.confirmed?.serviceTier == DefaultModelPreferenceServiceTier.PRIORITY) == fast
                            }
                        }
                        device.waitForIdle()
                    }
                    val fastLabel = label(R.string.settings_model_fast)
                    fun fastSwitch(checked: Boolean) =
                        By.pkg(app.packageName).checkable(true).enabled(true)
                            .checked(checked).hasDescendant(fastLabel)
                    fun assertFastHidden() = check(device.wait(Until.gone(fastLabel), 12_000))
                    val multiplier = By.pkg(app.packageName).text(
                        chinese.getString(R.string.settings_model_fast_usage, "2"),
                    )

                    device.openChatListSettings(chinese)
                    await(label(R.string.settings_default_model)).click()
                    await(multiplier)
                    await(fastSwitch(checked = false)).click()
                    awaitSaved(sol, fast = true)
                    await(fastSwitch(checked = true))
                    check(fixture.writes.last().getValue("serviceTier") == JsonPrimitive("priority"))
                    ScreenshotCapture.capture("03-default-model-fast-on.png")

                    await(By.pkg(app.packageName).text("Claude Sonnet 5")).click()
                    awaitSaved("claude-test", fast = false)
                    assertFastHidden()
                    check(fixture.writes.last().getValue("serviceTier") == JsonNull)
                    ScreenshotCapture.capture("04-default-model-unsupported.png")

                    await(By.pkg(app.packageName).text(solLabel)).click()
                    awaitSaved(sol, fast = false)
                    await(fastSwitch(checked = false))
                    await(multiplier)
                    ScreenshotCapture.capture("05-default-model-fast-reset.png")

                    await(label(R.string.settings_auto_model)).click()
                    awaitSaved(null, fast = false)
                    assertFastHidden()
                    check(fixture.writes.size == 4)
                    check(fixture.writes.last().getValue("selectedModel") == JsonNull)
                    check(fixture.writes.last().getValue("serviceTier") == JsonNull)
                    ScreenshotCapture.capture("06-default-model-auto.png")
                }
            } finally {
                app.initialPreferences = previousPreferences
                app.restoreApiPreferences(previousApiPreferences)
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                auth.state.value = previousSession
                auth.account.value = previousAccount
                locale.applicationLocales = previousLocales
            }
        }
    }

    private fun timezone() = By.pkg(app.packageName).textContains("UTC+8")

    private fun label(id: Int) = By.pkg(app.packageName).text(chinese.getString(id))

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }
}
