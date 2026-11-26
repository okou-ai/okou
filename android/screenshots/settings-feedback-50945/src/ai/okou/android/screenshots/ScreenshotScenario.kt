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
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val writeGate = AtomicReference<CountDownLatch?>()

    @Test
    fun capturesSettingsFeedbackAndModelQuotas() {
        val auth = app.authentication as TestAuthentication
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val previousRole = app.workspaceRole
        val previousPreferences = app.snapshotApiPreferences()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = localeManager.applicationLocales
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            val response = api.commandResponse
            api.commandResponse = { request ->
                if (request.method == "PUT" &&
                    request.requestUrl?.encodedPath == SettingsApiFixture.emailPath
                ) {
                    writeGate.get()?.let {
                        check(it.await(20, TimeUnit.SECONDS)) { "Email mock stayed gated" }
                    }
                }
                response(request)
            }
            val user = "settings-feedback-${UUID.randomUUID()}"
            var scenario: ActivityScenario<MainActivity>? = null
            try {
                app.chatService = api.service
                app.recoveryService = api.service
                app.workspaceRole = OrganizationRole.ADMIN
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
                check(app.getString(R.string.settings_email_updates) == "邮件更新")

                open(R.string.settings_model_accounts)
                await(label("personal@example.com"))
                await(label("72%"))
                capture("01-model-quotas.png")
                backToOverview()

                open(R.string.settings_credit_balance)
                await(label(app.getString(R.string.settings_credit_workspace)))
                device.waitForIdle()
                val confirmedPosition = await(label("860")).visibleBounds
                backToOverview()
                fixture.usagePackStatus = 503
                fixture.billingStatus = 503
                open(R.string.settings_credit_balance)
                await(label(app.getString(R.string.settings_credit_unavailable)))
                check(await(label("860")).visibleBounds == confirmedPosition)
                await(label(app.getString(R.string.settings_credit_workspace)))
                capture("02-credit-refresh-failed.png")
                backToOverview()

                open(R.string.settings_email_updates)
                subscriptionSwitch(checked = false, enabled = true)
                device.waitForIdle()
                val idlePosition = subscriptionSwitch(checked = false, enabled = true).visibleBounds
                capture("03-email-idle.png")
                capturePress(
                    x = idlePosition.left + idlePosition.width() / 3f,
                    y = idlePosition.exactCenterY(),
                )
                check(fixture.emailWrites.isEmpty())
                fixture.emailWriteStatus = 400
                val inlineFailure = holdWrite()
                subscriptionSwitch(checked = false, enabled = true).click()
                await(label(app.getString(R.string.settings_email_saving)))
                device.waitForIdle()
                check(subscriptionSwitch(checked = true, enabled = false).visibleBounds == idlePosition)
                capture("05-email-updating.png")
                releaseWrite(inlineFailure)
                val failure = label(app.getString(R.string.settings_email_save_failed))
                await(failure)
                device.waitForIdle()
                check(subscriptionSwitch(checked = false, enabled = true).visibleBounds == idlePosition)
                capture("06-email-rejected-inline.png")

                val afterClose = holdWrite()
                subscriptionSwitch(checked = false, enabled = true).click()
                await(label(app.getString(R.string.settings_email_saving)))
                subscriptionSwitch(checked = true, enabled = false)
                check(device.pressBack())
                check(device.wait(Until.gone(subscriptionSelector().enabled(false)), 10_000) == true)
                device.waitForIdle()
                releaseWrite(afterClose)
                await(failure)
                check(device.findObjects(failure).size == 1)
                check(fixture.emailWrites == listOf(true, true))
                capture("07-email-rejected-settings.png")
            } catch (error: Throwable) {
                try {
                    takeScreenshot().writeToTestStorage("settings-feedback-diagnostic")
                } catch (diagnostic: Throwable) {
                    error.addSuppressed(diagnostic)
                }
                throw error
            } finally {
                writeGate.getAndSet(null)?.countDown()
                scenario?.close()
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

    private fun holdWrite() = CountDownLatch(1).also { check(writeGate.compareAndSet(null, it)) }

    private fun releaseWrite(gate: CountDownLatch) {
        check(writeGate.compareAndSet(gate, null))
        gate.countDown()
    }

    private fun subscriptionSelector() = By.pkg(app.packageName).clazz("android.widget.Switch")

    private fun subscriptionSwitch(checked: Boolean, enabled: Boolean) =
        await(subscriptionSelector().checked(checked).enabled(enabled))

    private fun capture(name: String) {
        device.waitForIdle()
        ScreenshotCapture.capture(name)
    }

    private fun capturePress(x: Float, y: Float) {
        val downAt = SystemClock.uptimeMillis()
        fun dispatch(action: Int) {
            val event = MotionEvent.obtain(downAt, SystemClock.uptimeMillis(), action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            try {
                check(instrumentation.uiAutomation.injectInputEvent(event, true))
            } finally {
                event.recycle()
            }
        }
        dispatch(MotionEvent.ACTION_DOWN)
        try {
            capture("04-email-pressed.png")
        } finally {
            dispatch(MotionEvent.ACTION_CANCEL)
        }
    }

    private fun backToOverview() {
        check(device.pressBack())
        await(label(app.getString(R.string.settings)))
    }

    private fun label(text: String) = By.pkg(app.packageName).text(text)

    private fun await(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Expected $selector" }

    private fun open(id: Int) {
        val target = label(app.getString(id))
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
