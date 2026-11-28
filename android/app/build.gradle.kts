import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.room)
    alias(libs.plugins.sentry.android)
}

sentry {
    ignoredBuildTypes.set(setOf("debug"))
    autoUploadProguardMapping.set(false)
    autoInstallation.enabled.set(false)
    includeDependenciesReport.set(false)
    runtimeOptimizations.enabled.set(false)
    tracingInstrumentation.enabled.set(false)
    telemetry.set(false)
}

val appVersion = rootProject.file("version.txt").readText().trim()
val screenshotScenarioDir = providers.gradleProperty("okou.screenshotScenarioDir").orNull
val debugUnitTestForks = providers.gradleProperty("okou.debugUnitTestForks").map(String::toInt)
val debugUnitTestShardIndex =
    providers.gradleProperty("okou.debugUnitTestShardIndex").map(String::toInt)
val debugUnitTestShardCount =
    providers.gradleProperty("okou.debugUnitTestShardCount").map(String::toInt)
val apiOrigin = providers.gradleProperty("okou.apiOrigin").getOrElse("https://api.okou.ai")
val webOrigin = providers.gradleProperty("okou.webOrigin").getOrElse("https://app.okou.ai")
val clerkPublishableKey =
    providers.gradleProperty("okou.clerkPublishableKey").getOrElse("pk_live_Y2xlcmsub2tvdS5haSQ")
val sentryDsn = providers.environmentVariable("SENTRY_DSN_ANDROID").getOrElse("")

require(sentryDsn.matches(Regex("(https://[A-Za-z0-9]+@[A-Za-z0-9.-]+/[0-9]+)?"))) {
    "SENTRY_DSN_ANDROID must be a public HTTPS Sentry DSN"
}

for (origin in listOf(apiOrigin, webOrigin)) {
    val uri = URI(origin)
    require(
        uri.scheme == "https" &&
            uri.host != null &&
            uri.userInfo == null &&
            uri.path in listOf("", "/") &&
            uri.query == null &&
            uri.fragment == null,
    ) {
        "Okou service configuration must use HTTPS origins"
    }
}

require(Regex("pk_(live|test)_[A-Za-z0-9_-]+").matches(clerkPublishableKey)) {
    "okou.clerkPublishableKey must be a public Clerk publishable key"
}

require(appVersion.length <= 64 && Regex("[0-9]+\\.[0-9]+\\.[0-9]+").matches(appVersion)) {
    "Android version.txt must contain a stable x.y.z version"
}

val appVersionCode =
    providers
        .exec {
            workingDir(rootProject.projectDir)
            commandLine("bash", "scripts/version-code.sh")
        }
        .standardOutput
        .asText
        .map { it.trim().toInt() }

android {
    namespace = "ai.okou.android"
    compileSdk = 37
    compileSdkMinor = 2
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "ai.okou.android"
        minSdk = 24
        targetSdk = 37
        versionName = appVersion
        testInstrumentationRunner = "ai.okou.android.OkouTestRunner"
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
        // Public client configuration, matching iOS; secret keys never belong in an APK.
        buildConfigField("String", "API_ORIGIN", "\"$apiOrigin\"")
        buildConfigField("String", "WEB_ORIGIN", "\"$webOrigin\"")
        buildConfigField("String", "CLERK_PUBLISHABLE_KEY", "\"$clerkPublishableKey\"")
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField("String", "SENTRY_DSN", "\"\"")
        }
        release {
            optimization { enable = true }
            buildConfigField("String", "SENTRY_DSN", "\"$sentryDsn\"")
        }
    }
    testBuildType = "debug"
    buildFeatures {
        compose = true
        buildConfig = true
    }
    sourceSets["test"].kotlin.directories.add("src/sharedTest/kotlin")
    sourceSets["test"]
        .resources
        .directories
        .add("../../turbo/packages/api-contracts/src/validators/fixtures")
    sourceSets["androidTest"].kotlin.directories.add("src/sharedTest/kotlin")
    screenshotScenarioDir?.let { value ->
        val directory = file(value).canonicalFile
        val allowed = rootProject.file("screenshots").canonicalFile.toPath()
        require(directory.toPath().startsWith(allowed) && directory.toPath() != allowed) {
            "Screenshot scenario must be inside android/screenshots/"
        }
        require(directory.resolve("src").isDirectory) { "Screenshot scenario has no src directory" }
        sourceSets["androidTest"].kotlin.directories.add(directory.resolve("src").absolutePath)
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint {
        warningsAsErrors = true
        // Upstream releases can change version suggestions without a source change.
        informational += "NewerVersionAvailable"
        informational += "GradleDependency"
        informational += "AndroidGradlePluginVersion"
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
        animationsDisabled = true
        managedDevices {
            localDevices.create("pixel2Api35") {
                device = "Pixel 2"
                apiLevel = 35
                systemImageSource = "aosp"
                require64Bit = true
            }
        }
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

tasks.withType<Test>().configureEach {
    if (name == "testDebugUnitTest") {
        maxParallelForks = debugUnitTestForks.getOrElse(1)
        val shardIndex = debugUnitTestShardIndex.orNull
        val shardCount = debugUnitTestShardCount.orNull
        if (shardIndex != null || shardCount != null) {
            require(shardIndex != null && shardCount != null && shardIndex in 0 until shardCount) {
                "Set okou.debugUnitTestShardIndex to a zero-based index within okou.debugUnitTestShardCount"
            }
            exclude { candidate ->
                val path = candidate.path
                // Keep test classes and their nested classes on the same shard.
                val className = path.removeSuffix(".class").substringBefore('$').replace('/', '.')
                !candidate.isDirectory &&
                    path.endsWith(".class") &&
                    Math.floorMod(className.hashCode(), shardCount) != shardIndex
            }
        }
    }
}

room { schemaDirectory("$projectDir/schemas") }

abstract class PrepareBrandFiles : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val sourceFiles: ConfigurableFileCollection

    @get:OutputDirectory abstract val outputDirectory: DirectoryProperty
    @get:Input abstract val fonts: Property<Boolean>
    @get:Inject abstract val fileSystem: FileSystemOperations

    @TaskAction
    fun prepare() {
        fileSystem.sync {
            from(sourceFiles)
            into(outputDirectory.dir(if (fonts.get()) "font" else "licenses"))
            rename { if (it == "Geist.ttf") "geist.ttf" else it }
        }
    }
}

val generateBrandFonts =
    tasks.register<PrepareBrandFiles>("generateBrandFonts") {
        sourceFiles.from("../../ios/Okou/Resources/Fonts/Geist.ttf")
        outputDirectory.set(layout.buildDirectory.dir("generated/brand/res"))
        fonts.set(true)
    }

val generateLicenseAssets =
    tasks.register<PrepareBrandFiles>("generateLicenseAssets") {
        sourceFiles.from(fileTree("../../ios/Okou/Resources/Fonts") { include("*-LICENSE.txt") })
        outputDirectory.set(layout.buildDirectory.dir("generated/brand/assets"))
        fonts.set(false)
    }

androidComponents.onVariants { variant ->
    variant.outputs.forEach { it.versionCode.set(appVersionCode) }
    // The shared publishing builder consumes this unsigned APK filename.
    if (variant.buildType == "release") {
        variant.outputs.single().outputFileName.set("app-release.apk")
    }
    variant.sources.res?.addGeneratedSourceDirectory(generateBrandFonts) { it.outputDirectory }
    variant.sources.assets?.addGeneratedSourceDirectory(generateLicenseAssets) {
        it.outputDirectory
    }
    val variantName = variant.name.replaceFirstChar { it.uppercaseChar() }
    val manifest =
        variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.MERGED_MANIFEST)
    val applicationId = variant.applicationId
    val audit =
        tasks.register<Exec>("check${variantName}AuthenticationManifest") {
            val script = project.file("../scripts/check-auth-manifest.py")
            inputs.file(script)
            inputs.file(manifest)
            commandLine("python3", script.absolutePath)
            argumentProviders.add(
                CommandLineArgumentProvider {
                    listOf(manifest.get().asFile.absolutePath, applicationId.get())
                },
            )
        }
    tasks.matching { it.name == "assemble$variantName" }.configureEach { dependsOn(audit) }
}

dependencies {
    implementation(libs.sentry.android.core)
    implementation(libs.appcompat)
    implementation(libs.browser)
    implementation(libs.clerk.ui)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.coil.svg)
    implementation(libs.zoomimage.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.foundation)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.coroutines.android)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    implementation(libs.commonmark)
    implementation(libs.commonmarkTables)
    implementation(libs.ably.device) {
        // This client owns foreground realtime only; FCM adds an unused public receiver/provider.
        exclude(group = "com.google.firebase", module = "firebase-messaging")
    }
    implementation(libs.room.runtime)
    implementation(libs.datastore.preferences.core)
    implementation(libs.sqlite.bundled)
    ksp(libs.room.compiler)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.okhttp.tls)
    testImplementation(libs.robolectric)
    // The same SQLite release with host-native libraries for Robolectric's JVM.
    testImplementation(libs.sqlite.host)
    testImplementation(libs.compose.ui.test)
    testImplementation(libs.lifecycle.runtime.testing)
    debugImplementation(libs.compose.ui.test.manifest)
    androidTestImplementation(libs.test.core.ktx)
    androidTestImplementation(libs.test.ext.junit)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.uiautomator)
    androidTestImplementation(libs.test.storage)
    if (screenshotScenarioDir != null) {
        androidTestImplementation(platform(libs.compose.bom))
        androidTestImplementation(libs.compose.ui.test)
    }
    androidTestImplementation(libs.mockwebserver)
    androidTestImplementation(libs.okhttp.tls)
    androidTestCompileOnly(libs.errorprone.annotations)
    androidTestCompileOnly(libs.animal.sniffer.annotations)
    androidTestUtil(libs.test.services)
}

tasks.register("printRetraceClasspath") {
    doLast {
        println(
            File(
                com.android.tools.r8.retrace.Retrace::class
                    .java
                    .protectionDomain
                    .codeSource
                    .location
                    .toURI(),
            ),
        )
    }
}
