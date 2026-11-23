package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.SettingsApiFixture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.EmailSubscription
import ai.okou.android.api.generated.EmailSubscriptionDeliveryStatus
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.awaitChatList
import ai.okou.android.settings.ConfirmedSetting
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
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
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication

    private class RequestGate(val method: String) {
        val entered = CountDownLatch(1)
        val released = CountDownLatch(1)

        fun await() {
            check(entered.await(10, TimeUnit.SECONDS)) { "$method request did not reach fixture" }
        }
    }

    private val gate = AtomicReference<RequestGate?>()

    @Test
    fun capturesSettingsEmailAndModelAccountFeedback() {
        val previousPreferences = app.snapshotApiPreferences()
        val previousSession = auth.state.value
        val previousAccount = auth.account.value
        val previousChat = app.chatService
        val previousRecovery = app.recoveryService
        val locales = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val previousLocales = locales.applicationLocales
        val animator =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            fixture.emailSubscribed = true
            val respond = api.commandResponse
            api.commandResponse = { request ->
                val held = gate.get()
                if (
                    held != null &&
                        request.requestUrl?.encodedPath == SettingsApiFixture.emailPath &&
                        request.method == held.method
                ) {
                    held.entered.countDown()
                    check(held.released.await(20, TimeUnit.SECONDS))
                }
                respond(request)
            }
            var scenario: ActivityScenario<MainActivity>? = null
            try {
                device.executeShellCommand("settings put global animator_duration_scale 0")
                check(
                    device
                        .executeShellCommand("settings get global animator_duration_scale")
                        .trim()
                        .toFloat() == 0f,
                )
                val user = "settings-email-${UUID.randomUUID()}"
                auth.state.value = testAuthenticationState(user = user)
                auth.account.value = NativeAccount(user, "account@example.com")
                app.chatService = api.service
                app.recoveryService = api.service
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
                val first = ActivityScenario.launch(MainActivity::class.java)
                scenario = first
                device.awaitChatList(app)
                val identity = readyIdentity(first)
                settings()
                val entry = text(R.string.settings_email_updates)
                val initialEntryBounds = entry.visibleBounds
                check(fixture.emailReads.get() == 0)
                ScreenshotCapture.capture("01-settings-account.png")

                val cold = hold("GET")
                clickRow(entry)
                cold.await()
                text(R.string.settings_email_scope)
                checkNotNull(
                    device.wait(
                        Until.findObject(description(R.string.settings_email_refreshing)),
                        5_000,
                    ),
                )
                check(
                    !device.hasObject(
                        By.pkg(app.packageName).text(SettingsApiFixture.emailAddress),
                    ),
                )
                check(
                    !device.hasObject(
                        By.pkg(app.packageName)
                            .text(app.getString(R.string.settings_email_receive)),
                    ),
                )
                ScreenshotCapture.capture("02-email-loading.png")
                release(cold)
                val confirmed = switch(checked = true)
                val density = app.resources.displayMetrics.density
                check(confirmed.visibleBounds.height() >= (72 * density).roundToInt() - 1)
                text(SettingsApiFixture.emailAddress)
                ScreenshotCapture.capture("03-email-confirmed.png")
                dismissEmail()
                check(text(R.string.settings_email_updates).visibleBounds == initialEntryBounds)
                first.close()
                scenario = null

                val old =
                    ConfirmedSetting(
                        EmailSubscription(
                            true,
                            SettingsApiFixture.emailAddress,
                            EmailSubscriptionDeliveryStatus.AVAILABLE,
                        ),
                        System.currentTimeMillis() - 11 * 60_000L,
                    )
                app.workspaceSettingsCache.saveEmail(identity, old)
                runBlocking { check(app.workspaceSettingsCache.loadEmail(identity) == old) }
                scenario = ActivityScenario.launch(MainActivity::class.java)
                device.awaitChatList(app)
                settings()
                val stale = hold("GET")
                clickRow(text(R.string.settings_email_updates))
                stale.await()
                val progress =
                    checkNotNull(
                        device.wait(
                            Until.findObject(description(R.string.settings_email_refreshing)),
                            5_000,
                        ),
                    )
                val staleBounds = switch(checked = true).visibleBounds
                check(
                    kotlin.math.abs(progress.visibleBounds.height() - (4 * density).roundToInt()) <=
                        1,
                )
                check(progress.visibleBounds.width() == staleBounds.width())
                ScreenshotCapture.capture("04-email-stale-refresh.png")
                release(stale)
                check(
                    device.wait(
                        Until.gone(description(R.string.settings_email_refreshing)),
                        10_000,
                    ) == true,
                )
                check(switch(checked = true).visibleBounds == staleBounds)

                val rejected = hold("PUT")
                fixture.emailWriteStatus = 400
                switch(checked = true).click()
                rejected.await()
                switch(checked = false)
                check(fixture.emailSubscribed)
                release(rejected)
                text(R.string.settings_email_save_failed, scroll = false)
                switch(checked = true)
                check(fixture.emailWrites == listOf(false))
                ScreenshotCapture.capture("05-email-write-rejected.png")
                dismissEmail()

                fixture.emailDelivery = "suppressed"
                clickRow(text(R.string.settings_email_updates))
                text(R.string.settings_email_unavailable, scroll = false)
                check(!switch(checked = true, enabled = false).isEnabled)
                ScreenshotCapture.capture("06-email-unavailable.png")
                clickRow(text(R.string.settings_email_check_address, scroll = false))
                text("account@example.com")
                back()

                fixture.activationStatus = 400
                clickRow(text(R.string.settings_model_accounts))
                clickRow(text("work@example.com"))
                text(R.string.settings_account_switch_failed, scroll = false)
                val primary =
                    generateSequence(text("personal@example.com", scroll = false)) { it.parent }
                        .first { it.isClickable }
                check(primary.hasObject(By.text(app.getString(R.string.settings_account_current))))
                check(fixture.activations == listOf(SettingsApiFixture.alternateAccount))
                ScreenshotCapture.capture("07-model-account-write-rejected.png")
                back()
                clickRow(text(R.string.settings_model_accounts))
                text("personal@example.com")
                check(
                    device.wait(
                        Until.gone(By.text(app.getString(R.string.settings_account_switch_failed))),
                        4_000,
                    ) == true,
                )
            } finally {
                gate.getAndSet(null)?.released?.countDown()
                scenario?.close()
                app.chatService = previousChat
                app.recoveryService = previousRecovery
                app.restoreApiPreferences(previousPreferences)
                auth.account.value = previousAccount
                auth.state.value = previousSession
                locales.applicationLocales = previousLocales
                val previousScale = animator.toFloatOrNull()
                if (previousScale == null)
                    device.executeShellCommand("settings delete global animator_duration_scale")
                else
                    device.executeShellCommand(
                        "settings put global animator_duration_scale $previousScale",
                    )
            }
        }
    }

    private fun readyIdentity(activity: ActivityScenario<MainActivity>): WorkspaceIdentity {
        var identity: WorkspaceIdentity? = null
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        activity.onActivity {
                            identity =
                                ViewModelProvider(it)[SessionModel::class.java]
                                    .uiState
                                    .value
                                    .ready
                                    ?.identity
                        }
                        return identity != null
                    }
                },
                10_000,
            ) == true,
        )
        return checkNotNull(identity)
    }

    private fun hold(method: String) =
        RequestGate(method).also { check(gate.compareAndSet(null, it)) }

    private fun release(held: RequestGate) {
        check(gate.compareAndSet(held, null))
        held.released.countDown()
    }

    private fun description(id: Int) = By.pkg(app.packageName).desc(app.getString(id))

    private fun settings() {
        val settings = device.findObject(description(R.string.settings))
        if (settings != null) settings.click()
        else {
            checkNotNull(device.findObject(description(R.string.chat_more_actions))).click()
            text(R.string.settings).click()
        }
        text("Workspace A", scroll = false)
    }

    private fun switch(checked: Boolean, enabled: Boolean = true): UiObject2 {
        val label = app.getString(R.string.settings_email_receive)
        val selector =
            By.pkg(app.packageName)
                .checkable(true)
                .checked(checked)
                .enabled(enabled)
                .hasDescendant(By.text(label))
        return checkNotNull(device.wait(Until.findObject(selector), 6_000)) {
            "Missing switch $label, checked=$checked, enabled=$enabled"
        }
    }

    private fun clickRow(text: UiObject2) {
        generateSequence(text) { it.parent }.first { it.isClickable }.click()
    }

    private fun back() {
        check(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
    }

    private fun dismissEmail() {
        back()
        check(
            device.wait(Until.gone(By.text(app.getString(R.string.settings_email_scope))), 5_000) ==
                true,
        )
    }

    private fun text(id: Int, scroll: Boolean = true) = text(app.getString(id), scroll)

    private fun text(label: String, scroll: Boolean = true): UiObject2 {
        val selector = By.pkg(app.packageName).text(label)
        device.waitForIdle()
        if (scroll && !device.hasObject(selector)) {
            val condition =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(selector)
                }
            val container = device.findObject(By.pkg(app.packageName).scrollable(true))
            if (container?.scrollUntil(Direction.UP, condition) != true) {
                container?.scrollUntil(Direction.DOWN, condition)
            }
        }
        return checkNotNull(device.wait(Until.findObject(selector), 10_000)) {
            "Missing visible text: $label"
        }
    }
}
