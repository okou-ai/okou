package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.OrganizationRole
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.awaitChatList
import ai.okou.android.openChatListSettings
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
            as TestOkouApplication

    @Test
    fun eachModelAccountShowsItsOwnQuotaWindow() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousMemberships = auth.membershipsAction
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousRole = app.workspaceRole
        val previousPreferences = app.snapshotApiPreferences()
        val locale = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locale.applicationLocales
        ChatListApiFixture().use { api ->
            SettingsApiFixture(api)
            val user = "settings-read-${UUID.randomUUID()}"
            try {
                app.chatService = api.service
                app.recoveryService = api.service
                app.workspaceRole = OrganizationRole.ADMIN
                auth.membershipsAction = {
                    auth.available.map { if (it.id == "org-a") it.copy(role = "org:admin") else it }
                }
                app.restoreApiPreferences(
                    mapOf(
                        Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                            testPreferences()
                                .copy(
                                    locale = UserPreferencesLocale.ZH_HANS,
                                    theme = UserPreferencesTheme.LIGHT,
                                    timezone = "Asia/Shanghai",
                                ),
                    ),
                )
                locale.applicationLocales = LocaleList.forLanguageTags("zh-Hans")
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                settings {
                    open(R.string.settings_model_accounts)
                    val account = By.pkg(app.packageName).text("personal@example.com")
                    val short = By.pkg(app.packageName).text("75 分钟额度")
                    val weekly = label(R.string.settings_weekly_quota)
                    await(account)
                    val shortBounds = await(short).visibleBounds
                    await(weekly)
                    val weekBounds = device.findObjects(weekly).map { it.visibleBounds }
                        .single { it.top == shortBounds.top }
                    check(shortBounds.top == weekBounds.top && shortBounds.left < weekBounds.left)
                    val nextAccount = await(By.pkg(app.packageName).text("work@example.com"))
                    val resets = device.findObjects(By.pkg(app.packageName).textContains("重置"))
                        .map { it.visibleBounds }
                        .filter { it.top > shortBounds.bottom && it.top < nextAccount.visibleBounds.top }
                    check(resets.size == 1 && resets.single().left >= weekBounds.left)
                    await(By.pkg(app.packageName).text("84%"))
                    device.waitForIdle()
                    ScreenshotCapture.capture("01-short-and-weekly-quota.png")

                    val scroll = await(By.pkg(app.packageName).scrollable(true))
                    scroll.scroll(Direction.DOWN, 0.8f)
                    val exhausted = By.pkg(app.packageName).text("0%")
                    checkNotNull(device.wait(Until.findObjects(exhausted), 12_000))
                    check(device.findObjects(exhausted).size == 2)
                    await(By.pkg(app.packageName).text("claude@example.com"))
                    device.waitForIdle()
                    ScreenshotCapture.capture("02-exhausted-weekly-quota.png")
                }
            } finally {
                locale.applicationLocales = previousLocales
                auth.state.value = previousSession
                auth.account.value = previousAccount
                auth.membershipsAction = previousMemberships
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.workspaceRole = previousRole
                app.restoreApiPreferences(previousPreferences)
            }
        }
    }

    private fun label(id: Int) = By.pkg(app.packageName).text(app.getString(id))

    private fun settings(block: () -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use {
            device.awaitChatList(app)
            device.openChatListSettings(app)
            block()
        }
    }

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }

    private fun open(id: Int) {
        val target = label(id)
        if (!device.hasObject(target)) {
            val visible =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(target)
                }
            val scroll = await(By.pkg(app.packageName).scrollable(true))
            if (scroll.scrollUntil(Direction.UP, visible) != true) {
                scroll.scrollUntil(Direction.DOWN, visible)
            }
        }
        generateSequence(await(target)) { it.parent }.first { it.isClickable }.click()
    }
}
