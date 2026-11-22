package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.NativeAccount
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.chatEventWire
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.view.WindowInsets
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)
    private val auth = app.authentication as TestAuthentication
    private val editor = By.pkg(app.packageName).clazz("android.widget.EditText")

    @Test
    fun captureConversationFind() {
        val initialSize = overrideValue("wm size")
        val initialDensity = overrideValue("wm density")
        val initialScale = device.executeShellCommand("settings get system font_scale").trim()
        val initialKeyboard = device.executeShellCommand(
            "settings get secure show_ime_with_hard_keyboard"
        ).trim()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val initialLocale = localeManager.applicationLocales
        val initialAuth = auth.state.value
        val initialAccount = auth.account.value
        val initialChats = app.chatService
        val initialComposer = app.composerService
        val initialRealtime = app.realtimeService
        val initialPreferences = app.snapshotApiPreferences()
        val initialConnectivity = app.connectivity.value
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val drafts = ComposerApiFixture()
        installFixture(fixture)
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            val user = "conversation-find-capture"
            auth.state.value = testAuthenticationState(user = user)
            auth.account.value = NativeAccount(user, "conversation-find@example.test")
            app.restoreApiPreferences(
                mapOf(
                    Triple(BuildConfig.API_ORIGIN, user, "org-a") to
                        testPreferences().copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                        )
                )
            )
            app.chatService = fixture.service
            app.composerService = drafts.service
            app.realtimeService = TestRealtimeService()
            app.connectivity.value = true
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            setWindow("1080x2000", "420")
            val current = ActivityScenario.launch(MainActivity::class.java).also { scenario = it }
            awaitWindow(current, 400..425)
            device.awaitChatList(app)
            text(PROJECT).click()
            text(TITLE).click()
            text(LATEST_HEADING)
            find(editor).text = DRAFT
            text(DRAFT)
            desc(R.string.chat_actions).click()
            val menu = button(text(app.getString(R.string.conversation_find)))
            verifyTapHeight(menu, 48, "Find menu item")
            capture("01-phone-menu.png")

            menu.click()
            text(app.getString(R.string.conversation_find_turns))
            awaitIme(current, true)
            device.awaitKeyboardFocus(By.copy(editor))
            verifyTapHeight(button(desc(R.string.back)), 48, "Find Back button")
            find(editor).text = KEYWORD
            val count = app.resources.getQuantityString(R.plurals.conversation_find_matches, 3, 3)
            text(count)
            val row = button(find(By.pkg(app.packageName).textContains(FOLDED_HIT)))
            verifyTapHeight(row, 52, "Find result row")
            capture("02-phone-results-with-keyboard.png")

            check(device.pressBack())
            awaitIme(current, false)
            text(count)
            text(KEYWORD)
            app.connectivity.value = false
            await(current) { activity ->
                ViewModelProvider(activity)[SessionModel::class.java].uiState.value
                    .ready?.chats?.uiState?.value?.offline == true
            }
            text(count)
            button(find(By.pkg(app.packageName).textContains(FOLDED_HIT))).click()
            val hit = text(FOLDED_HIT)
            check(hit.visibleBounds.height() >= pixels(25)) { "Clipped target ${hit.visibleBounds}" }
            text(DRAFT)
            capture("03-phone-folded-hit.png")

            desc(R.string.back).click()
            text(count)
            text(KEYWORD)
            awaitIme(current, false)
            desc(R.string.chat_search_clear).click()
            awaitIme(current, true)
            text(app.getString(R.string.conversation_find_turns))
            val newest = text(SECOND_PROMPT).visibleBounds
            val older = text(FIRST_PROMPT).visibleBounds
            check(newest.top < older.top)
            check(device.pressBack())
            awaitIme(current, false)
            capture("04-phone-browse-turns.png")
            desc(R.string.back).click()
            text(FOLDED_HIT)
            text(DRAFT)

            app.connectivity.value = true
            setWindow("1180x820", "160")
            awaitWindow(current, 1100..1200)
            val list = device.awaitChatList(app)
            text(LATEST_HEADING)
            desc(R.string.chat_actions).click()
            text(app.getString(R.string.conversation_find)).click()
            awaitIme(current, true)
            find(editor).text = KEYWORD
            text(count)
            check(device.pressBack())
            awaitIme(current, false)
            check(list.visibleBounds.right < find(editor).visibleBounds.left)
            capture("05-wide-results.png")
        } catch (failure: Throwable) {
            runCatching { capture("99-diagnostic.png") }.exceptionOrNull()?.let(failure::addSuppressed)
            throw failure
        } finally {
            scenario?.close()
            fixture.close()
            drafts.close()
            app.chatService = initialChats
            app.composerService = initialComposer
            app.realtimeService = initialRealtime
            app.connectivity.value = initialConnectivity
            auth.account.value = initialAccount
            auth.state.value = initialAuth
            app.restoreApiPreferences(initialPreferences)
            localeManager.applicationLocales = initialLocale
            device.executeShellCommand("wm size ${initialSize ?: "reset"}")
            device.executeShellCommand("wm density ${initialDensity ?: "reset"}")
            restoreSetting("system", "font_scale", initialScale)
            restoreSetting("secure", "show_ime_with_hard_keyboard", initialKeyboard)
            cache.restore()
        }
    }

    private fun installFixture(fixture: ChatListApiFixture) {
        val defaultEvents = fixture.events
        fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null) defaultEvents(request)
            else jsonResponse(
                """{"events":[${chatEventWire()},${chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 23, thread = CHAT_IN_PROJECT,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"", title = TITLE,
                )}],"hasMore":false}"""
            )
        }
        fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"$PROJECT","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}"""
            )
        }
        fun rows(thread: String) = listOf(
            prompt(thread, 1, "first", FIRST_PROMPT),
            reply(thread, 2, "first", "## 先把这三件事确认好\n\n我核对了文案、渠道素材和上线安排，还有三项需要你确认。\n\n- 首页确认发布文案。\n- 邮件确认发送名单。\n- 社区确认配图和短链。"),
            historyEventWire(id(3), 3, thread, "run.completed", "null", runId("first")),
            prompt(thread, 4, "second", SECOND_PROMPT),
            reply(thread, 5, "second", "## 素材复核记录\n\n我先核对了已有资料。\n\n$FOLDED_HIT\n\n接下来按负责人列出上线前的确认项。"),
            reply(thread, 6, "second", "## $LATEST_HEADING\n\n发布当天先确认首页文案、上线时间，以及各渠道是否就绪。\n\n- 官网：检查按钮和目标链接。\n- 邮件：检查发送名单。\n- 社区：核对发布时间。"),
            historyEventWire(id(7), 7, thread, "run.completed", "null", runId("second")),
        )
        fixture.historyCatchUp = { request ->
            val events = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonArray
                .associate { tuple ->
                    val item = tuple.jsonArray
                    val thread = item[0].jsonPrimitive.content
                    thread to JsonArray(
                        rows(thread).drop(item[1].jsonPrimitive.int).map(Json::parseToJsonElement)
                    )
                }
            jsonResponse(JsonObject(mapOf(
                "events" to JsonObject(events),
                "notFoundThreads" to JsonArray(emptyList()),
            )).toString())
        }
        fixture.historyRows = { request ->
            val url = checkNotNull(request.requestUrl)
            val after = url.queryParameter("sinceSeqId")?.toInt() ?: 0
            val events = rows(url.pathSegments[2])
            val body = events.drop(after).joinToString(",")
            jsonResponse(
                """{"rows":[$body],"cursor":{"lastEventId":"${id(events.size)}","lastSeqId":${events.size}},"hasMore":false}"""
            )
        }
    }

    private fun prompt(thread: String, seq: Int, run: String, text: String) =
        historyEventWire(
            id(seq), seq.toLong(), thread, "input.prompt",
            """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]}}""",
            runId(run),
        )

    private fun reply(thread: String, seq: Int, run: String, text: String) =
        historyEventWire(
            id(seq), seq.toLong(), thread,
            payload = """{"content":${JsonPrimitive(text)}}""",
            run = runId(run),
        )

    private fun id(seq: Int) = "aaaaaaaa-aaaa-4aaa-8aaa-${seq.toString().padStart(12, '0')}"

    private fun runId(label: String) = UUID.nameUUIDFromBytes(label.encodeToByteArray()).toString()

    private fun text(value: String) = find(By.pkg(app.packageName).text(value))

    private fun desc(label: Int) = find(By.pkg(app.packageName).desc(app.getString(label)))

    private fun find(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $selector" }

    private fun button(label: UiObject2): UiObject2 =
        checkNotNull(generateSequence(label) { it.parent }.firstOrNull { it.isClickable }) {
            "Missing clickable ancestor for ${label.text ?: label.contentDescription}"
        }

    private fun verifyTapHeight(button: UiObject2, minimumDp: Int, label: String) {
        val bounds = button.visibleBounds
        check(bounds.height() >= pixels(minimumDp)) { "$label target was $bounds, below ${minimumDp}dp" }
    }

    private fun pixels(dp: Int) = (dp * app.resources.displayMetrics.density - 1).toInt()

    private fun capture(file: String) {
        instrumentation.waitForIdleSync()
        ScreenshotCapture.capture(file)
    }

    private fun overrideValue(command: String) =
        Regex("Override (?:size|density): (\\S+)").find(device.executeShellCommand(command))
            ?.groupValues?.get(1)

    private fun setWindow(size: String, density: String) {
        device.executeShellCommand("wm size $size")
        device.executeShellCommand("wm density $density")
        device.executeShellCommand("settings put system font_scale 1.0")
    }

    private fun restoreSetting(namespace: String, key: String, value: String) {
        if (value == "null") device.executeShellCommand("settings delete $namespace $key")
        else device.executeShellCommand("settings put $namespace $key $value")
    }

    private fun awaitWindow(scenario: ActivityScenario<MainActivity>, width: IntRange) =
        await(scenario) { activity ->
            val density = activity.resources.displayMetrics.density
            (activity.windowManager.currentWindowMetrics.bounds.width() / density).toInt() in width
        }

    private fun awaitIme(scenario: ActivityScenario<MainActivity>, visible: Boolean) =
        await(scenario) { activity ->
            activity.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == visible
        }

    private fun await(
        scenario: ActivityScenario<MainActivity>,
        predicate: (MainActivity) -> Boolean,
    ) {
        check(device.wait(object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean {
                var ready = false
                scenario.onActivity { ready = predicate(it) }
                return ready
            }
        }, 12_000) == true) { "The activity did not reach the expected state" }
    }

    companion object {
        private const val PROJECT = "品牌发布"
        private const val TITLE = "发布前，还有哪些事要做？"
        private const val FIRST_PROMPT = "发布前，还有哪些事需要确认？"
        private const val SECOND_PROMPT = "把确认项按负责人和先后顺序整理一下，我想发给团队。"
        private const val FOLDED_HIT = "渠道素材已经齐备，社区短版待确认。"
        private const val LATEST_HEADING = "发布前检查清单"
        private const val KEYWORD = "渠道"
        private const val DRAFT = "请再确认上线时间。"
    }
}
