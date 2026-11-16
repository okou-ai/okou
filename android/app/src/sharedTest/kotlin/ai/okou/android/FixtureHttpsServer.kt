package ai.okou.android

import java.io.Closeable
import java.security.KeyStore
import java.security.Provider
import java.security.Security
import javax.net.ssl.ManagerFactoryParameters
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.TrustManagerFactorySpi
import okhttp3.Protocol
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

/** Test-process TLS owner; the production APK keeps its normal HTTPS validation. */
class FixtureHttpsServer : Closeable {
    val server = MockWebServer()
    private val trust = FixtureTrust.acquire()

    init {
        try {
            // Preserve the existing HTTP/1 disconnect/recovery fixture semantics over TLS.
            server.protocols = listOf(Protocol.HTTP_1_1)
            val certificates =
                HandshakeCertificates.Builder().heldCertificate(FixtureTrust.certificate).build()
            server.useHttps(certificates.sslSocketFactory(), false)
        } catch (error: Throwable) {
            try {
                trust.close()
            } catch (cleanup: Throwable) {
                error.addSuppressed(cleanup)
            }
            throw error
        }
    }

    override fun close() {
        trust.use { server.close() }
    }
}

/** Platform trust plus this fixture's CA, scoped to live fixtures in the test process. */
private object FixtureTrust {
    val certificate =
        HeldCertificate.Builder()
            .commonName("Okou native HTTPS fixture")
            .addSubjectAlternativeName("localhost")
            .build()
    private val algorithm = TrustManagerFactory.getDefaultAlgorithm()
    private val platformProvider = TrustManagerFactory.getInstance(algorithm).provider
    private val manager =
        HandshakeCertificates.Builder()
            .addPlatformTrustedCertificates()
            .addTrustedCertificate(certificate.certificate)
            .build()
            .trustManager
    private val provider =
        object : Provider("OkouFixtureTLS", 1.0, "Native test HTTPS fixture trust") {
            init {
                putService(
                    object :
                        Service(
                            this,
                            "TrustManagerFactory",
                            algorithm,
                            TrustManagerFactorySpi::class.java.name,
                            emptyList(),
                            emptyMap(),
                        ) {
                        override fun newInstance(constructorParameter: Any?) =
                            object : TrustManagerFactorySpi() {
                                private var managers: Array<TrustManager>? = null

                                override fun engineInit(store: KeyStore?) {
                                    managers =
                                        if (store == null) arrayOf(manager)
                                        else
                                            TrustManagerFactory.getInstance(
                                                    algorithm,
                                                    platformProvider,
                                                )
                                                .also { it.init(store) }
                                                .trustManagers
                                }

                                override fun engineInit(parameters: ManagerFactoryParameters?) =
                                    error("Fixture trust does not use factory parameters")

                                override fun engineGetTrustManagers(): Array<TrustManager> =
                                    checkNotNull(managers).clone()
                            }
                    }
                )
            }
        }
    private var owners = 0

    @Synchronized
    fun acquire(): Closeable {
        if (owners == 0) check(Security.insertProviderAt(provider, 1) > 0)
        owners++
        var closed = false
        return Closeable {
            synchronized(this) {
                if (!closed) {
                    closed = true
                    owners--
                    if (owners == 0) Security.removeProvider(provider.name)
                }
            }
        }
    }
}
