package com.ziptv.sources

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/**
 * Runs [block] for every item concurrently, each under its own [timeoutMs]. Non-null results are collected in
 * completion order; as soon as [enough] says the collected list is sufficient (or everything settled) the
 * remaining work is cancelled and the list returned. Failures and timeouts of single items are swallowed.
 */
suspend fun <T, R : Any> parallelUntil(
    items: List<T>,
    timeoutMs: Long,
    enough: (List<R>) -> Boolean = { false },
    block: suspend (T) -> R?
): List<R> {
    if (items.isEmpty()) return emptyList()
    return coroutineScope {
        val channel = Channel<R?>(items.size)
        val jobs = items.map { item ->
            launch {
                val result: R? = try {
                    withTimeout(timeoutMs) { block(item) }
                } catch (e: TimeoutCancellationException) {
                    null
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    null
                }
                channel.send(result)
            }
        }
        val got = ArrayList<R>()
        for (i in items.indices) {
            val r = channel.receive()
            if (r != null) got += r
            if (enough(got)) break
        }
        jobs.forEach { it.cancel() }
        got
    }
}

/** String field, or null when missing / JSON null / blank (org.json's optString would return "null"). */
fun org.json.JSONObject.str(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
