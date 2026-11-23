package ai.okou.android.workflows

import ai.okou.android.CHAT_DATE
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.WorkflowAutomationVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1Kind
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1
import ai.okou.android.api.generated.WorkflowAutomationVariant1ScheduleVariant1Type
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowDetailVisibility
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.api.generated.WorkflowSummaryVisibility
import ai.okou.android.api.generated.WorkspaceWorkflowAutomations
import ai.okou.android.api.generated.WorkspaceWorkflowAutomationsItem
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkflowModelTest {
    @Test
    fun reopeningRevalidatesEachRangeAndOnlyShowsItsUnexpiredCache() = check { service, model ->
        val rules = CompletableDeferred<WorkspaceWorkflowAutomations>()
        val connections = CompletableDeferred<Set<String>>()
        service.rulesRead = { rules.await() }
        service.connectionsRead = { connections.await() }

        fun reopen() {
            model.visibilityChanged(false)
            model.visibilityChanged(true)
            runCurrent()
        }

        model.visibilityChanged(true)
        runCurrent()
        advanceTimeBy(1_000)
        rules.complete(emptyList())
        runCurrent()
        advanceTimeBy(1_000)
        connections.complete(setOf("gmail"))
        runCurrent()
        advanceTimeBy(1_000)
        model.select(service.summary.id)
        runCurrent()

        val refresh = CompletableDeferred<Unit>()
        service.catalogRead = {
            refresh.await()
            listOf(service.summary)
        }
        service.rulesRead = {
            refresh.await()
            emptyList()
        }
        service.connectionsRead = {
            refresh.await()
            setOf("gmail")
        }
        service.detailRead = {
            refresh.await()
            service.detail
        }

        reopen()
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertTrue(model.state.value.rules?.isEmpty() == true)
        assertEquals(setOf("gmail"), model.state.value.connections)
        assertEquals(service.detail, model.state.value.detail)
        assertEquals(2, service.catalogReads)
        assertEquals(2, service.ruleReads)
        assertEquals(2, service.connectionReads)
        assertEquals(2, service.detailReads)

        advanceTimeBy(597_000)
        assertEquals(listOf(service.summary), model.state.value.catalog)
        reopen()
        assertNull(model.state.value.catalog)
        assertTrue(model.state.value.rules?.isEmpty() == true)
        assertEquals(setOf("gmail"), model.state.value.connections)
        assertEquals(service.detail, model.state.value.detail)

        advanceTimeBy(1_000)
        reopen()
        assertNull(model.state.value.rules)
        assertEquals(setOf("gmail"), model.state.value.connections)
        assertEquals(service.detail, model.state.value.detail)

        advanceTimeBy(1_000)
        reopen()
        assertNull(model.state.value.connections)
        assertEquals(service.detail, model.state.value.detail)

        advanceTimeBy(1_000)
        reopen()
        assertNull(model.state.value.detail)
        refresh.complete(Unit)
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertEquals(service.detail, model.state.value.detail)
    }

    @Test
    fun switchingBackShowsCachedDetailAndReadsTheLatestWhileItIsVisible() =
        check { service, model ->
            val first = service.detail
            val second = first.copy(id = "b2222222-2222-4222-8222-222222222222", name = "other")
            service.catalogRead = { listOf(service.summary, service.summary.copy(id = second.id)) }
            service.detailRead = { if (it == first.id) first else second }
            model.visibilityChanged(true)
            model.select(first.id)
            runCurrent()
            model.select(second.id)
            runCurrent()
            assertEquals(second, model.state.value.detail)

            val updated = CompletableDeferred<WorkflowDetail>()
            service.detailRead = { updated.await() }
            model.select(first.id)
            assertEquals(first, model.state.value.detail)
            runCurrent()
            assertEquals(3, service.detailReads)
            assertEquals(first, model.state.value.detail)

            model.detailTabOpened(checkConnections = false)
            runCurrent()
            assertEquals(3, service.detailReads)

            val refreshed = first.copy(displayName = "Refreshed")
            updated.complete(refreshed)
            runCurrent()
            assertEquals(refreshed, model.state.value.detail)
        }

    @Test
    fun openingOfflineAttemptsAReadThenResumesOnReconnect() = check { service, model ->
        var reads = 0
        service.catalogRead = {
            reads++
            if (reads == 1) throw ApiFailure.Network(IOException("Offline"))
            listOf(service.summary)
        }
        model.connectivityChanged(true)
        model.visibilityChanged(true)
        runCurrent()

        assertEquals(1, reads)
        assertEquals(WorkflowReadFailure.Offline, model.state.value.catalogFailure)
        assertNull(model.state.value.catalog)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, reads)

        model.connectivityChanged(false)
        runCurrent()
        assertEquals(2, reads)
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertNull(model.state.value.catalogFailure)
    }

    @Test
    fun reconnectDoesNotWaitForTheCurrentBackoff() = check { service, model ->
        service.catalogRead = {
            if (service.catalogReads == 1) throw ApiFailure.Network(IOException("Offline"))
            listOf(service.summary)
        }
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(WorkflowReadFailure.CouldNotLoad, model.state.value.catalogFailure)

        model.connectivityChanged(true)
        model.connectivityChanged(false)
        runCurrent()

        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertNull(model.state.value.catalogFailure)
        assertEquals(2, service.catalogReads)
        assertEquals(1, service.connectionReads)
    }

    @Test
    fun reconnectRestartsTheFailedDetailWhileTheCatalogIsStillReadingConnections() =
        check { service, model ->
            val connections = CompletableDeferred<Set<String>>()
            service.connectionsRead = { connections.await() }
            service.detailRead = {
                if (service.detailReads == 1) throw ApiFailure.Network(IOException("Offline"))
                service.detail
            }
            model.connectivityChanged(true)
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            assertEquals(WorkflowReadFailure.Offline, model.state.value.detailFailure)

            model.connectivityChanged(false)
            runCurrent()
            assertEquals(service.detail, model.state.value.detail)
            assertNull(model.state.value.detailFailure)
            assertNull(model.state.value.connections)
        }

    @Test
    fun cachedReadsBackOffIndependentlyAndOnlyWarnAfterSustainedFailure() =
        check { service, model ->
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            assertNotNull(model.state.value.catalog)
            val opened = checkNotNull(model.state.value.detail).editableInstructions()
            val editing = opened.copy(value = opened.value.copy(instruction = "Unsaved edit"))
            model.edit(editing)

            val catalogAttempts = mutableListOf<Long>()
            service.catalogRead = {
                catalogAttempts += testScheduler.currentTime - 600_000
                if (catalogAttempts.size <= 3) throw ApiFailure.Network(IOException("Offline"))
                listOf(service.summary)
            }
            model.foregroundChanged(false)
            advanceTimeBy(600_000)
            model.foregroundChanged(true)
            runCurrent()

            advanceTimeBy(29_999)
            runCurrent()
            assertEquals(listOf(0L, 5_000L, 15_000L), catalogAttempts)
            assertEquals(listOf(service.summary), model.state.value.catalog)
            assertEquals(WorkflowReadFailure.CouldNotLoad, model.state.value.catalogFailure)
            assertNull(model.state.value.detailFailure)
            assertEquals(editing, model.state.value.editor)
            assertEquals(2, service.detailReads)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(WorkflowReadFailure.RefreshFailed, model.state.value.catalogFailure)
            advanceTimeBy(5_000)
            runCurrent()
            assertEquals(listOf(0L, 5_000L, 15_000L, 35_000L), catalogAttempts)
            assertNull(model.state.value.catalogFailure)
            assertEquals(2, service.detailReads)
        }

    @Test
    fun olderDetailCannotReplaceNewerCatalogAndRules() = check { service, model ->
        val olderDetail = CompletableDeferred<WorkflowDetail>()
        val latestSummary = service.summary.copy(displayName = "Renamed on another device")
        val active = service.weeklyRule()
        service.detailRead = { olderDetail.await() }
        service.catalogRead = { listOf(latestSummary) }
        service.rulesRead = { listOf(WorkspaceWorkflowAutomationsItem(latestSummary, active)) }

        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        assertNull(model.state.value.detail)
        assertEquals(listOf(latestSummary), model.state.value.catalog)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))

        olderDetail.complete(
            service.detail.copy(automations = listOf(active.copy(enabled = false)))
        )
        runCurrent()
        assertEquals(latestSummary.displayName, model.state.value.detail?.displayName)
        assertEquals(listOf(latestSummary), model.state.value.catalog)
        assertEquals(listOf(active), model.state.value.detail?.automations)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))
    }

    @Test
    fun directoryKeepsConfirmedRulesAfterLeavingDetail() = check { service, model ->
        val rules = CompletableDeferred<WorkspaceWorkflowAutomations>()
        val connections = CompletableDeferred<Set<String>>()
        val active = service.weeklyRule()
        service.detail = service.detail.copy(automations = listOf(active))
        service.rulesRead = { rules.await() }
        service.connectionsRead = { connections.await() }
        model.visibilityChanged(true)
        runCurrent()
        model.select(service.summary.id)
        runCurrent()
        assertEquals(listOf(active), model.state.value.detail?.automations)
        model.select(null)
        assertNull(model.state.value.detail)

        val paused = active.copy(enabled = false)
        rules.complete(listOf(WorkspaceWorkflowAutomationsItem(service.summary, paused)))
        runCurrent()
        assertNull(model.state.value.connections)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))

        connections.complete(emptySet())
        runCurrent()
        assertEquals(emptySet<String>(), model.state.value.connections)
        assertEquals(listOf(active), model.state.value.rules?.get(service.summary.id))

        model.select(service.summary.id)
        runCurrent()
        assertEquals(listOf(active), model.state.value.detail?.automations)
        assertEquals(2, service.detailReads)
        advanceTimeBy(600_000)
        val refreshedDetail = CompletableDeferred<WorkflowDetail>()
        service.detailRead = { refreshedDetail.await() }
        model.connectivityChanged(true)
        model.connectivityChanged(false)
        runCurrent()
        assertEquals(listOf(paused), model.state.value.rules?.get(service.summary.id))
        assertEquals(listOf(paused), model.state.value.detail?.automations)

        refreshedDetail.complete(service.detail.copy(automations = listOf(paused)))
        runCurrent()
        assertEquals(listOf(paused), model.state.value.detail?.automations)
    }

    @Test
    fun directoryKeepsConfirmedSummaryWhenOlderCatalogArrives() = check { service, model ->
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)

        val catalog = CompletableDeferred<List<WorkflowSummary>>()
        service.catalogRead = { catalog.await() }
        advanceTimeBy(600_000)
        model.connectivityChanged(true)
        model.connectivityChanged(false)
        runCurrent()

        val published =
            service.summary.copy(
                displayName = "Published release review",
                description = "Review the deployment",
                visibility = WorkflowSummaryVisibility.PUBLIC,
            )
        service.detail =
            service.detail.copy(
                displayName = published.displayName,
                description = published.description,
                visibility = WorkflowDetailVisibility.PUBLIC,
            )
        model.select(service.summary.id)
        runCurrent()
        assertEquals(published.displayName, model.state.value.detail?.displayName)
        model.select(null)
        catalog.complete(listOf(service.summary))
        runCurrent()
        assertEquals(listOf(published), model.state.value.catalog)

        model.visibilityChanged(false)
        advanceTimeBy(600_000)
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(listOf(service.summary), model.state.value.catalog)
    }

    @Test
    fun lateCatalogLeavesUnavailableWorkflowRemoved() = check { service, model ->
        val other = service.summary.copy(id = "b2222222-2222-4222-8222-222222222222")
        val previous = listOf(service.summary, other)
        service.catalogRead = { previous }
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(previous, model.state.value.catalog)

        val catalog = CompletableDeferred<List<WorkflowSummary>>()
        service.catalogRead = { catalog.await() }
        advanceTimeBy(600_000)
        model.connectivityChanged(true)
        model.connectivityChanged(false)
        runCurrent()

        service.detailRead = { throw ApiFailure.Http(404, null, null, null) }
        model.select(service.summary.id)
        runCurrent()
        assertEquals(WorkflowReadFailure.Unavailable, model.state.value.detailFailure)
        assertEquals(listOf(other), model.state.value.catalog)
        model.select(null)

        catalog.complete(previous)
        runCurrent()
        assertEquals(listOf(other), model.state.value.catalog)
    }

    @Test
    fun aRefreshedCatalogRemovesAStillFreshDetailThatIsNoLongerVisible() = check { service, model ->
        model.visibilityChanged(true)
        runCurrent()
        advanceTimeBy(60_000)
        model.select(service.summary.id)
        runCurrent()
        assertEquals(service.detail, model.state.value.detail)
        model.select(null)

        service.catalogRead = { emptyList() }
        model.visibilityChanged(false)
        advanceTimeBy(540_000)
        model.visibilityChanged(true)
        runCurrent()
        assertEquals(emptyList<WorkflowSummary>(), model.state.value.catalog)
        assertEquals(1, service.detailReads)

        service.detailRead = { throw ApiFailure.Http(404, null, null, null) }
        model.select(service.summary.id)
        assertNull(model.state.value.detail)
        runCurrent()
        assertEquals(2, service.detailReads)
        assertNull(model.state.value.detail)
        assertEquals(WorkflowReadFailure.Unavailable, model.state.value.detailFailure)
    }

    @Test
    fun successfulSaveRestartsCatalogWithoutRestartingAnIndependentConnectionRead() =
        check { service, model ->
            var holdCatalog = true
            val connections = CompletableDeferred<Set<String>>()
            service.catalogRead = {
                if (holdCatalog) awaitCancellation()
                listOf(service.summary)
            }
            service.connectionsRead = { connections.await() }
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            assertNotNull(model.state.value.detail)
            assertNull(model.state.value.catalog)

            holdCatalog = false
            val opened = checkNotNull(model.state.value.detail).editableInstructions()
            val edited = opened.copy(value = opened.value.copy(instruction = "Confirmed"))
            model.edit(edited)
            model.save(edited)
            runCurrent()

            assertEquals("Confirmed", model.state.value.detail?.instruction)
            assertEquals(listOf(service.summary), model.state.value.catalog)
            assertTrue(model.state.value.rules?.isEmpty() == true)
            assertEquals(1, service.connectionReads)
            connections.complete(setOf("gmail"))
            runCurrent()
            assertEquals(setOf("gmail"), model.state.value.connections)
        }

    @Test
    fun instructionSaveUsesTheCurrentEditor() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val previous = opened.copy(value = opened.value.copy(instruction = "Older edit"))
        val current = opened.copy(value = opened.value.copy(instruction = "Current edit"))
        model.edit(previous)
        model.edit(current)
        model.save(previous)
        runCurrent()

        assertEquals(current, model.state.value.editor)
        assertNull(model.state.value.detail?.instruction)
        model.save(current)
        runCurrent()
        assertEquals("Current edit", model.state.value.detail?.instruction)
        assertNull(model.state.value.editor)
    }

    @Test
    fun aConfirmedSaveRefreshesTheDetailCacheAge() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        advanceTimeBy(590_000)
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val edited = opened.copy(value = opened.value.copy(instruction = "Confirmed"))
        model.edit(edited)
        model.save(edited)
        runCurrent()
        assertEquals(1, service.detailReads)

        model.visibilityChanged(false)
        advanceTimeBy(20_000)
        service.detailRead = { awaitCancellation() }
        model.visibilityChanged(true)
        assertNull(model.state.value.catalog)
        assertEquals("Confirmed", model.state.value.detail?.instruction)
        runCurrent()
        assertEquals(2, service.detailReads)
        assertEquals("Confirmed", model.state.value.detail?.instruction)
    }

    @Test
    fun uncertainCreationIgnoresAnotherSaveFromTheSameEditor() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val editor = WorkflowEdit.Rule(id = null, original = RuleFields(timezone = "UTC"))
        model.edit(editor)
        model.connectivityChanged(true)
        model.save(editor)
        runCurrent()

        assertEquals(WorkflowWriteFailure.UncertainCreate, model.state.value.issue?.failure)
        assertEquals(editor, model.state.value.editor)
        assertEquals(2, service.detailReads)
        assertEquals(1, service.catalogReads)
        assertEquals(1, service.ruleReads)
        assertEquals(1, service.connectionReads)
        model.connectivityChanged(false)
        model.save(editor)
        runCurrent()
        assertEquals(1, service.createAttempts)
    }

    private fun check(action: suspend TestScope.(Service, WorkflowModel) -> Unit) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val service = Service()
        val store = ViewModelStore()
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        WorkflowModel(service, { true }, { throw it }) { testScheduler.currentTime }
                    }
                },
            )[WorkflowModel::class.java]
        try {
            model.foregroundChanged(true)
            action(service, model)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    private class Service : WorkflowService {
        val summary =
            WorkflowSummary(
                id = "a1111111-1111-4111-8111-111111111111",
                name = "release-review",
                displayName = "Release review",
                description = null,
                visibility = WorkflowSummaryVisibility.PRIVATE,
                ownerUserId = "user-a",
                createdAt = CHAT_DATE,
                canManage = true,
                canPublish = true,
                official = null,
                importSource = null,
            )
        var detail =
            WorkflowDetail(
                id = summary.id,
                name = summary.name,
                displayName = summary.displayName,
                description = null,
                visibility = WorkflowDetailVisibility.PRIVATE,
                ownerUserId = summary.ownerUserId,
                createdAt = CHAT_DATE,
                canManage = true,
                canPublish = true,
                official = null,
                importSource = null,
                createdByUserId = summary.ownerUserId,
                updatedByUserId = summary.ownerUserId,
                updatedAt = CHAT_DATE,
                instruction = null,
                files = null,
                fileContents = null,
                automations = emptyList(),
            )
        var catalogRead: suspend () -> List<WorkflowSummary> = { listOf(summary) }
        var detailRead: suspend (String) -> WorkflowDetail = { detail }
        var rulesRead: suspend () -> WorkspaceWorkflowAutomations = { emptyList() }
        var connectionsRead: suspend () -> Set<String> = { emptySet() }
        var detailReads = 0
            private set

        var catalogReads = 0
            private set

        var ruleReads = 0
            private set

        var connectionReads = 0
            private set

        var createAttempts = 0
            private set

        fun weeklyRule() =
            WorkflowAutomationVariant1(
                id = "weekly",
                ownerUserId = summary.ownerUserId,
                enabled = true,
                chatThreadId = null,
                nextRunAt = CHAT_DATE,
                lastRunAt = null,
                official = null,
                kind = WorkflowAutomationVariant1Kind.SCHEDULE,
                schedule =
                    WorkflowAutomationVariant1ScheduleVariant1(
                        WorkflowAutomationVariant1ScheduleVariant1Type.CRON,
                        "0 9 * * 1",
                        "UTC",
                    ),
                scheduleSummary = "Weekly at 09:00",
            )

        override suspend fun workflows(): List<WorkflowSummary> {
            catalogReads++
            return catalogRead()
        }

        override suspend fun workflow(id: String): WorkflowDetail {
            detailReads++
            return detailRead(id)
        }

        override suspend fun workflowAutomations(): WorkspaceWorkflowAutomations {
            ruleReads++
            return rulesRead()
        }

        override suspend fun workflowConnections(): Set<String> {
            connectionReads++
            return connectionsRead()
        }

        override suspend fun updateWorkflow(
            id: String,
            request: UpdateWorkflowRequest,
        ): WorkflowDetail {
            detail =
                detail.copy(instruction = (request.instruction as CanonicalOptional.Present).value)
            return detail
        }

        override suspend fun createAutomation(
            workflowId: String,
            request: CreateWorkflowAutomationRequest,
        ): Nothing {
            createAttempts++
            throw ApiFailure.Network(IOException("Automation response was lost"))
        }

        override suspend fun updateAutomation(
            id: String,
            request: UpdateWorkflowAutomationRequest,
        ) = error("Unexpected automation update")

        override suspend fun setAutomationEnabled(id: String, enabled: Boolean) =
            error("Unexpected automation toggle")
    }
}
