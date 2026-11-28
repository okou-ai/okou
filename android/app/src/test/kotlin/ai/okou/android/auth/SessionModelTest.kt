package ai.okou.android.auth

import ai.okou.android.TestAuthentication
import ai.okou.android.TestChatComposerService
import ai.okou.android.TestChatService
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AcceptedInput
import ai.okou.android.api.generated.PersonalInstructions
import ai.okou.android.api.generated.SendRequest
import ai.okou.android.api.generated.UpdatePreferencesRequest
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.chat.ChatComposerService
import ai.okou.android.chat.ChatListService
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ProjectExpansionStore
import ai.okou.android.chat.RunControlOwners
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.preferences.CachedMemberPreferences
import ai.okou.android.preferences.MemberPreferencesCache
import ai.okou.android.settings.DefaultModelStore
import ai.okou.android.testAuthenticationState
import ai.okou.android.testOrganization
import ai.okou.android.testPreferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import com.clerk.api.network.serialization.ClerkResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
abstract class SessionModelTestFixture {
    @get:Rule val temporary = TemporaryFolder()

    protected class Resource(val identity: WorkspaceIdentity, val tokens: WorkspaceTokenProvider) :
        WorkspaceSession,
        ai.okou.android.chat.AssistantRecoveryService by ai.okou.android
            .TestAssistantRecoveryService(),
        ai.okou.android.chat.RealtimeService by ai.okou.android.TestRealtimeService(),
        ChatListService by TestChatService(),
        ai.okou.android.chat.WorkspaceSearchService by ai.okou.android.EmptyWorkspaceSearchService,
        ChatComposerService by TestChatComposerService() {
        var closed = false
        private val canonical = CanonicalWorkspaceSession(identity, tokens)
        override val artifacts = canonical.artifacts

        override suspend fun usagePackCredits() = canonical.usagePackCredits()

        override suspend fun defaultModelPreference() = canonical.defaultModelPreference()

        override suspend fun featureSwitches() = canonical.featureSwitches()

        override suspend fun updateDefaultModelPreference(
            update: ai.okou.android.api.generated.UpdateDefaultModelPreference,
        ) = canonical.updateDefaultModelPreference(update)

        override suspend fun activateModelAccount(accountId: String) =
            canonical.activateModelAccount(accountId)

        override suspend fun emailSubscription() = canonical.emailSubscription()

        override suspend fun updateEmailSubscription(subscribed: Boolean) =
            canonical.updateEmailSubscription(subscribed)

        override suspend fun sendControl(request: SendRequest): AcceptedInput =
            error("No control backend in this fixture")

        var verifyOrganization = suspend { testOrganization(identity.workspaceId) }
        var loadPreferences = suspend { testPreferences() }
        var update: suspend () -> Unit = {}

        override suspend fun organization() = verifyOrganization()

        override suspend fun preferences() = loadPreferences()

        override suspend fun personalInstructions(): PersonalInstructions =
            error("Instructions are not enabled in this fixture")

        override suspend fun updatePersonalInstructions(
            content: String,
            ifVersion: String,
        ): PersonalInstructions = error("Instructions are not enabled in this fixture")

        override suspend fun updatePreferences(update: UpdatePreferencesRequest) =
            preferences().also { this.update() }

        override fun close() {
            closed = true
            canonical.close()
        }
    }

    protected fun check(
        auth: TestAuthentication = TestAuthentication(),
        configure: (Resource) -> Unit = {},
        preparePreferences: suspend MemberPreferencesCache.() -> Unit = {},
        block: suspend TestScope.(SessionModel, MutableList<Resource>) -> Unit,
    ) = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        val resources = mutableListOf<Resource>()
        val drafts =
            PersonalInstructionsDraftStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        val cache =
            ChatCacheStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        val journal =
            ComposerJournalStore(
                ApplicationProvider.getApplicationContext(),
                temporary.newFolder(),
                dispatcher,
            )
        val controls = RunControlOwners()
        val preferencesDirectory = temporary.newFolder()
        val preferencesCache = MemberPreferencesCache({ preferencesDirectory }, dispatcher)
        val expansionFile = temporary.newFolder().resolve("project-expansion.preferences_pb")
        val expansion =
            ProjectExpansionStore(
                PreferenceDataStoreFactory.create(scope = backgroundScope) { expansionFile },
            )
        val defaultModelFile = temporary.newFolder().resolve("default-model.preferences_pb")
        val defaultModelStore =
            DefaultModelStore(
                PreferenceDataStoreFactory.create(scope = backgroundScope) { defaultModelFile },
                backgroundScope,
            )
        try {
            preferencesCache.preparePreferences()
            val model =
                ViewModelProvider(
                    store,
                    viewModelFactory {
                        initializer {
                            SessionModel(
                                auth,
                                WorkspaceSessionFactory { identity, tokens ->
                                    Resource(identity, tokens).also {
                                        configure(it)
                                        resources += it
                                    }
                                },
                                "https://api.okou.ai/",
                                cache,
                                drafts,
                                journal,
                                controls,
                                preferencesCache,
                                expansion,
                                defaultModelStore,
                                dispatcher,
                            )
                        }
                    },
                )[SessionModel::class.java]
            block(model, resources)
        } finally {
            store.clear()
            cache.close()
            drafts.close()
            journal.close()
            runCurrent()
            Dispatchers.resetMain()
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class SessionEntryModelTest : SessionModelTestFixture() {
    @Test
    fun pendingAuthenticationAndSignedOutNeverOpenWorkspaceResources() {
        val auth = TestAuthentication(AuthenticationState())
        check(auth) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Restoring, model.uiState.value.stage)
            assertTrue(resources.isEmpty())
            auth.state.value = AuthenticationState(initialized = true)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
            assertTrue(resources.isEmpty())
        }
    }

    @Test
    fun webSetupReturnChecksOnceInPlaceAndKeepsConfirmedEmptyStateOnFailure() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        auth.available = emptyList()
        check(auth) { model, _ ->
            runCurrent()
            val empty = model.uiState.value
            assertEquals(SessionStage.ChooseWorkspace, empty.stage)
            val response = CompletableDeferred<List<WorkspaceMembership>>()
            var checks = 0
            auth.membershipsAction = {
                checks++
                response.await()
            }
            model.openWorkspaceSetup(empty.generation) { true }
            model.foregroundChanged(false)
            model.foregroundChanged(true)
            runCurrent()
            assertEquals(empty.copy(checkingWorkspace = true), model.uiState.value)
            model.retry(empty.generation)
            model.foregroundChanged(true)
            response.completeExceptionally(IllegalStateException("read failed"))
            runCurrent()
            assertEquals(1, checks)
            val recovered = model.uiState.value
            assertEquals(SessionStage.ChooseWorkspace, recovered.stage)
            assertTrue(recovered.memberships.isEmpty())
            assertFalse(recovered.checkingWorkspace)
            assertEquals(SessionEntryFailure.Check, recovered.entryFailure)
        }
    }

    @Test
    fun webSetupWaitsForReturnAcrossMembershipUpdatesForTheSameSession() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        val available = auth.available
        auth.available = emptyList()
        check(auth) { model, _ ->
            model.foregroundChanged(true)
            runCurrent()
            val empty = model.uiState.value
            val response = CompletableDeferred<List<WorkspaceMembership>>()
            var checks = 0
            auth.membershipsAction = {
                checks++
                response.await()
            }
            model.openWorkspaceSetup(empty.generation) { true }
            model.foregroundChanged(false)

            val access = MembershipAccess("org-a", "org:member", null)
            auth.state.value = auth.state.value.copy(membershipAccess = listOf(access))
            runCurrent()
            assertEquals(empty, model.uiState.value)
            assertEquals(0, checks)

            auth.state.value =
                auth.state.value.copy(
                    membershipAccess = listOf(access.copy(permissions = emptyList())),
                )
            model.foregroundChanged(true)
            runCurrent()
            assertEquals(empty.copy(checkingWorkspace = true), model.uiState.value)
            assertEquals(1, checks)

            response.complete(available)
            runCurrent()
            model.foregroundChanged(false)
            model.foregroundChanged(true)
            runCurrent()
            assertEquals(available, model.uiState.value.memberships)
            assertFalse(model.uiState.value.checkingWorkspace)
            assertEquals(1, checks)
        }
    }

    @Test
    fun workspaceSetupOnlyLaunchesFromTheCurrentEmptyPicker() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        val available = auth.available
        auth.available = emptyList()
        check(auth) { model, _ ->
            runCurrent()
            val empty = model.uiState.value
            model.openWorkspaceSetup(empty.generation) { false }
            assertEquals(
                empty.copy(entryFailure = SessionEntryFailure.Browser),
                model.uiState.value,
            )

            auth.available = available
            model.retry(empty.generation)
            runCurrent()
            val picker = model.uiState.value
            assertEquals(available, picker.memberships)
            model.openWorkspaceSetup(empty.generation) {
                error("The stale action opened a browser")
            }
            assertEquals(picker, model.uiState.value)
        }
    }

    @Test
    fun failedBrowserLaunchKeepsItsFeedbackWhenThePendingCheckConfirmsNoWorkspace() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        auth.available = emptyList()
        check(auth) { model, _ ->
            runCurrent()
            val empty = model.uiState.value
            val response = CompletableDeferred<List<WorkspaceMembership>>()
            auth.membershipsAction = { response.await() }
            model.retry(empty.generation)
            runCurrent()
            model.openWorkspaceSetup(empty.generation) { false }
            assertTrue(model.uiState.value.checkingWorkspace)
            assertEquals(SessionEntryFailure.Browser, model.uiState.value.entryFailure)

            auth.state.value = auth.state.value.copy(membershipAccess = emptyList())
            runCurrent()
            assertTrue(model.uiState.value.checkingWorkspace)
            assertEquals(SessionEntryFailure.Browser, model.uiState.value.entryFailure)

            response.complete(emptyList())
            runCurrent()
            val recovered = model.uiState.value
            assertEquals(SessionStage.ChooseWorkspace, recovered.stage)
            assertTrue(recovered.memberships.isEmpty())
            assertFalse(recovered.checkingWorkspace)
            assertEquals(SessionEntryFailure.Browser, recovered.entryFailure)
        }
    }

    @Test
    fun clerkMembershipFailuresHonorRetryAfterAndPublishOnlyAConfirmedResult() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        val request =
            Request.Builder()
                .url("https://clerk.example.test/v1/me/organization_memberships")
                .build()
        fun rejected(status: Int, header: String): List<WorkspaceMembership> {
            val response =
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(status)
                    .message("Fixture rejection")
                    .header("Retry-After", header)
                    .build()
            val result: ClerkResult<List<WorkspaceMembership>, Unit> =
                ClerkResult.httpFailure<Unit>(status).withTags(mapOf(Response::class to response))
            return result.required()
        }
        var attempts = 0
        auth.membershipsAction = {
            when (++attempts) {
                1 -> rejected(429, "1")
                2 -> rejected(503, "-1")
                3 -> throw ApiFailure.Http(503, null, null, null)
                else -> auth.available
            }
        }
        check(auth) { model, _ ->
            model.foregroundChanged(true)
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            advanceTimeBy(999)
            runCurrent()
            assertEquals(1, attempts)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(2, attempts)
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            advanceTimeBy(2_999)
            runCurrent()
            assertEquals(2, attempts)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(3, attempts)
            assertEquals(SessionStage.Unavailable, model.uiState.value.stage)
            assertTrue(model.uiState.value.entryReadFailed)
            advanceTimeBy(5_999)
            runCurrent()
            assertEquals(3, attempts)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(4, attempts)
            assertEquals(SessionStage.ChooseWorkspace, model.uiState.value.stage)
            assertEquals(auth.available, model.uiState.value.memberships)
            assertFalse(model.uiState.value.entryReadFailed)
        }
    }

    @Test
    fun initialMembershipRetrySurvivesRejectedSignOutAndWaitsForForeground() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        val signOutResult = CompletableDeferred<Unit>()
        var attempts = 0
        auth.membershipsAction = {
            if (++attempts <= 3) throw ApiFailure.Http(503, null, null, null)
            auth.available
        }
        auth.signOutAction = { signOutResult.await() }
        check(auth) { model, _ ->
            model.foregroundChanged(true)
            runCurrent()
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(3, attempts)
            val failure = model.uiState.value
            assertTrue(failure.entryReadFailed)

            model.signOut(failure.generation)
            runCurrent()
            assertTrue(model.uiState.value.signingOut)
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(3, attempts)

            model.foregroundChanged(false)
            signOutResult.completeExceptionally(IllegalStateException("sign-out rejected"))
            runCurrent()
            val recovered = model.uiState.value
            assertEquals(SessionStage.Unavailable, recovered.stage)
            assertTrue(recovered.entryReadFailed)
            assertFalse(recovered.signingOut)
            assertEquals(SessionEntryFailure.SignOut, recovered.entryFailure)
            assertEquals(3, attempts)

            model.foregroundChanged(true)
            runCurrent()
            assertEquals(4, attempts)
            assertEquals(SessionStage.ChooseWorkspace, model.uiState.value.stage)
            assertEquals(auth.available, model.uiState.value.memberships)
            assertEquals(SessionEntryFailure.SignOut, model.uiState.value.entryFailure)
        }
    }

    @Test
    fun confirmedSignOutCancelsTheScheduledInitialMembershipRetry() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        var attempts = 0
        auth.membershipsAction = {
            attempts++
            throw ApiFailure.Http(503, null, null, null)
        }
        check(auth) { model, _ ->
            model.foregroundChanged(true)
            runCurrent()
            advanceTimeBy(6_000)
            runCurrent()
            assertEquals(3, attempts)
            val failure = model.uiState.value
            assertTrue(failure.entryReadFailed)

            model.signOut(failure.generation)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
            advanceTimeBy(48_000)
            runCurrent()
            assertEquals(3, attempts)
        }
    }

    @Test
    fun failedPreparationAfterClerkConfirmsSelectionRestoresThePicker() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        val allowFirstRead = CompletableDeferred<Unit>()
        var failRead = true
        var selections = 0
        auth.selectAction = { _, _ -> selections++ }
        check(
            auth,
            configure = { resource ->
                resource.verifyOrganization = {
                    allowFirstRead.await()
                    if (failRead) throw ApiFailure.Http(503, null, null, null)
                    testOrganization(resource.identity.workspaceId)
                }
            },
        ) { model, resources ->
            runCurrent()
            val picker = model.uiState.value
            model.chooseWorkspace("org-a", picker.generation)
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            auth.state.value = testAuthenticationState(workspace = "org-a")
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertNull(model.uiState.value.opening)

            allowFirstRead.complete(Unit)
            runCurrent()
            val recovered = model.uiState.value
            assertEquals(SessionStage.ChooseWorkspace, recovered.stage)
            assertEquals(picker.memberships, recovered.memberships)
            assertEquals(SessionEntryFailure.Selection, recovered.entryFailure)
            assertTrue(resources.single().closed)

            failRead = false
            model.chooseWorkspace("org-a", recovered.generation)
            runCurrent()
            assertEquals("org-a", model.uiState.value.ready?.identity?.workspaceId)
            assertEquals(1, selections)
        }
    }

    @Test
    fun failedFirstSelectionAndSignOutRestoreTheSameWorkspacePicker() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        check(auth) { model, _ ->
            runCurrent()
            val picker = model.uiState.value
            auth.selectAction = { _, _ -> error("selection rejected") }
            model.chooseWorkspace(picker.memberships.first().id, picker.generation)
            runCurrent()
            val afterSelection = model.uiState.value
            assertEquals(SessionStage.ChooseWorkspace, afterSelection.stage)
            assertEquals(picker.memberships, afterSelection.memberships)
            assertEquals(SessionEntryFailure.Selection, afterSelection.entryFailure)
            auth.signOutAction = { error("sign-out rejected") }
            model.signOut(afterSelection.generation)
            runCurrent()
            val afterSignOut = model.uiState.value
            assertEquals(SessionStage.ChooseWorkspace, afterSignOut.stage)
            assertEquals(picker.memberships, afterSignOut.memberships)
            assertEquals(SessionEntryFailure.SignOut, afterSignOut.entryFailure)
        }
    }

    @Test
    fun firstSelectionRecoversItsPickerAfterMembershipUpdatesForTheSameSession() {
        val auth = TestAuthentication(testAuthenticationState(workspace = null))
        val activation = CompletableDeferred<Unit>()
        auth.selectAction = { _, _ -> activation.await() }
        check(auth) { model, _ ->
            runCurrent()
            val picker = model.uiState.value
            model.chooseWorkspace(picker.memberships.first().id, picker.generation)
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)

            val access = MembershipAccess("org-a", "org:member", null)
            auth.state.value = auth.state.value.copy(membershipAccess = listOf(access))
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)

            activation.completeExceptionally(IllegalStateException("selection rejected"))
            auth.state.value =
                auth.state.value.copy(
                    membershipAccess = listOf(access.copy(permissions = emptyList())),
                )
            runCurrent()
            val recovered = model.uiState.value
            assertEquals(SessionStage.ChooseWorkspace, recovered.stage)
            assertEquals(picker.memberships, recovered.memberships)
            assertEquals(SessionEntryFailure.Selection, recovered.entryFailure)
        }
    }
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class SessionModelTest : SessionModelTestFixture() {
    @Test
    fun organizationGatesAccessAndTokenRenewalKeepsThePresentationOwner() {
        val auth = TestAuthentication()
        val gate = CompletableDeferred<Unit>()
        check(
            auth,
            configure = { resource ->
                resource.verifyOrganization = {
                    gate.await()
                    testOrganization()
                }
            },
        ) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertTrue(model.uiState.value.opening is OpeningWorkspace.CheckingAccess)
            assertNull(model.uiState.value.ready)
            gate.complete(Unit)
            runCurrent()
            val ready = requireNotNull(model.uiState.value.ready)
            assertEquals("org-a", ready.identity.workspaceId)
            assertEquals("test-token", resources.single().tokens.token())
            auth.tokenAction = { "renewed-token" }
            assertEquals("renewed-token", resources.single().tokens.token())
            runCurrent()
            assertSame(ready, model.uiState.value.ready)
            assertFalse(resources.single().closed)
        }
    }

    @Test
    fun startupPreferencesRestorePerWorkspaceAndPersistOnlyConfirmedRegionAndBrowser() {
        val auth = TestAuthentication()
        val cached =
            CachedMemberPreferences(
                UserPreferencesTheme.DARK,
                UserPreferencesColorTheme.DAYDREAM,
                locale = UserPreferencesLocale.EN_US,
                timezone = "Asia/Shanghai",
                cloudBrowser = false,
            )
        val confirmed =
            CachedMemberPreferences(
                UserPreferencesTheme.LIGHT,
                UserPreferencesColorTheme.BERRY_BLUSH,
                locale = UserPreferencesLocale.EN_US,
                timezone = "UTC",
                cloudBrowser = true,
            )
        val previousSession = WorkspaceIdentity("https://api.okou.ai", "user-a", "old", "org-a")
        val otherWorkspace = cached.copy(timezone = "Europe/Berlin")
        var preferences = CompletableDeferred<Unit>()
        val write = CompletableDeferred<Unit>()
        var remote =
            testPreferences()
                .copy(
                    theme = confirmed.theme,
                    colorTheme = confirmed.colorTheme,
                    timezone = confirmed.timezone,
                    cloudBrowserEnabledByDefault = true,
                )
        lateinit var disk: MemberPreferencesCache
        check(
            auth,
            configure = { resource ->
                resource.loadPreferences = {
                    preferences.await()
                    remote
                }
                resource.update = { write.await() }
            },
            preparePreferences = {
                disk = this
                save(previousSession, cached)
                save(previousSession.copy(workspaceId = "org-b"), otherWorkspace)
            },
        ) { model, _ ->
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertEquals(cached, model.uiState.value.cachedPreferences)
            assertNull(model.uiState.value.ready)
            val opened = model.uiState.value.opening as OpeningWorkspace.Authorized

            preferences.complete(Unit)
            runCurrent()
            val ready = requireNotNull(model.uiState.value.ready)
            assertSame(opened.composer, ready.composer)
            assertEquals(confirmed.theme, ready.preferences.uiState.value.theme)
            assertEquals(confirmed.colorTheme, ready.preferences.uiState.value.colorTheme)
            assertEquals(confirmed, disk.load(ready.identity))

            remote = remote.copy(cloudBrowserEnabledByDefault = false)
            ready.preferences.setCloudBrowser(false)
            runCurrent()
            assertFalse(ready.preferences.uiState.value.cloudBrowser)
            assertEquals(confirmed, disk.load(ready.identity))
            write.complete(Unit)
            runCurrent()
            assertEquals(confirmed.copy(cloudBrowser = false), disk.load(ready.identity))

            preferences = CompletableDeferred()
            model.chooseWorkspace("org-b", model.uiState.value.generation)
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertEquals(otherWorkspace, model.uiState.value.cachedPreferences)

            auth.state.value = testAuthenticationState("user-b", "session-b", "org-a")
            runCurrent()
            assertEquals(SessionStage.LoadingWorkspace, model.uiState.value.stage)
            assertNull(model.uiState.value.cachedPreferences)
        }
    }

    @Test
    fun accountReplacementRejectsEvenNonCooperativeLatePreferences() {
        val old = CompletableDeferred<Unit>()
        val auth = TestAuthentication()
        check(
            auth,
            configure = { resource ->
                if (resource.identity.userId == "user-a")
                    resource.loadPreferences = {
                        withContext(NonCancellable) { old.await() }
                        testPreferences()
                    }
            },
        ) { model, resources ->
            runCurrent()
            assertTrue(model.uiState.value.opening is OpeningWorkspace.Authorized)
            auth.state.value = testAuthenticationState("user-b", "session-b", "org-b")
            runCurrent()
            assertTrue(resources.first().closed)
            assertEquals("user-b", requireNotNull(model.uiState.value.ready).identity.userId)
            old.complete(Unit)
            runCurrent()
            assertEquals("org-b", requireNotNull(model.uiState.value.ready).identity.workspaceId)
        }
    }

    @Test
    fun workspaceSwitchKeepsTheAuthorizedOriginOnFailureAndReplacesItOnRetry() {
        val auth = TestAuthentication()
        val activate = auth.selectAction
        val reject = CompletableDeferred<Unit>()
        var attempts = 0
        auth.selectAction = { _, _ ->
            attempts++
            reject.await()
            error("Selection failed")
        }
        check(auth) { model, resources ->
            runCurrent()
            val original = requireNotNull(model.uiState.value.ready)
            val generation = model.uiState.value.generation
            model.chooseWorkspace("org-b", generation)
            model.chooseWorkspace("org-b", generation)
            runCurrent()
            assertEquals(1, attempts)
            assertSame(original, model.uiState.value.ready)
            assertFalse(resources.first().closed)
            assertEquals(WorkspaceSwitch("org-b"), model.uiState.value.workspaceSwitch)

            reject.complete(Unit)
            runCurrent()
            assertSame(original, model.uiState.value.ready)
            assertFalse(resources.first().closed)
            assertEquals(
                WorkspaceSwitch("org-b", failed = true),
                model.uiState.value.workspaceSwitch,
            )

            auth.selectAction = activate
            model.chooseWorkspace("org-b", generation)
            runCurrent()
            assertEquals("org-b", model.uiState.value.ready?.identity?.workspaceId)
            assertTrue(resources.first().closed)
            assertNull(model.uiState.value.workspaceSwitch)
        }
    }

    @Test
    fun lateTokenCannotEscapeAReplacedWorkspaceAndItsFilterRestoresOnlyOnReturn() {
        val auth = TestAuthentication()
        val token = CompletableDeferred<String>()
        check(auth) { model, resources ->
            runCurrent()
            val original = requireNotNull(model.uiState.value.ready)
            original.chats.selectFilter(ai.okou.android.chat.ChatListFilter.Muted)
            auth.tokenAction = { withContext(NonCancellable) { token.await() } }
            val request = async { runCatching { resources.first().tokens.token() } }
            runCurrent()
            model.chooseWorkspace("not-a-membership", model.uiState.value.generation)
            assertSame(original, model.uiState.value.ready)
            model.chooseWorkspace("org-b", model.uiState.value.generation)
            runCurrent()
            assertTrue(resources.first().closed)
            val next = requireNotNull(model.uiState.value.ready)
            assertNotSame(original.chats, next.chats)
            assertEquals(ai.okou.android.chat.ChatListFilter.Inbox, next.chats.uiState.value.filter)
            token.complete("old-token")
            runCurrent()
            assertTrue(request.await().exceptionOrNull() is CancellationException)
            model.chooseWorkspace("org-a", model.uiState.value.generation)
            runCurrent()
            val restored = requireNotNull(model.uiState.value.ready)
            assertEquals("org-a", restored.identity.workspaceId)
            assertNotSame(original.chats, restored.chats)
            assertEquals(
                ai.okou.android.chat.ChatListFilter.Muted,
                restored.chats.uiState.value.filter,
            )
        }
    }

    @Test
    fun additionalAuthenticationOrRevokedMembershipRetiresAccess() {
        val auth = TestAuthentication()
        check(auth) { model, resources ->
            runCurrent()
            auth.state.value = auth.state.value.copy(complete = false)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
            assertNull(model.uiState.value.ready)
            assertTrue(resources.single().closed)
            auth.available = emptyList()
            auth.state.value = auth.state.value.copy(complete = true)
            runCurrent()
            assertEquals(SessionStage.ChooseWorkspace, model.uiState.value.stage)
            assertTrue(model.uiState.value.memberships.isEmpty())
            assertEquals(1, resources.size)
        }
    }

    @Test
    fun selectedWorkspaceKeepsItsCachedLogoUntilTheMembershipListIsConfirmed() {
        val cachedA =
            WorkspaceMembership("org-a", "Workspace A", "org:member", "https://images.test/old.png")
        val cachedB =
            WorkspaceMembership("org-b", "Workspace B", "org:member", "https://images.test/b.png")
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(cachedA, cachedB).map {
                                MembershipAccess(it.id, it.role, emptyList())
                            },
                    ),
            )
        auth.cachedMembership = { session ->
            listOf(cachedA, cachedB).firstOrNull { it.id == session.workspaceId }
        }
        val confirmed = listOf(cachedA.copy(uploadedImageUrl = null), cachedB)
        var memberships = CompletableDeferred<List<WorkspaceMembership>>()
        auth.membershipsAction = { memberships.await() }
        check(auth) { model, _ ->
            runCurrent()
            val first = requireNotNull(model.uiState.value.ready)
            assertEquals(cachedA.id, first.identity.workspaceId)
            assertEquals(listOf(cachedA), model.uiState.value.memberships)
            memberships.complete(confirmed)
            runCurrent()
            assertSame(first, model.uiState.value.ready)
            assertEquals(confirmed, model.uiState.value.memberships)

            memberships = CompletableDeferred()
            model.chooseWorkspace(cachedB.id, model.uiState.value.generation)
            runCurrent()
            assertEquals(cachedB.id, model.uiState.value.ready?.identity?.workspaceId)
            assertEquals(listOf(cachedB), model.uiState.value.memberships)
            memberships.complete(confirmed)
            runCurrent()
            assertEquals(confirmed, model.uiState.value.memberships)
        }
    }

    @Test
    fun refreshedSelectedPermissionsOpenWorkspaceWhileThePickerReadIsHeld() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", listOf("old"))),
                    ),
            )
        auth.refreshedMembership = { MembershipAccess("org-a", "org:member", emptyList()) }
        val verification = CompletableDeferred<Unit>()
        var refreshResponse = verification
        auth.refreshAction = { refreshResponse.await() }
        val memberships = CompletableDeferred<List<WorkspaceMembership>>()
        auth.membershipsAction = { memberships.await() }
        check(auth) { model, resources ->
            runCurrent()
            assertTrue(model.uiState.value.opening is OpeningWorkspace.Cached)
            val cachedOwner = resources.single()
            refreshResponse = CompletableDeferred()
            verification.complete(Unit)
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            assertTrue(cachedOwner.closed)
            assertEquals(
                scopeHash(listOf("org:member", "org:member", "known")),
                resources.last().identity.authorizationScope,
            )
            assertEquals(listOf("org-a"), model.uiState.value.memberships.map { it.id })
            memberships.complete(auth.available)
            runCurrent()
            assertEquals(auth.available, model.uiState.value.memberships)
        }
    }

    @Test
    fun removedSelectedMembershipReturnsToThePickerWhileFurtherRefreshIsHeld() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", emptyList())),
                    ),
            )
        auth.refreshedMembership = { null }
        auth.available = auth.available.filter { it.id != "org-a" }
        val verification = CompletableDeferred<Unit>()
        var refreshResponse = verification
        auth.refreshAction = { refreshResponse.await() }
        check(auth) { model, resources ->
            runCurrent()
            assertTrue(model.uiState.value.opening is OpeningWorkspace.Cached)
            val cachedOwner = resources.single()

            refreshResponse = CompletableDeferred()
            verification.complete(Unit)
            runCurrent()

            assertTrue(cachedOwner.closed)
            val state = model.uiState.value
            assertEquals(SessionStage.ChooseWorkspace, state.stage)
            assertNull(state.opening)
            assertEquals(auth.available, state.memberships)
        }
    }

    @Test
    fun membershipRevocationWithoutAnIdentityChangeRechecksAndClosesAccess() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", emptyList())),
                    ),
            )
        check(auth) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            auth.available = emptyList()
            auth.state.value = auth.state.value.copy(membershipAccess = emptyList())
            runCurrent()
            assertTrue(resources.single().closed)
            assertEquals(SessionStage.ChooseWorkspace, model.uiState.value.stage)
            assertNull(model.uiState.value.ready)
        }
    }

    @Test
    fun oldRenderedActionsCannotSwitchOrSignOutAReplacementAccount() {
        val auth = TestAuthentication()
        check(auth) { model, resources ->
            runCurrent()
            val original = model.uiState.value
            auth.state.value = testAuthenticationState("user-b", "session-b", "org-b")
            original.ready?.preferences?.selectColorTheme(UserPreferencesColorTheme.COTTON_SKY)
            // SDK state may advance before the ViewModel or Compose consumes the new snapshot.
            model.chooseWorkspace("org-a", original.generation)
            model.signOut(original.generation)
            model.retry(original.generation)
            assertSame(original, model.uiState.value)
            runCurrent()
            val replacement = model.uiState.value
            assertEquals("user-b", requireNotNull(replacement.ready).identity.userId)
            model.chooseWorkspace("org-a", original.generation)
            model.signOut(original.generation)
            model.retry(original.generation)
            runCurrent()
            assertSame(replacement, model.uiState.value)
            assertFalse(resources.last().closed)
        }
    }

    @Test
    fun concurrentRejectionsUseTheSameRenewedWorkspaceCredential() {
        val release = CompletableDeferred<Unit>()
        val auth = TestAuthentication()
        var credential = "rejected"
        var renewals = 0
        auth.tokenAction = { credential }
        auth.renewTokenAction = {
            renewals++
            release.await()
            credential = "renewed"
            credential
        }
        check(auth) { model, resources ->
            runCurrent()
            val ready = model.uiState.value.ready
            val provider = resources.single().tokens
            val first = async { provider.renew("rejected") }
            val second = async { provider.renew("rejected") }
            runCurrent()
            assertEquals(1, renewals)
            assertSame(ready, model.uiState.value.ready)
            release.complete(Unit)
            assertEquals("renewed", first.await())
            assertEquals("renewed", second.await())
            assertEquals(1, renewals)
            assertFalse(resources.single().closed)
        }
    }

    @Test
    fun postBootstrapAuthorizationAndUpgradeErrorsRetireTheWorkspace() {
        for ((failure, stage) in
            listOf(
                ApiFailure.Unauthenticated() to SessionStage.AccessRemoved,
                ApiFailure.Http(401, null, null, null) to SessionStage.Unavailable,
                ApiFailure.UpdateRequired(RequiredUpdate("0.3.0")) to SessionStage.UpdateRequired,
            )) {
            check(configure = { resource -> resource.update = { throw failure } }) {
                model,
                resources ->
                runCurrent()
                val ready = requireNotNull(model.uiState.value.ready)
                ready.preferences.selectColorTheme(UserPreferencesColorTheme.BLUE_HORIZON)
                runCurrent()
                assertEquals(stage, model.uiState.value.stage)
                assertNull(model.uiState.value.ready)
                assertTrue(resources.single().closed)
            }
        }
    }

    @Test
    fun temporaryPreparationFailuresRetryWithTheSameOwnerWhileTheAppIsActive() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", emptyList())),
                    ),
            )
        var organizations = 0
        var preferences = 0
        check(
            auth,
            configure = { resource ->
                resource.verifyOrganization = {
                    if (++organizations == 1) throw ApiFailure.Http(503, null, null, 1)
                    testOrganization(resource.identity.workspaceId)
                }
                resource.loadPreferences = {
                    if (++preferences == 1) throw ApiFailure.Http(503, null, null, null)
                    testPreferences()
                }
            },
        ) { model, resources ->
            model.foregroundChanged(true)
            runCurrent()
            val opened = model.uiState.value.opening as OpeningWorkspace.Authorized
            assertEquals(SessionStage.Unavailable, model.uiState.value.stage)
            assertTrue(model.uiState.value.working)
            assertEquals(1, organizations)
            assertEquals(0, preferences)

            advanceTimeBy(999)
            runCurrent()
            assertEquals(1, organizations)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(2, organizations)
            assertEquals(1, preferences)

            model.foregroundChanged(false)
            runCurrent()
            advanceTimeBy(10_000)
            runCurrent()
            assertEquals(1, preferences)

            model.foregroundChanged(true)
            runCurrent()
            val ready = requireNotNull(model.uiState.value.ready)
            assertSame(opened.chats, ready.chats)
            assertEquals(2, organizations)
            assertEquals(2, preferences)
            assertFalse(resources.single().closed)
        }
    }

    @Test
    fun failedOrganizationCheckCanRetryAndSignOutRetiresAfterClerkPublishes() {
        val auth = TestAuthentication()
        val signOut = CompletableDeferred<Unit>()
        var fail = true
        check(
            auth,
            configure = { resource ->
                resource.verifyOrganization = {
                    if (fail) error("offline")
                    testOrganization(resource.identity.workspaceId)
                }
            },
        ) { model, resources ->
            runCurrent()
            assertEquals(SessionStage.Unavailable, model.uiState.value.stage)
            assertTrue(resources.first().closed)
            fail = false
            model.retry(model.uiState.value.generation)
            runCurrent()
            assertEquals(SessionStage.Ready, model.uiState.value.stage)
            auth.signOutAction = { signOut.await() }
            model.signOut(model.uiState.value.generation)
            assertTrue(model.uiState.value.signingOut)
            assertFalse(resources.last().closed)
            signOut.complete(Unit)
            runCurrent()
            assertTrue(model.uiState.value.signingOut)
            assertFalse(resources.last().closed)
            auth.state.value = AuthenticationState(initialized = true)
            runCurrent()
            assertTrue(resources.last().closed)
            assertNull(model.uiState.value.ready)
            assertFalse(model.uiState.value.signingOut)
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
        }
    }

    @Test
    fun signOutFailureKeepsTheCachedOwnerAndItsPendingVerification() {
        val auth =
            TestAuthentication(
                testAuthenticationState()
                    .copy(
                        membershipAccess =
                            listOf(MembershipAccess("org-a", "org:member", emptyList())),
                    ),
            )
        val verification = CompletableDeferred<Unit>()
        auth.refreshAction = { verification.await() }
        val reply = CompletableDeferred<Unit>()
        auth.signOutAction = {
            reply.await()
            error("sign-out rejected")
        }
        check(auth) { model, resources ->
            runCurrent()
            val original = model.uiState.value
            val cached = original.opening as OpeningWorkspace.Cached
            model.signOut(original.generation)
            runCurrent()
            assertTrue(model.uiState.value.signingOut)

            reply.complete(Unit)
            runCurrent()
            assertEquals(
                original.copy(entryFailure = SessionEntryFailure.SignOut),
                model.uiState.value,
            )
            assertFalse(resources.single().closed)

            verification.complete(Unit)
            runCurrent()
            assertSame(cached.chats, model.uiState.value.ready?.chats)
        }
    }

    @Test
    fun signOutFailureKeepsTheAuthorizedOwnerAndAllowsAnExplicitRetry() {
        val auth = TestAuthentication()
        val reply = CompletableDeferred<Unit>()
        var calls = 0
        auth.signOutAction = {
            calls++
            reply.await()
            error("sign-out rejected")
        }
        check(auth) { model, resources ->
            runCurrent()
            val original = model.uiState.value
            model.signOut(original.generation)
            model.signOut(original.generation)
            model.chooseWorkspace("org-b", original.generation)
            model.retry(original.generation)
            runCurrent()
            assertEquals(1, calls)
            assertTrue(model.uiState.value.signingOut)
            assertSame(original.ready, model.uiState.value.ready)

            reply.complete(Unit)
            runCurrent()
            assertEquals(
                original.copy(entryFailure = SessionEntryFailure.SignOut),
                model.uiState.value,
            )
            assertFalse(resources.single().closed)

            auth.signOutAction = {
                calls++
                auth.state.value = AuthenticationState(initialized = true)
            }
            model.signOut(original.generation)
            runCurrent()
            assertEquals(2, calls)
            assertTrue(resources.single().closed)
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
        }
    }

    @Test
    fun workspaceAccessLossRetiresContentWhileSignOutKeepsWaitingForClerk() {
        val auth = TestAuthentication()
        val preferences = CompletableDeferred<Unit>()
        val signOut = CompletableDeferred<Unit>()
        var signOutRequests = 0
        auth.signOutAction = {
            signOutRequests++
            signOut.await()
            auth.state.value = AuthenticationState(initialized = true)
        }
        check(
            auth,
            configure = { resource ->
                resource.update = {
                    preferences.await()
                    throw ApiFailure.Unauthenticated()
                }
            },
        ) { model, resources ->
            runCurrent()
            val original = model.uiState.value
            requireNotNull(original.ready)
                .preferences
                .selectColorTheme(UserPreferencesColorTheme.BLUE_HORIZON)
            runCurrent()
            model.signOut(original.generation)
            runCurrent()
            assertTrue(model.uiState.value.signingOut)

            preferences.complete(Unit)
            runCurrent()
            val removed = model.uiState.value
            assertTrue(resources.single().closed)
            assertEquals(SessionStage.AccessRemoved, removed.stage)
            assertNull(removed.ready)
            assertTrue(removed.signingOut)
            model.signOut(removed.generation)
            runCurrent()
            assertEquals(1, signOutRequests)

            signOut.complete(Unit)
            runCurrent()
            assertEquals(SessionStage.SignIn, model.uiState.value.stage)
            assertFalse(model.uiState.value.signingOut)
        }
    }

    @Test
    fun signOutFailureAfterPermissionsChangeKeepsTheRevalidatedWorkspace() {
        val auth = TestAuthentication()
        val signOut = CompletableDeferred<Unit>()
        auth.signOutAction = {
            signOut.await()
            error("sign-out rejected")
        }
        check(auth) { model, resources ->
            runCurrent()
            val original = model.uiState.value
            model.signOut(original.generation)
            runCurrent()

            auth.state.value =
                auth.state.value.copy(
                    membershipAccess = listOf(MembershipAccess("org-a", "org:member", emptyList())),
                )
            runCurrent()
            val revalidated = model.uiState.value
            assertEquals(SessionStage.Ready, revalidated.stage)
            assertTrue(resources.first().closed)
            assertFalse(resources.last().closed)
            assertTrue(revalidated.signingOut)
            assertNotEquals(original.ready?.identity, revalidated.ready?.identity)

            signOut.complete(Unit)
            runCurrent()
            assertEquals(
                revalidated.copy(signingOut = false, entryFailure = SessionEntryFailure.SignOut),
                model.uiState.value,
            )
        }
    }

    @Test
    fun signOutFailureAfterAccountReplacementCannotRestoreTheOldWorkspace() {
        val auth = TestAuthentication()
        val reply = CompletableDeferred<Unit>()
        auth.signOutAction = {
            withContext(NonCancellable) { reply.await() }
            error("sign-out rejected")
        }
        check(auth) { model, resources ->
            runCurrent()
            val original = model.uiState.value
            try {
                model.signOut(original.generation)
                runCurrent()
                auth.state.value = testAuthenticationState("user-b", "session-b", "org-b")
                runCurrent()
                val replacement = model.uiState.value
                assertTrue(resources.first().closed)
                assertEquals("user-b", replacement.ready?.identity?.userId)
                assertFalse(replacement.signingOut)

                reply.complete(Unit)
                runCurrent()
                assertSame(replacement, model.uiState.value)
                assertFalse(resources.last().closed)
            } finally {
                reply.complete(Unit)
            }
        }
    }
}
