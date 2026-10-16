package eu.funkyfarmers.app

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

const val MAX_DOCUMENT = 10 * 1024 * 1024
class ApiFailure(val status: Int, val code: String, override val message: String) : Exception(message)
fun InputStream.bounded(limit: Int): ByteArray {
    val result = ByteArrayOutputStream()
    val block = ByteArray(8192)
    while (true) { val count = read(block); if (count < 0) break; require(result.size() + count <= limit) { "This file exceeds the ${limit / 1024 / 1024} MiB limit." }; result.write(block, 0, count) }
    return result.toByteArray()
}
class Api(val base: String, private val token: String = "", private val workspace: String = "") {
    init {
        val uri = URI(base)
        require(uri.scheme == "https" || (uri.scheme == "http" && uri.host in listOf("localhost", "127.0.0.1", "10.0.2.2"))) { "Use HTTPS, or the local emulator API." }
        require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.path.orEmpty().trim('/').isEmpty()) { "Enter only the API origin." }
    }
    fun request(path: String, method: String = "GET", body: JSONObject? = null, retryId: String? = null): JSONObject =
        JSONObject(exchange(path, method, body?.toString()?.toByteArray(), "application/json", retryId).toString(Charsets.UTF_8).ifBlank { "{}" })
    fun upload(bytes: ByteArray, filename: String, mime: String, retryId: String): JSONObject {
        require(bytes.size <= MAX_DOCUMENT)
        val boundary = "farm-$retryId"
        val output = ByteArrayOutputStream()
        val safeName = filename.replace(Regex("[^a-zA-Z0-9._ -]"), "_").take(100).ifBlank { "document" }
        output.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$safeName\"\r\nContent-Type: $mime\r\n\r\n".toByteArray())
        output.write(bytes); output.write("\r\n--$boundary--\r\n".toByteArray())
        return JSONObject(exchange("/documents", "POST", output.toByteArray(), "multipart/form-data; boundary=$boundary", retryId).toString(Charsets.UTF_8))
    }
    fun download(path: String) = exchange(path, "GET", null, "application/json", null, 24 * 1024 * 1024)
    private fun exchange(path: String, method: String, body: ByteArray?, mime: String, retryId: String?, limit: Int = 12 * 1024 * 1024): ByteArray {
        require(path.startsWith("/") && !path.startsWith("//"))
        val connection = URL("${base.trimEnd('/')}/api/v1$path").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000; connection.readTimeout = if (path == "/assistant/chat") 60_000 else 30_000; connection.instanceFollowRedirects = false
            connection.requestMethod = method; connection.setRequestProperty("Accept", "application/json")
            if (token.isNotBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
            if (workspace.isNotBlank()) connection.setRequestProperty("X-Workspace-ID", workspace)
            retryId?.let { connection.setRequestProperty("Idempotency-Key", it) }
            if (body != null) { connection.doOutput = true; connection.setRequestProperty("Content-Type", mime); connection.setFixedLengthStreamingMode(body.size); connection.outputStream.use { it.write(body) } }
            val status = connection.responseCode
            if (status !in 200..299) {
                val parsed = runCatching { JSONObject(connection.errorStream?.use { it.bounded(64 * 1024) }?.toString(Charsets.UTF_8) ?: "{}").optJSONObject("error") }.getOrNull()
                throw ApiFailure(status, parsed?.optString("code") ?: "http_$status", parsed?.optString("message") ?: "The service returned $status.")
            }
            return connection.inputStream.use { it.bounded(limit) }
        } finally { connection.disconnect() }
    }
}
