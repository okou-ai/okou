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
import androidx.lifecycle.Lifecycle
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
    fun creditBalancesStayInPlaceWhenBothRefreshesFail() {
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
            val fixture = SettingsApiFixture(api)
            val user = "credit-refresh-${UUID.randomUUID()}"
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
                settings { scenario ->
                    open(R.string.settings_credit_balance)
                    val personal = By.pkg(app.packageName).text("860")
                    val shared = By.pkg(app.packageName).text("2,400")
                    val failure = label(R.string.settings_credit_unavailable)
                    await(personal)
                    await(shared)
                    device.waitForIdle()
                    val personalBounds = await(personal).visibleBounds
                    val sharedBounds = await(shared).visibleBounds
                    ScreenshotCapture.capture("01-credit-confirmed.png")

                    scenario.moveToState(Lifecycle.State.STARTED)
                    fixture.usagePackStatus = 400
                    fixture.billingStatus = 400
                    scenario.moveToState(Lifecycle.State.RESUMED)
                    await(failure)
                    check(await(personal).visibleBounds == personalBounds)
                    check(await(shared).visibleBounds == sharedBounds)
                    check(fixture.usagePackReads.get() >= 2)
                    check(fixture.billingReads.get() >= 2)
                    device.waitForIdle()
                    ScreenshotCapture.capture("02-credit-refresh-failed.png")

                    await(By.pkg(app.packageName).desc(app.getString(R.string.back))).click()
                    await(label(R.string.settings))
                    check(device.wait(Until.gone(failure), 5_000) == true)
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

    private fun settings(block: (ActivityScenario<MainActivity>) -> Unit) {
        ActivityScenario.launch(MainActivity::class.java).use {
            device.awaitChatList(app)
            device.openChatListSettings(app)
            block(it)
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
