package com.ziptv.plugins.runtime.network

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.function
import com.ziptv.plugins.runtime.host.HostModule
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal class UrlBridge : HostModule {
    override fun register(runtime: QuickJs) {
        runtime.function("__parse_url") { args ->
            val urlString = args.getOrNull(0)?.toString() ?: ""
            parseUrl(urlString)
        }
    }

    private fun parseUrl(urlString: String): String {
        return try {
            // ZIPTV: java.net.URI in place of Nuvio's Ktor Url (same fields; -1 / default port = none).
            val parsed = java.net.URI(urlString.trim())
            val scheme = parsed.scheme?.lowercase() ?: error("no scheme")
            val host = parsed.host ?: error("no host")
            val defaultPort = when (scheme) { "https", "wss" -> 443; "http", "ws" -> 80; else -> -1 }
            val port = parsed.port.takeIf { it != -1 && it != defaultPort }
            JsonObject(
                mapOf(
                    "protocol" to JsonPrimitive("$scheme:"),
                    "host" to JsonPrimitive(if (port != null) "$host:$port" else host),
                    "hostname" to JsonPrimitive(host),
                    "port" to JsonPrimitive(port?.toString() ?: ""),
                    "pathname" to JsonPrimitive(parsed.rawPath.orEmpty().ifBlank { "/" }),
                    "search" to JsonPrimitive(parsed.rawQuery?.let { "?$it" } ?: ""),
                    "hash" to JsonPrimitive(parsed.rawFragment?.let { "#$it" } ?: ""),
                ),
            ).toString()
        } catch (_: Exception) {
            JsonObject(
                mapOf(
                    "protocol" to JsonPrimitive(""),
                    "host" to JsonPrimitive(""),
                    "hostname" to JsonPrimitive(""),
                    "port" to JsonPrimitive(""),
                    "pathname" to JsonPrimitive("/"),
                    "search" to JsonPrimitive(""),
                    "hash" to JsonPrimitive(""),
                ),
            ).toString()
        }
    }
}
