package ai.okou.android.artifacts

import ai.okou.android.api.ApiClient
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ArtifactVisibility
import ai.okou.android.api.generated.ArtifactVisibilityUpdate
import ai.okou.android.api.generated.ArtifactVisibilityUpdateVisibility
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl

internal sealed interface ArtifactLinkSource {
    data class File(val id: String) : ArtifactLinkSource

    data class LegacyDeployment(val id: String) : ArtifactLinkSource

    data class Website(
        val address: HttpUrl,
        val siteId: String? = null,
        val version: Int? = null,
        val artifactId: String? = null,
    ) : ArtifactLinkSource
}

internal enum class ArtifactAudience {
    PRIVATE,
    ORGANIZATION,
    PUBLIC,
}

internal sealed interface ArtifactLinkVersion {
    data object CurrentSite : ArtifactLinkVersion

    data class Deployment(val number: Int?) : ArtifactLinkVersion
}

internal data class ArtifactLink(
    val address: HttpUrl,
    val audience: ArtifactAudience,
    val organization: String? = null,
    val version: ArtifactLinkVersion? = null,
    val canManage: Boolean = false,
    val siteId: String? = null,
    val artifactId: String? = null,
)

internal class ArtifactLinkAccess(private val api: ApiClient) {
    private class PolicyLock {
        val mutex = Mutex()
        var users = 0
    }

    private val policyLocks = mutableMapOf<String, PolicyLock>()

    suspend fun read(source: ArtifactLinkSource): ArtifactLink =
        when (source) {
            is ArtifactLinkSource.File ->
                withPolicy("file:${source.id}") {
                    api.read { artifactVisibility(it, source.id) }.fileLink()
                }
            is ArtifactLinkSource.LegacyDeployment -> legacyDeploymentLink(source.id)
            is ArtifactLinkSource.Website -> websiteLink(source)
        }

    suspend fun update(
        source: ArtifactLinkSource,
        confirmed: ArtifactLink,
        audience: ArtifactAudience,
    ): ArtifactLink =
        when (source) {
            is ArtifactLinkSource.File ->
                withPolicy("file:${source.id}") {
                    api.write {
                            updateArtifactVisibility(
                                it,
                                confirmed.artifactId ?: source.id,
                                ArtifactVisibilityUpdate(
                                    ArtifactVisibilityUpdateVisibility.valueOf(audience.name),
                                ),
                            )
                        }
                        .fileLink()
                }
            is ArtifactLinkSource.Website -> {
                val siteId = checkNotNull(confirmed.siteId)
                withPolicy("site:$siteId") {
                    val status = api.write {
                        updateArtifactVisibility(
                            it,
                            confirmed.artifactId ?: siteId,
                            ArtifactVisibilityUpdate(
                                ArtifactVisibilityUpdateVisibility.valueOf(audience.name),
                            ),
                        )
                    }
                    status.siteLink(
                        siteId,
                        confirmed.address,
                        confirmed.version,
                        confirmed.organization,
                    )
                }
            }
            is ArtifactLinkSource.LegacyDeployment -> error("Legacy deployments are read-only")
        }.also {
            if (it.audience != audience) throw ApiFailure.IncompatibleResponse()
        }

    // Catalog and chat can operate on the same policy. Wait for that policy's
    // in-flight operation without blocking requests for other artifacts.
    private suspend fun <T> withPolicy(key: String, operation: suspend () -> T): T {
        val lock =
            synchronized(policyLocks) {
                policyLocks.getOrPut(key, ::PolicyLock).also { it.users++ }
            }
        try {
            return lock.mutex.withLock { operation() }
        } finally {
            synchronized(policyLocks) {
                lock.users--
                if (lock.users == 0) policyLocks.remove(key)
            }
        }
    }

    private suspend fun websiteLink(source: ArtifactLinkSource.Website): ArtifactLink {
        val host = source.address.host
        val label = host.substringBefore('.')
        val deployment = legacyDeploymentHost.matchEntire(label)?.groupValues?.get(1)
        val version =
            if (deployment == null) ArtifactLinkVersion.CurrentSite
            else ArtifactLinkVersion.Deployment(source.version)
        val site =
            try {
                api.read { artifactSiteUrl(it, label, host) }
            } catch (error: ApiFailure.Http) {
                if (error.status != 404) throw error
                if (deployment != null && source.siteId != null) {
                    return legacyDeploymentLink(deployment)
                }
                if (source.siteId != null) throw error
                // A recipient can share the preview URL only when the server
                // confirmed the same public site address without an expiry.
                val preview = api.artifactSitePreview(label, host)
                if (preview.expiresAt != null || artifactHttpsUrl(preview.url) != source.address)
                    throw error
                return ArtifactLink(source.address, ArtifactAudience.PUBLIC, version = version)
            }
        if (source.siteId != null && site.siteId != source.siteId)
            throw ApiFailure.IncompatibleResponse()
        // An immutable deployment stays selected even when the site alias
        // points at a newer publication.
        val address =
            if (deployment != null) source.address
            else
                artifactHttpsUrl(site.effectiveUrl ?: site.url)
                    ?: throw ApiFailure.IncompatibleResponse()
        if (host.endsWith(".sites.vm7.io") || host.endsWith(".sites.vm0.io")) {
            // The owner lookup verifies that this is a published legacy site.
            return ArtifactLink(address, ArtifactAudience.PUBLIC, version = version)
        }
        return withPolicy("site:${site.siteId}") {
            val status = api.read { artifactVisibility(it, source.artifactId ?: site.siteId) }
            status.siteLink(site.siteId, address, version, api.organization().name)
        }
    }

    private suspend fun legacyDeploymentLink(id: String): ArtifactLink =
        api.read { artifactVisibility(it, id) }.legacyDeploymentLink()
}

private val legacyDeploymentHost =
    Regex("dpl-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})")

private fun ArtifactVisibility.fileLink(): ArtifactLink {
    val confirmed = ArtifactAudience.valueOf(visibility.name)
    val address =
        (if (confirmed == ArtifactAudience.PRIVATE) ownerUrl else shareUrl)?.let(::artifactHttpsUrl)
            ?: throw ApiFailure.IncompatibleResponse()
    return ArtifactLink(
        address,
        confirmed,
        organization.name,
        version = null,
        canManage = true,
        artifactId = artifactId,
    )
}

private fun ArtifactVisibility.legacyDeploymentLink(): ArtifactLink {
    val confirmed = ArtifactAudience.valueOf(visibility.name)
    val address =
        (if (confirmed == ArtifactAudience.PRIVATE) ownerUrl else shareUrl)?.let(::artifactHttpsUrl)
            ?: throw ApiFailure.IncompatibleResponse()
    return ArtifactLink(
        address,
        confirmed,
        organization.name,
        ArtifactLinkVersion.Deployment(deploymentVersion?.toInt()),
        canManage = false,
        artifactId = artifactId,
    )
}

private fun ArtifactVisibility.siteLink(
    siteId: String,
    address: HttpUrl,
    version: ArtifactLinkVersion?,
    workspace: String?,
): ArtifactLink =
    ArtifactLink(
        address,
        ArtifactAudience.valueOf(visibility.name),
        workspace ?: organization.name,
        version,
        canManage = true,
        siteId = siteId,
        artifactId = artifactId,
    )

internal enum class ArtifactLinkPhase {
    Idle,
    Loading,
    Ready,
    Saving,
    Verifying,
    Unavailable,
    ReadFailed,
    SaveFailed,
    VerificationFailed,
}

internal data class ArtifactLinkState(
    val phase: ArtifactLinkPhase = ArtifactLinkPhase.Idle,
    val confirmed: ArtifactLink? = null,
    val draft: ArtifactAudience? = null,
) {
    val busy: Boolean
        get() = phase == ArtifactLinkPhase.Saving || phase == ArtifactLinkPhase.Verifying

    val usable: ArtifactLink?
        get() = confirmed.takeIf {
            phase == ArtifactLinkPhase.Ready || phase == ArtifactLinkPhase.SaveFailed
        }

    val canEdit: Boolean
        get() = usable?.canManage == true

    val canSave: Boolean
        get() = canEdit && draft != null && draft != confirmed?.audience
}

internal class ArtifactLinkEditor(
    private val source: ArtifactLinkSource,
    private val access: ArtifactLinkAccess,
    private val scope: CoroutineScope,
    private val onSessionFailure: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(ArtifactLinkState())
    val state = mutable.asStateFlow()

    fun refresh() {
        val current = mutable.value
        if (current.busy || current.phase == ArtifactLinkPhase.Loading) return
        val verify = current.phase == ArtifactLinkPhase.VerificationFailed
        read(if (verify) current else ArtifactLinkState(), verify)
    }

    fun select(audience: ArtifactAudience) {
        val current = mutable.value
        if (current.canEdit) mutable.value = current.copy(draft = audience)
    }

    fun save() {
        val current = mutable.value
        val confirmed = current.usable ?: return
        val draft = current.draft ?: return
        if (!current.canSave) return
        mutable.value = current.copy(phase = ArtifactLinkPhase.Saving)
        scope.launch {
            try {
                val saved = access.update(source, confirmed, draft)
                mutable.value = ArtifactLinkState(ArtifactLinkPhase.Ready, saved, saved.audience)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                onSessionFailure(error)
                val status = (error as? ApiFailure.Http)?.status
                if (status == 400 || status == 402 || status == 429) {
                    mutable.value = current.copy(phase = ArtifactLinkPhase.SaveFailed)
                } else {
                    // The response might have been lost or another editor may
                    // have changed the policy. Never replay the write here.
                    read(current, verify = true)
                }
            }
        }
    }

    private fun read(previous: ArtifactLinkState, verify: Boolean) {
        mutable.value =
            previous.copy(
                phase = if (verify) ArtifactLinkPhase.Verifying else ArtifactLinkPhase.Loading,
            )
        scope.launch {
            try {
                val link = retryArtifactOperation { access.read(source) }
                val draft = previous.draft.takeIf { verify } ?: link.audience
                val phase =
                    if (verify && draft != link.audience) ArtifactLinkPhase.SaveFailed
                    else ArtifactLinkPhase.Ready
                mutable.value = ArtifactLinkState(phase, link, draft)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                onSessionFailure(error)
                val status = (error as? ApiFailure.Http)?.status
                mutable.value =
                    when {
                        status == 403 || status == 404 || status == 410 ->
                            previous.copy(phase = ArtifactLinkPhase.Unavailable, confirmed = null)
                        verify -> previous.copy(phase = ArtifactLinkPhase.VerificationFailed)
                        else -> ArtifactLinkState(ArtifactLinkPhase.ReadFailed)
                    }
            }
        }
    }
}
