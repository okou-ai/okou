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
import ai.okou.android.api.generated.RecoverySubscriptionsSubscriptionsItem
import ai.okou.android.api.generated.UsagePackCredits
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.awaitChatList
import ai.okou.android.settings.ConfirmedSetting
import ai.okou.android.settings.WorkspaceCreditSummary
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
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val app =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
            as TestOkouApplication
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val auth = app.authentication as TestAuthentication

    private data class ReadGate(
        val path: String,
        val requested: CountDownLatch = CountDownLatch(1),
        val release: CountDownLatch = CountDownLatch(1),
    )

    private val held = AtomicReference<ReadGate?>()

    @Test
    fun capturesConfirmedSettingsRefresh() {
        val priorRole = app.workspaceRole
        val priorSession = auth.state.value
        val priorAccount = auth.account.value
        val priorPreferences = app.snapshotApiPreferences()
        val priorChat = app.chatService
        val priorRecovery = app.recoveryService
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val priorLocale = localeManager.applicationLocales
        val animatorScale = device.executeShellCommand("settings get global animator_duration_scale").trim()
        ChatListApiFixture().use { api ->
            val fixture = SettingsApiFixture(api)
            val response = api.commandResponse
            api.commandResponse = { request ->
                val gate = held.get()
                if (gate != null && request.requestUrl?.encodedPath == gate.path) {
                    gate.requested.countDown()
                    check(gate.release.await(22, TimeUnit.SECONDS))
                }
                response(request)
            }
            var scenario: ActivityScenario<MainActivity>? = null
            try {
                device.executeShellCommand("settings put global animator_duration_scale 0")
                check(device.executeShellCommand("settings get global animator_duration_scale").trim().toFloat() == 0f)
                app.workspaceRole = OrganizationRole.ADMIN
                app.chatService = api.service
                app.recoveryService = api.service
                val user = "settings-refresh-${UUID.randomUUID()}"
                auth.state.value = testAuthenticationState(user = user)
                auth.account.value = NativeAccount(user, "account@example.com")
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
                scenario = ActivityScenario.launch(MainActivity::class.java)
                device.awaitChatList(app)
                var identity: WorkspaceIdentity? = null
                val launched = scenario
                check(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean {
                                launched.onActivity {
                                    ViewModelProvider(it)[SessionModel::class.java]
                                        .uiState
                                        .value
                                        .ready
                                        ?.let { ready -> identity = ready.identity }
                                }
                                return identity != null
                            }
                        },
                        10_000,
                    ) == true,
                )

                openSettings()
                fixture.usagePackStatus = 503
                val cold = hold("/api/billing/usage-pack-credits")
                open(R.string.settings_credit_balance)
                check(cold.requested.await(10, TimeUnit.SECONDS))
                val memberTitle = text(R.string.settings_credit_member)
                check(!device.hasObject(By.pkg(app.packageName).text("860")))
                check(!device.hasObject(progress(R.string.settings_refreshing_credit_balance)))
                waitForCreditSkeleton(memberTitle)
                ScreenshotCapture.capture("01-cold-credit.png")
                release(cold)
                text(R.string.settings_credit_unavailable)
                val retry = generateSequence(text(R.string.retry)) { it.parent }.first { it.isClickable }
                ScreenshotCapture.capture("06-cold-credit-error.png")
                val billingReads = fixture.billingReads.get()
                fixture.usagePackStatus = 200
                retry.click()
                text("860")
                check(fixture.billingReads.get() == billingReads)
                scenario.close()
                scenario = null

                runBlocking {
                    val scopeIdentity = checkNotNull(identity)
                    val cache = app.workspaceSettingsCache
                    val stale = System.currentTimeMillis() - 660_000
                    val accounts = api.service.recoverySubscriptions().subscriptions
                    val billing = api.service.recoveryBilling()
                    cache.save(
                        scopeIdentity,
                        "accounts",
                        ListSerializer(RecoverySubscriptionsSubscriptionsItem.serializer()),
                        ConfirmedSetting(accounts, stale),
                    )
                    cache.save(
                        scopeIdentity,
                        "usage-pack",
                        UsagePackCredits.serializer(),
                        ConfirmedSetting(UsagePackCredits(860, 800, 60), stale),
                    )
                    cache.save(
                        scopeIdentity,
                        "workspace-credits",
                        WorkspaceCreditSummary.serializer(),
                        ConfirmedSetting(
                            WorkspaceCreditSummary(billing.credits, billing.creditBreakdown),
                            stale,
                        ),
                    )
                }
                scenario = ActivityScenario.launch(MainActivity::class.java)
                device.awaitChatList(app)
                openSettings()
                val accountsRead = hold("/api/me/3rd-party-subscriptions")
                open(R.string.settings_model_accounts)
                check(accountsRead.requested.await(10, TimeUnit.SECONDS))
                val accountTop = text("personal@example.com").visibleBounds.top
                verifyProgress(R.string.settings_refreshing_model_accounts)
                ScreenshotCapture.capture("02-stale-accounts.png")
                release(accountsRead)
                waitForGone(R.string.settings_refreshing_model_accounts)
                check(text("personal@example.com").visibleBounds.top == accountTop)

                back()
                device.executeShellCommand("settings put global animator_duration_scale 1")
                check(device.executeShellCommand("settings get global animator_duration_scale").trim().toFloat() == 1f)
                val stale = hold("/api/billing/usage-pack-credits")
                open(R.string.settings_credit_balance)
                check(stale.requested.await(10, TimeUnit.SECONDS))
                val balanceTop = text("860").visibleBounds.top
                verifyProgress(R.string.settings_refreshing_credit_balance)
                ScreenshotCapture.capture("03-stale-credit.png")
                release(stale)
                waitForGone(R.string.settings_refreshing_credit_balance)
                check(text("860").visibleBounds.top == balanceTop)

                back()
                fixture.usagePackStatus = 503
                val fresh = hold("/api/billing/usage-pack-credits")
                open(R.string.settings_credit_balance)
                check(fresh.requested.await(10, TimeUnit.SECONDS))
                text("860")
                check(!device.hasObject(progress(R.string.settings_refreshing_credit_balance)))
                ScreenshotCapture.capture("04-fresh-credit.png")
                release(fresh)
                val error =
                    By.pkg(app.packageName)
                        .textContains(
                            app.getString(R.string.settings_credit_update_failed),
                        )
                check(device.wait(Until.hasObject(error), 10_000) == true)
                text("860")
                ScreenshotCapture.capture("05-credit-refresh-failed.png")
            } finally {
                held.getAndSet(null)?.release?.countDown()
                scenario?.close()
                app.chatService = priorChat
                app.recoveryService = priorRecovery
                app.workspaceRole = priorRole
                app.restoreApiPreferences(priorPreferences)
                auth.account.value = priorAccount
                auth.state.value = priorSession
                localeManager.applicationLocales = priorLocale
                val duration = animatorScale.toFloatOrNull()
                if (duration == null) device.executeShellCommand("settings delete global animator_duration_scale")
                else device.executeShellCommand("settings put global animator_duration_scale $duration")
            }
        }
    }

    private fun hold(path: String) =
        ReadGate(path).also {
            check(held.compareAndSet(null, it))
        }

    private fun release(gate: ReadGate) {
        check(held.compareAndSet(gate, null))
        gate.release.countDown()
    }

    private fun progress(label: Int) = By.pkg(app.packageName).desc(app.getString(label))

    private fun verifyProgress(label: Int) {
        val bar = checkNotNull(device.wait(Until.findObject(progress(label)), 10_000))
        check(bar.visibleBounds.width() == device.displayWidth)
    }

    private fun waitForGone(label: Int) {
        check(device.wait(Until.gone(progress(label)), 10_000) == true)
    }

    private fun waitForCreditSkeleton(title: UiObject2) {
        val density = app.resources.displayMetrics.density
        val left = (54 * density).toInt()
        val bottom = title.visibleBounds.bottom
        val sampleRows = (bottom + (17 * density).toInt())..(bottom + (50 * density).toInt())
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        val bitmap = automation.takeScreenshot() ?: return false
                        return try {
                            sampleRows.any { y -> bitmap.getPixel(left, y) == 0xFFFAF5F3.toInt() }
                        } finally {
                            bitmap.recycle()
                        }
                    }
                },
                5_000,
            ) == true,
        ) { "Expected the personal credit skeleton to be visible before capture" }
    }

    private fun openSettings() {
        val entry =
            device.findObject(By.pkg(app.packageName).desc(app.getString(R.string.settings)))
        if (entry != null) entry.click()
        else {
            checkNotNull(
                    device.findObject(
                        By.pkg(app.packageName).desc(app.getString(R.string.chat_more_actions)),
                    ),
                )
                .click()
            text(R.string.settings).click()
        }
        text("Workspace A")
    }

    private fun open(resource: Int) {
        generateSequence(text(resource)) { it.parent }.first { it.isClickable }.click()
    }

    private fun back() {
        check(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        text("Workspace A")
    }

    private fun text(resource: Int) = text(app.getString(resource))

    private fun text(label: String): UiObject2 {
        val target = By.pkg(app.packageName).text(label)
        device.waitForIdle()
        if (!device.hasObject(target)) {
            val condition =
                object : Condition<UiObject2, Boolean> {
                    override fun apply(container: UiObject2) = device.hasObject(target)
                }
            val scroll = device.findObject(By.pkg(app.packageName).scrollable(true))
            if (scroll?.scrollUntil(Direction.UP, condition) != true) {
                scroll?.scrollUntil(Direction.DOWN, condition)
            }
        }
        return checkNotNull(device.wait(Until.findObject(target), 10_000)) {
            "Expected visible text $label"
        }
    }
}
