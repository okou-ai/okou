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
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.ComposerPersistence
import ai.okou.android.chat.ComposerSync
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.chat.HistoryPhase
import ai.okou.android.chatEventWire
import ai.okou.android.historyEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
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

    @Test
    fun captureConversationAndItsViewport() {
        val initialSize = overrideValue("wm size")
        val initialDensity = overrideValue("wm density")
        val initialScale = device.executeShellCommand("settings get system font_scale").trim()
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val initialLocale = localeManager.applicationLocales
        val initialAuth = auth.state.value
        val initialAccount = auth.account.value
        val initialChatService = app.chatService
        val initialComposerService = app.composerService
        val initialRealtime = app.realtimeService
        val initialPreferences = app.snapshotApiPreferences()
        val initialConnectivity = app.connectivity.value
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val drafts = ComposerApiFixture()
        val realtime = TestRealtimeService()
        val stage = AtomicInteger(0)
        installHistory(fixture, stage)
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            auth.state.value = testAuthenticationState(user = "conversation-capture")
            auth.account.value = NativeAccount("conversation-capture", "conversation@example.test")
            app.restoreApiPreferences(
                mapOf(
                    Triple(BuildConfig.API_ORIGIN, "conversation-capture", "org-a") to
                        testPreferences()
                            .copy(
                                locale = UserPreferencesLocale.ZH_HANS,
                                theme = UserPreferencesTheme.LIGHT,
                            )
                )
            )
            app.chatService = fixture.service
            app.composerService = drafts.service
            app.realtimeService = realtime
            app.connectivity.value = true
            setWindow("1080x2000", "420", "1.0")
            val current = ActivityScenario.launch(MainActivity::class.java).also { scenario = it }
            awaitWindow(current, 400..425, 720..820, 1f)
            device.awaitChatList(app)
            text("品牌发布").click()
            text(TITLE).click()

            val user = text(PROMPT).visibleBounds
            val heading = text(HEADING).visibleBounds
            text("我核对了文案、渠道素材和上线安排，还有三项需要你确认。")
            val send = description(app.getString(R.string.composer_send))
            val density = app.resources.displayMetrics.density
            check(
                user.left > heading.left &&
                    user.right <= device.displayWidth - (24 * density).toInt()
            )
            check(send.visibleBounds.width() >= (48 * density).toInt() - 1)
            capture("01-phone.png")
            captureDuringSync(current, fixture, running = false)

            stage.set(1)
            realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
            text(app.getString(R.string.conversation_processing))
            val stop = text(app.getString(R.string.conversation_stop))
            check(
                stop.visibleBounds.bottom <=
                    description(app.getString(R.string.composer_send)).visibleBounds.bottom
            )
            await(current) { fixture.readRequests.get() >= 2 }
            captureDuringSync(current, fixture, running = true)
            val reads = fixture.readRequests.get()
            val width = device.displayWidth
            val height = device.displayHeight
            val newReplyLabel = app.getString(R.string.conversation_new_reply)
            val atEnd = text(ACTIVE_PROMPT).visibleBounds
            val downTime = SystemClock.uptimeMillis()
            val x = width / 2f
            val y = height / 2f
            val draggedY = y + 22 * density
            sendTouch(downTime, MotionEvent.ACTION_DOWN, x, y)
            val held = try {
                sendTouch(downTime, MotionEvent.ACTION_MOVE, x, draggedY)
                instrumentation.waitForIdleSync()
                val dragging = text(ACTIVE_PROMPT).visibleBounds
                check(dragging.top > atEnd.top) { "The drag did not move the message: $atEnd to $dragging" }
                stage.set(2)
                realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_IN_PROJECT)))
                description(newReplyLabel)
                val afterReply = text(ACTIVE_PROMPT).visibleBounds
                check(afterReply == dragging) { "The reply moved the message: $dragging to $afterReply" }
                sendTouch(downTime, MotionEvent.ACTION_MOVE, x, draggedY + 4 * density)
                instrumentation.waitForIdleSync()
                text(ACTIVE_PROMPT).visibleBounds.also {
                    check(it.top > afterReply.top) { "The reader could not continue dragging" }
                }
            } finally {
                sendTouch(downTime, MotionEvent.ACTION_CANCEL, x, draggedY + 4 * density)
            }
            instrumentation.waitForIdleSync()
            val afterGesture = text(ACTIVE_PROMPT).visibleBounds
            check(afterGesture == held) { "The message moved on release: $held to $afterGesture" }
            check(device.swipe(width / 2, height / 3, width / 2, height * 2 / 3, 22))
            description(newReplyLabel)
            check(fixture.readRequests.get() == reads)
            check(!device.hasObject(textSelector(LATEST)))
            capture("02-reading-new-reply.png")
            description(app.getString(R.string.back)).click()
            device.awaitChatList(app)
            text(TITLE).click()
            val restoredJump = description(newReplyLabel)
            check(fixture.readRequests.get() == reads)
            check(!device.hasObject(textSelector(LATEST)))
            restoredJump.click()
            text(LATEST)
            await(current) { fixture.readRequests.get() > reads }

            setWindow("1180x820", "160", "1.0")
            awaitWindow(current, 1100..1200, 760..850, 1f)
            device.awaitChatList(app)
            val reply = text(LATEST).visibleBounds
            val listTitle = device.awaitChatList(app).visibleBounds
            check(reply.left > listTitle.right)
            check(!device.hasObject(By.pkg(app.packageName).desc(app.getString(R.string.back))))
            capture("03-wide.png")

            setWindow("720x400", "160", "2.0")
            awaitWindow(current, 690..730, 360..420, 2f)
            val shortStop =
                find(
                    By.pkg(app.packageName).clickable(true).desc(app.getString(R.string.controls_stop))
                ).visibleBounds
            val editorSelector = By.pkg(app.packageName).clazz("android.widget.EditText")
            val shortDraft = "请再核对邮件短版。"
            find(editorSelector).text = shortDraft
            await(current) {
                drafts.drafts["/api/chat-threads/$CHAT_IN_PROJECT/draft"]
                    ?.toString()?.contains(shortDraft) == true
            }
            val shortSend = description(app.getString(R.string.composer_send)).visibleBounds
            val editorBounds = find(editorSelector).visibleBounds
            check(shortStop.width() >= 48 && shortStop.height() >= 48) {
                "Compact Stop target was ${shortStop.toShortString()}"
            }
            check(shortStop.bottom < shortSend.top && shortStop.bottom < editorBounds.top &&
                editorBounds.right <= shortSend.left) {
                "Compact Stop, editor, and Send overlap: $shortStop, $editorBounds, $shortSend"
            }
            for (saving in listOf(R.string.composer_sync_saving, R.string.composer_saving)) {
                check(device.wait(Until.gone(textSelector(app.getString(saving))), 12_000))
            }
            capture("04-short.png")

            setWindow("1080x2000", "420", "1.0")
            awaitWindow(current, 400..425, 720..820, 1f)
            description(app.getString(R.string.back)).click()
            device.awaitChatList(app)
            text(app.getString(R.string.composer_new)).click()
            text(app.getString(R.string.conversation_welcome))
            val newTarget = ComposerTarget()
            await(current) { activity ->
                val state = ViewModelProvider(activity)[SessionModel::class.java]
                    .uiState.value.ready?.composer?.uiState?.value
                state != null && state.persistence == ComposerPersistence.Durable &&
                    state.sync(newTarget) == ComposerSync.Saved && state.entry(newTarget).text.isEmpty()
            }
            check(device.wait(Until.gone(textSelector(app.getString(R.string.composer_sync_loading))), 12_000))
            check(device.wait(Until.gone(textSelector(app.getString(R.string.composer_saving))), 12_000))
            check(!description(app.getString(R.string.composer_send)).isEnabled)
            capture("05-new-chat.png")
        } catch (failure: Throwable) {
            runCatching { capture("99-diagnostic.png") }.exceptionOrNull()?.let(failure::addSuppressed)
            throw failure
        } finally {
            scenario?.close()
            fixture.close()
            drafts.close()
            app.chatService = initialChatService
            app.composerService = initialComposerService
            app.realtimeService = initialRealtime
            app.connectivity.value = initialConnectivity
            auth.account.value = initialAccount
            auth.state.value = initialAuth
            app.restoreApiPreferences(initialPreferences)
            localeManager.applicationLocales = initialLocale
            device.executeShellCommand("wm size ${initialSize ?: "reset"}")
            device.executeShellCommand("wm density ${initialDensity ?: "reset"}")
            if (initialScale == "null")
                device.executeShellCommand("settings delete system font_scale")
            else device.executeShellCommand("settings put system font_scale $initialScale")
            cache.restore()
        }
    }

    private fun installHistory(fixture: ChatListApiFixture, stage: AtomicInteger) {
        val defaultEvents = fixture.events
        fixture.events = { request ->
            if (request.requestUrl?.queryParameter("sinceSeqId") != null) defaultEvents(request)
            else
                jsonResponse(
                    """{"events":[${chatEventWire()},${chatEventWire(id = "77777777-7777-4777-8777-777777777777", seq = 23, thread = CHAT_IN_PROJECT, extra = ",\"projectId\":\"$CHAT_PROJECT\"", title = TITLE)}],"hasMore":false}"""
                )
        }
        fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"品牌发布","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}"""
            )
        }
        fun rows(thread: String, page: Int): List<String> =
            buildList {
                add(prompt(thread, 1, "finished", PROMPT))
                add(
                    reply(
                        thread,
                        2,
                        "finished",
                        "# $HEADING\n\n我核对了文案、渠道素材和上线安排，还有三项需要你确认。\n\n- 发布文案：先说明用户能得到什么，再介绍产品细节。\n- 渠道素材：主图已齐，还差邮件和社区的短版本。\n- 上线排期：确认各渠道负责人和发布时间。",
                    )
                )
                add(historyEventWire(eventId(3), 3, thread, "run.completed", "null", runId("finished")))
                if (page >= 1) {
                    repeat(4) { step ->
                        val seq = 4 + step * 3
                        val run = "past-$step"
                        add(prompt(thread, seq, run, "请核对第 ${step + 1} 批发布资料。"))
                        add(
                            reply(
                                thread,
                                seq + 1,
                                run,
                                "第 ${step + 1} 批发布资料\n\n已整理邮件文案、社区短版和上线计划。负责人和渠道投放时间仍需确认。",
                            )
                        )
                        add(
                            historyEventWire(
                                eventId(seq + 2),
                                (seq + 2).toLong(),
                                thread,
                                "run.completed",
                                "null",
                                runId(run),
                            )
                        )
                    }
                    add(prompt(thread, 16, "active", ACTIVE_PROMPT))
                }
                if (page >= 2) {
                    add(reply(thread, 17, "active", RUNNING))
                    add(reply(thread, 18, "active", LATEST))
                }
            }
        fixture.historyCatchUp = { request ->
            val events = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonArray.associate { tuple ->
                val item = tuple.jsonArray
                val thread = item[0].jsonPrimitive.content
                thread to JsonArray(rows(thread, stage.get()).drop(item[1].jsonPrimitive.int)
                    .map { Json.parseToJsonElement(it) })
            }
            jsonResponse(JsonObject(mapOf(
                "events" to JsonObject(events),
                "notFoundThreads" to JsonArray(emptyList()),
            )).toString())
        }
        fixture.historyRows = { request ->
            val thread = checkNotNull(request.requestUrl).pathSegments[2]
            val after = request.requestUrl?.queryParameter("sinceSeqId")?.toInt() ?: 0
            val events = rows(thread, stage.get())
            val last = events.size
            jsonResponse(
                """{"rows":[${events.drop(after).joinToString(",")}],"cursor":{"lastEventId":"${eventId(last)}","lastSeqId":$last},"hasMore":false}"""
            )
        }
    }

    private fun prompt(thread: String, seq: Int, run: String, text: String) =
        historyEventWire(
            eventId(seq),
            seq.toLong(),
            thread,
            "input.prompt",
            """{"userMessage":{"version":1,"parts":[{"type":"text","text":${JsonPrimitive(text)}}]}}""",
            runId(run),
        )

    private fun reply(thread: String, seq: Int, run: String, text: String) =
        historyEventWire(
            eventId(seq),
            seq.toLong(),
            thread,
            payload = """{"content":${JsonPrimitive(text)}}""",
            run = runId(run),
        )

    private fun eventId(seq: Int) = "aaaaaaaa-aaaa-4aaa-8aaa-${seq.toString().padStart(12, '0')}"

    private fun runId(label: String) = UUID.nameUUIDFromBytes(label.encodeToByteArray()).toString()

    private fun textSelector(value: String) = By.pkg(app.packageName).text(value)

    private fun text(value: String) = find(textSelector(value))

    private fun description(value: String) = find(By.pkg(app.packageName).desc(value))

    private fun find(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $selector" }

    private fun captureDuringSync(
        scenario: ActivityScenario<MainActivity>,
        fixture: ChatListApiFixture,
        running: Boolean,
    ) {
        val runningLabel = app.getString(R.string.conversation_processing)
        val syncLabel = app.getString(R.string.history_syncing)
        val previousBounds = if (running) text(runningLabel).visibleBounds else null
        val refreshStarted = CountDownLatch(1)
        val finishRefresh = CountDownLatch(1)
        val rows = fixture.historyRows
        fixture.historyRows = { request ->
            refreshStarted.countDown()
            finishRefresh.await()
            rows(request)
        }
        try {
            scenario.onActivity { history(it).refresh() }
            await(scenario) {
                refreshStarted.count == 0L && history(it).uiState.value.phase == HistoryPhase.Loading
            }
            if (running) {
                // Keep the request pending past the design's 250ms notice threshold.
                val afterNoticeDelay = SystemClock.uptimeMillis() + 300
                await(scenario) { SystemClock.uptimeMillis() >= afterNoticeDelay }
                check(!device.hasObject(textSelector(syncLabel)))
                check(text(runningLabel).visibleBounds == previousBounds)
                capture("07-running-while-syncing.png")
            } else {
                text(syncLabel)
                capture("06-idle-while-syncing.png")
            }
        } finally {
            fixture.historyRows = rows
            finishRefresh.countDown()
        }
        await(scenario) { history(it).uiState.value.phase == HistoryPhase.Ready }
    }

    private fun history(activity: MainActivity) =
        checkNotNull(ViewModelProvider(activity)[SessionModel::class.java].uiState.value.ready)
            .chats.history

    private fun capture(file: String) {
        instrumentation.waitForIdleSync()
        ScreenshotCapture.capture(file)
    }

    private fun sendTouch(downTime: Long, action: Int, x: Float, y: Float) {
        val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0)
        try {
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            check(instrumentation.uiAutomation.injectInputEvent(event, true))
        } finally {
            event.recycle()
        }
    }

    private fun overrideValue(command: String) =
        Regex("Override (?:size|density): (\\S+)")
            .find(device.executeShellCommand(command))
            ?.groupValues
            ?.get(1)

    private fun setWindow(size: String, density: String, font: String) {
        device.executeShellCommand("wm size $size")
        device.executeShellCommand("wm density $density")
        device.executeShellCommand("settings put system font_scale $font")
    }

    private fun awaitWindow(
        scenario: ActivityScenario<MainActivity>,
        width: IntRange,
        height: IntRange,
        scale: Float,
    ) =
        await(scenario) { activity ->
            val resources = activity.resources
            val density = resources.displayMetrics.density
            val bounds: Rect = activity.windowManager.currentWindowMetrics.bounds
            (bounds.width() / density).toInt() in width &&
                (bounds.height() / density).toInt() in height &&
                resources.configuration.fontScale == scale
        }

    private fun await(
        scenario: ActivityScenario<MainActivity>,
        predicate: (MainActivity) -> Boolean,
    ) {
        check(
            device.wait(
                object : Condition<UiDevice, Boolean> {
                    override fun apply(unused: UiDevice): Boolean {
                        var ready = false
                        scenario.onActivity { ready = predicate(it) }
                        return ready
                    }
                },
                12_000,
            ) == true
        ) {
            "The activity did not reach the expected state"
        }
    }

    companion object {
        private const val TITLE = "发布前，还有哪些事要做？"
        private const val PROMPT = "发布前，还有哪些事需要确认？"
        private const val ACTIVE_PROMPT = "把发布资料核对一遍，给我一份可以转发的清单。"
        private const val HEADING = "先把这三件事确认好"
        private const val RUNNING = "发布前先确认首页文案、邮件短版和各渠道链接。"
        private const val LATEST = "渠道链接已核对，接下来确认邮件短版和上线时间。"
    }
}
