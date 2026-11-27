package ai.okou.android.screenshots

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.openChatListSettings
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
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
    fun aStaleReadbackKeepsTheLatestSwitchChoice() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousPreferences = app.initialPreferences
        val previousApiPreferences = app.snapshotApiPreferences()
        val previousWrite = app.preferenceWrite
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locale.applicationLocales
        val started = CompletableDeferred<Unit>()
        val loseResponse = CompletableDeferred<Unit>()
        val confirmed = CompletableDeferred<UserPreferences>()
        var delayedWrite: (() -> UserPreferences)? = null
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            try {
                val user = "settings-readback-${UUID.randomUUID()}"
                app.chatService = api.service
                app.recoveryService = api.service
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                        cloudBrowserEnabledByDefault = false,
                    )
                app.preferenceWrite = { update, save ->
                    if (update.cloudBrowserEnabledByDefault == true) {
                        started.complete(Unit)
                        loseResponse.await()
                        delayedWrite = save
                        throw IOException("response lost")
                    }
                    check(update.cloudBrowserEnabledByDefault == false)
                    check(checkNotNull(delayedWrite).invoke().cloudBrowserEnabledByDefault)
                    save().also { confirmed.complete(it) }
                }
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
                    device.openChatListSettings(chinese)
                    val before = await(switch(checked = false))
                    val bounds = before.visibleBounds
                    before.click()
                    runBlocking { withTimeout(12_000) { started.await() } }
                    val optimistic = await(switch(checked = true))
                    check(optimistic.visibleBounds == bounds)
                    ScreenshotCapture.capture("01-settings-optimistic-on.png")

                    optimistic.click()
                    check(await(switch(checked = false)).visibleBounds == bounds)
                    loseResponse.complete(Unit)
                    runBlocking {
                        withTimeout(12_000) {
                            check(!confirmed.await().cloudBrowserEnabledByDefault)
                            preferences.uiState.first {
                                it.pending == null && !it.confirmed.cloudBrowserEnabledByDefault
                            }
                        }
                    }
                    check(await(switch(checked = false)).visibleBounds == bounds)
                    ScreenshotCapture.capture("02-settings-latest-choice-confirmed.png")
                }
            } finally {
                loseResponse.complete(Unit)
                app.preferenceWrite = previousWrite
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
            .hasDescendant(By.text(chinese.getString(R.string.settings_cloud_browser)))

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }
}
