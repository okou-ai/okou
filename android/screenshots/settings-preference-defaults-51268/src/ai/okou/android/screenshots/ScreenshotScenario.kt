package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.awaitChatList
import ai.okou.android.openChatListSettings
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.TimeZone
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
            as TestOkouApplication
    private val chineseLocales = LocaleList.forLanguageTags("zh-Hans")
    private val chinese =
        app.createConfigurationContext(
            Configuration(app.resources.configuration).apply { setLocales(chineseLocales) },
        )

    @Test
    fun defaultsHandOverToConfirmedWorkspacePreferencesInPlace() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousPreferences = app.initialPreferences
        val previousApiPreferences = app.snapshotApiPreferences()
        val previousGate = app.screenshotPreferencesGate
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locale.applicationLocales
        val previousTimezone = TimeZone.getDefault()
        val preferenceGate = CompletableDeferred<Unit>()
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            try {
                val user = "settings-defaults-${UUID.randomUUID()}"
                app.chatService = api.service
                app.recoveryService = api.service
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                        cloudBrowserEnabledByDefault = false,
                    )
                app.screenshotPreferencesGate = preferenceGate
                locale.applicationLocales = LocaleList.getEmptyLocaleList()
                check(locale.systemLocales[0]?.language == "en")
                TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                ActivityScenario.launch(MainActivity::class.java).use {
                    device.awaitChatList(app)
                    // Apply the app locale after the pending workspace owns the Activity.
                    locale.applicationLocales = chineseLocales
                    device.awaitChatList(chinese)
                    device.openChatListSettings(chinese)
                    await(label(R.string.settings_cloud_browser))
                    val scroll = await(By.pkg(app.packageName).scrollable(true))
                    scroll.scroll(Direction.DOWN, 0.67f)
                    val pendingSwitch = await(switch(enabled = false, checked = true))
                    await(label(R.string.appearance_system))
                    await(label(R.string.palette_default))
                    await(label(R.string.language_en_us))
                    await(timezone("UTC+0"))
                    device.waitForIdle()
                    ScreenshotCapture.capture("01-settings-before-sync.png")

                    val switchBounds = pendingSwitch.visibleBounds
                    preferenceGate.complete(Unit)
                    val confirmedSwitch = await(switch(enabled = true, checked = false))
                    check(confirmedSwitch.visibleBounds == switchBounds)
                    await(label(R.string.appearance_light))
                    await(label(R.string.palette_default))
                    await(label(R.string.language_zh_hans))
                    await(timezone("UTC+8"))
                    device.waitForIdle()
                    ScreenshotCapture.capture("02-settings-after-sync.png")
                }
            } finally {
                preferenceGate.complete(Unit)
                app.screenshotPreferencesGate = previousGate
                app.initialPreferences = previousPreferences
                app.restoreApiPreferences(previousApiPreferences)
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                auth.state.value = previousSession
                auth.account.value = previousAccount
                TimeZone.setDefault(previousTimezone)
                locale.applicationLocales = previousLocales
            }
        }
    }

    private fun switch(enabled: Boolean, checked: Boolean) =
        By.pkg(app.packageName)
            .checkable(true)
            .enabled(enabled)
            .checked(checked)
            .hasDescendant(label(R.string.settings_cloud_browser))

    private fun timezone(offset: String) = By.pkg(app.packageName).textContains(offset)

    private fun label(id: Int) = By.pkg(app.packageName).text(chinese.getString(id))

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }
}
