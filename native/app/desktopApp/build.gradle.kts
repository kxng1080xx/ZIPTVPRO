import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    kotlin("jvm")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.compose")
}

kotlin {
    jvmToolchain(17)
    sourceSets["main"].kotlin.srcDir("../shared/kotlin")
}

// Same logo index as Android, on the classpath.
val copyLogoIndex by tasks.registering(Copy::class) {
    from(rootProject.file("../../public/channel-logos.json"))
    into(layout.buildDirectory.dir("generated/ziptvResources"))
}

// TMDB read token from the repo's .env (same as v9's vite build), packaged as a resource.
val writeTmdbToken by tasks.registering {
    val out = layout.buildDirectory.file("generated/ziptvResources/tmdb.token")
    outputs.file(out)
    doLast {
        val env = rootProject.file("../../.env")
        val token = if (env.exists()) env.readLines().firstOrNull { it.trim().startsWith("TMDB_TOKEN") }
            ?.substringAfter('=')?.trim()?.removeSurrounding("\"") ?: "" else ""
        out.get().asFile.apply { parentFile.mkdirs(); writeText(token) }
    }
}

sourceSets["main"].resources.srcDir(layout.buildDirectory.dir("generated/ziptvResources"))
tasks.named("processResources") { dependsOn(copyLogoIndex, writeTmdbToken) }

dependencies {
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
    implementation(compose.materialIconsExtended)
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.11.0")
    implementation("io.coil-kt.coil3:coil-compose:3.6.3")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.6.3")
    implementation("net.java.dev.jna:jna:5.19.1")
    implementation("uk.co.caprica:vlcj:4.12.1")
}

compose.desktop {
    application {
        mainClass = "com.ziptv.desktop.MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Msi, TargetFormat.Exe)
            packageName = "ZIPTV Pro"
            packageVersion = providers.gradleProperty("ziptv.version").get()
            windows { menuGroup = "ZIPTV Pro"; shortcut = true; iconFile.set(rootProject.file("../../build/icon.ico")) }
        }
    }
}
