import java.net.URI
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.room)
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
    compileSdk = 36
    defaultConfig {
        applicationId = "ai.okou.android"
        minSdk = 24
        targetSdk = 35
        versionName = appVersion
        testInstrumentationRunner = "ai.okou.android.OkouTestRunner"
        testInstrumentationRunnerArguments["useTestStorageService"] = "true"
        // Public client configuration, matching iOS; secret keys never belong in an APK.
        buildConfigField("String", "API_ORIGIN", "\"$apiOrigin\"")
        buildConfigField("String", "WEB_ORIGIN", "\"$webOrigin\"")
        buildConfigField("String", "CLERK_PUBLISHABLE_KEY", "\"$clerkPublishableKey\"")
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release { optimization { enable = true } }
    }
    testBuildType = "release"
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
    providers.gradleProperty("okou.screenshotScenarioDir").orNull?.let { value ->
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

abstract class TraceNativeTestReferences : DefaultTask() {
    @get:Classpath abstract val appJars: ListProperty<RegularFile>
    @get:Classpath abstract val appDirectories: ListProperty<Directory>
    @get:Classpath abstract val testJars: ListProperty<RegularFile>
    @get:Classpath abstract val testDirectories: ListProperty<Directory>
    @get:Classpath abstract val appLibraries: ConfigurableFileCollection
    @get:Classpath abstract val testLibraries: ConfigurableFileCollection
    @get:Classpath abstract val compileLibraries: ConfigurableFileCollection
    @get:Classpath abstract val androidJar: RegularFileProperty
    @get:Classpath abstract val r8: ConfigurableFileCollection
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val driver: RegularFileProperty
    @get:OutputFile abstract val rules: RegularFileProperty
    @get:Inject abstract val execOperations: ExecOperations

    @TaskAction
    fun trace() {
        fun pack(name: String, directories: List<Directory>): File {
            val jar = temporaryDir.resolve(name)
            ZipOutputStream(jar.outputStream()).use { output ->
                for (directory in directories) {
                    for (file in
                        directory.asFile.walkTopDown().filter { it.extension == "class" }) {
                        output.putNextEntry(
                            ZipEntry(file.relativeTo(directory.asFile).invariantSeparatorsPath)
                        )
                        file.inputStream().use { it.copyTo(output) }
                        output.closeEntry()
                    }
                }
            }
            return jar
        }
        val targets =
            appLibraries.files +
                appJars.get().map { it.asFile } +
                pack("app.jar", appDirectories.get())
        val sources =
            (testLibraries.files - appLibraries.files) +
                testJars.get().map { it.asFile } +
                pack("test.jar", testDirectories.get())
        val libraries = (compileLibraries.files - targets - sources) + androidJar.get().asFile
        val output = rules.get().asFile
        output.parentFile.mkdirs()
        execOperations.javaexec {
            classpath(r8)
            // JDK source-file mode keeps this small R8 adapter outside app code.
            mainClass.set(driver.get().asFile.absolutePath)
            maxHeapSize = "512m"
            args("--keep-rules", "--allowobfuscation", "--output", output.absolutePath)
            for ((flag, files) in
                listOf("--target" to targets, "--source" to sources, "--lib" to libraries)) {
                for (file in files.sorted()) args(flag, file.absolutePath)
            }
        }
    }
}

// Compile API jars duplicate runtime target classes and hide their virtual methods
// from TraceReferences. Only compile-only annotations belong on its library path.
val nativeTestTraceCompileOnly =
    configurations.create("nativeTestTraceCompileOnly") {
        isCanBeConsumed = false
        isCanBeResolved = true
        extendsFrom(
            configurations.getByName("compileOnly"),
            configurations.getByName("androidTestCompileOnly"),
        )
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

androidComponents {
    // Host tests keep Debug-only resource fixtures; instrumentation runs on Release.
    beforeVariants(selector().withBuildType("debug")) { variant ->
        variant.hostTests.values
            .single { it.type == com.android.build.api.variant.HostTestBuilder.UNIT_TEST_TYPE }
            .enable = true
    }
}

androidComponents.onVariants { variant ->
    variant.outputs.forEach { it.versionCode.set(appVersionCode) }
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
    if (variant.buildType == "release") {
        fun classes(configuration: String) =
            configurations
                .getByName(configuration)
                .incoming
                .artifactView {
                    attributes.attribute(
                        Attribute.of("artifactType", String::class.java),
                        "android-classes-jar",
                    )
                }
                .files
        val trace =
            tasks.register<TraceNativeTestReferences>("generateNativeTestKeepRules") {
                appLibraries.from(classes("releaseRuntimeClasspath"))
                testLibraries.from(classes("releaseAndroidTestRuntimeClasspath"))
                compileLibraries.from(nativeTestTraceCompileOnly)
                androidJar.set(
                    androidComponents.sdkComponents.sdkDirectory.map {
                        it.file("platforms/android-36/android.jar")
                    }
                )
                r8.from(
                    File(
                        com.android.tools.r8.retrace.Retrace::class
                            .java
                            .protectionDomain
                            .codeSource
                            .location
                            .toURI()
                    )
                )
                driver.set(
                    rootProject.layout.projectDirectory.file(
                        "scripts/TraceNativeTestReferences.java"
                    )
                )
                rules.set(layout.buildDirectory.file("generated/native-test.keep"))
            }
        variant.artifacts
            .forScope(com.android.build.api.variant.ScopedArtifacts.Scope.PROJECT)
            .use(trace)
            .toGet(
                com.android.build.api.artifact.ScopedArtifact.CLASSES,
                { it.appJars },
                { it.appDirectories },
            )
        checkNotNull(variant.androidTest)
            .artifacts
            .forScope(com.android.build.api.variant.ScopedArtifacts.Scope.PROJECT)
            .use(trace)
            .toGet(
                com.android.build.api.artifact.ScopedArtifact.CLASSES,
                { it.testJars },
                { it.testDirectories },
            )
    }
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
    implementation(libs.commonmark)
    implementation(libs.ably.device) {
        // This client owns foreground realtime only; FCM adds an unused public receiver/provider.
        exclude(group = "com.google.firebase", module = "firebase-messaging")
    }
    implementation(libs.room.runtime)
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
                    .toURI()
            )
        )
    }
}
