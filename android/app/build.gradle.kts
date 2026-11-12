import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val appVersion = rootProject.file("version.txt").readText().trim()
val apiOrigin = providers.gradleProperty("okou.apiOrigin").getOrElse("https://api.okou.ai")
val webOrigin = providers.gradleProperty("okou.webOrigin").getOrElse("https://app.okou.ai")
val clerkPublishableKey =
    providers.gradleProperty("okou.clerkPublishableKey").getOrElse("pk_live_Y2xlcmsub2tvdS5haSQ")

for (origin in listOf(apiOrigin, webOrigin)) {
    val uri = URI(origin)
    require(
        uri.scheme == "https" &&
            uri.host != null &&
            uri.userInfo == null &&
            uri.path in listOf("", "/") &&
            uri.query == null &&
            uri.fragment == null
    ) {
        "Okou service configuration must use HTTPS origins"
    }
}

require(Regex("pk_(live|test)_[A-Za-z0-9_-]+").matches(clerkPublishableKey)) {
    "okou.clerkPublishableKey must be a public Clerk publishable key"
}

require(Regex("\\d+\\.\\d+\\.\\d+").matches(appVersion)) {
    "Android version.txt must contain a stable x.y.z version"
}

val versionParts = appVersion.split('.').map { it.toInt() }
val appVersionCode =
    versionParts[0].toLong() * 1_000_000 + versionParts[1] * 1_000L + versionParts[2]

require(
    versionParts[1] < 1_000 &&
        versionParts[2] < 1_000 &&
        appVersionCode in 1..Int.MAX_VALUE.toLong()
) {
    "Android version must fit a monotonic major*1000000 + minor*1000 + patch versionCode"
}

android {
    namespace = "ai.okou.android"
    compileSdk = 36
    defaultConfig {
        applicationId = "ai.okou.android"
        minSdk = 24
        targetSdk = 35
        versionCode = appVersionCode.toInt()
        versionName = appVersion
        testInstrumentationRunner = "ai.okou.android.OkouTestRunner"
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
        // Public client configuration, matching iOS; secret keys never belong in an APK.
        buildConfigField("String", "API_ORIGIN", "\"$apiOrigin\"")
        buildConfigField("String", "WEB_ORIGIN", "\"$webOrigin\"")
        buildConfigField("String", "CLERK_PUBLISHABLE_KEY", "\"$clerkPublishableKey\"")
    }
    buildTypes { debug { applicationIdSuffix = ".debug" } }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    sourceSets["test"].kotlin.directories.add("src/sharedTest/kotlin")
    sourceSets["androidTest"].kotlin.directories.add("src/sharedTest/kotlin")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
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
        sourceFiles.from("../../ios/Okou/DesignSystem/Foundations/Lucide-LICENSE.txt")
        outputDirectory.set(layout.buildDirectory.dir("generated/brand/assets"))
        fonts.set(false)
    }

androidComponents.onVariants { variant ->
    variant.sources.res?.addGeneratedSourceDirectory(generateBrandFonts) { it.outputDirectory }
    variant.sources.assets?.addGeneratedSourceDirectory(generateLicenseAssets) {
        it.outputDirectory
    }
    val variantName = variant.name.replaceFirstChar { it.uppercaseChar() }
    val manifest =
        variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.MERGED_MANIFEST)
    val audit =
        tasks.register<Exec>("check${variantName}AuthenticationManifest") {
            val script = project.file("../scripts/check-auth-manifest.py")
            inputs.file(script)
            inputs.file(manifest)
            commandLine("python3", script.absolutePath)
            argumentProviders.add(
                CommandLineArgumentProvider {
                    listOf(manifest.get().asFile.absolutePath, variant.applicationId.get())
                }
            )
        }
    tasks.matching { it.name == "assemble$variantName" }.configureEach { dependsOn(audit) }
}

dependencies {
    implementation(libs.appcompat)
    implementation(libs.clerk.ui)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.foundation)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.navigation.compose)
    implementation(libs.datastore.preferences)
    implementation(libs.coroutines.android)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.compose.ui.test)
    testImplementation(libs.lifecycle.runtime.testing)
    debugImplementation(libs.compose.ui.test.manifest)
    androidTestImplementation(libs.test.core.ktx)
    androidTestImplementation(libs.test.ext.junit)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.uiautomator)
    androidTestImplementation(libs.test.storage)
    androidTestUtil(libs.test.services)
}
