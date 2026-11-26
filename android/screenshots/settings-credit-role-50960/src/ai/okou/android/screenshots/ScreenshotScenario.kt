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
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun creditBalanceKeepsTheConfirmedCardsUntilForegroundRoleCheckSettles() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousMemberships = auth.membershipsAction
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousRole = app.workspaceRole
        val previousPreferences = app.snapshotApiPreferences()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = localeManager.applicationLocales
        val demoted = AtomicBoolean()
        val roleReadStarted = CountDownLatch(1)
        val settleRole = CountDownLatch(1)
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            val user = "settings-credit-role-${UUID.randomUUID()}"
            var scenario: ActivityScenario<MainActivity>? = null
            try {
                app.chatService = api.service
                app.recoveryService = api.service
                app.workspaceRole = OrganizationRole.ADMIN
                auth.membershipsAction = {
                    if (demoted.get()) {
                        roleReadStarted.countDown()
                        withContext(Dispatchers.IO) {
                            check(settleRole.await(25, TimeUnit.SECONDS))
                        }
                    }
                    val role = if (demoted.get()) "org:member" else "org:admin"
                    auth.available.map { if (it.id == "org-a") it.copy(role = role) else it }
                }
                app.restoreApiPreferences(
                    mapOf(
                        Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                            testPreferences().copy(
                                locale = UserPreferencesLocale.ZH_HANS,
                                theme = UserPreferencesTheme.LIGHT,
                                timezone = "Asia/Shanghai",
                            ),
                    ),
                )
                localeManager.applicationLocales = LocaleList.forLanguageTags("zh-Hans")
                auth.account.value = NativeAccount(user, "account@example.com")
                auth.state.value = testAuthenticationState(user = user)
                scenario = ActivityScenario.launch(MainActivity::class.java)
                device.awaitChatList(app)
                device.openChatListSettings(app)
                val balance = await(label(app.getString(R.string.settings_credit_balance)))
                generateSequence(balance) { it.parent }.first { it.isClickable }.click()

                val personal = label("860")
                val workspace = label("2,400")
                val workspaceTitle = label(app.getString(R.string.settings_credit_workspace))
                await(personal)
                await(workspace)
                device.waitForIdle()
                val position = await(personal).visibleBounds
                ScreenshotCapture.capture("01-admin-balance.png")
                val billingReads = fixture.billingReads.get()
                val personalReads = fixture.usagePackReads.get()

                // The Web link uses the same pause/resume lifecycle as this transition.
                scenario.moveToState(Lifecycle.State.STARTED)
                demoted.set(true)
                scenario.moveToState(Lifecycle.State.RESUMED)
                check(roleReadStarted.await(10, TimeUnit.SECONDS)) { "Role was not rechecked" }
                await(workspace)
                check(await(personal).visibleBounds == position)
                ScreenshotCapture.capture("02-checking-role.png")

                settleRole.countDown()
                check(device.wait(Until.gone(workspaceTitle), 10_000) == true)
                check(!device.hasObject(workspace))
                check(await(personal).visibleBounds == position)
                await(label(app.getString(R.string.settings_credit_web)))
                check(fixture.billingReads.get() == billingReads)
                check(fixture.usagePackReads.get() > personalReads)
                device.waitForIdle()
                ScreenshotCapture.capture("03-member-balance.png")
            } catch (error: Throwable) {
                try {
                    takeScreenshot().writeToTestStorage("credit-role-diagnostic")
                } catch (diagnostic: Throwable) {
                    error.addSuppressed(diagnostic)
                }
                throw error
            } finally {
                settleRole.countDown()
                scenario?.close()
                auth.membershipsAction = previousMemberships
                auth.state.value = previousSession
                auth.account.value = previousAccount
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.workspaceRole = previousRole
                app.restoreApiPreferences(previousPreferences)
                localeManager.applicationLocales = previousLocales
            }
        }
    }

    private fun label(text: String) = By.pkg(app.packageName).text(text)

    private fun await(selector: BySelector) =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }
}
