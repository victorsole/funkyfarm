package eu.funkyfarm.app

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

const val MAX_DOCUMENT = 10 * 1024 * 1024
const val MAX_SOURCE_IMPORT = 20 * 1024 * 1024
internal const val SOURCE_FACT_PAGE_SIZE = 5
internal fun recordPageSize(kind: String): Int = if (kind == "facts") SOURCE_FACT_PAGE_SIZE else 100
/** Response projection only: queued mutation bodies and retry identities stay unchanged. */
internal fun reportTransportPath(path: String, method: String): String {
    val route = path.substringBefore('?')
    if (path.substringAfter('?', "").split('&').any { it.startsWith("view=") }) return path
    val view = when {
        method == "GET" && (route == "/reports" || Regex("^/(facts|operations|sales)/[^/]+/reports$").matches(route)) -> "summary"
        method == "GET" && Regex("^/reports/[^/]+$").matches(route) -> "review"
        method == "POST" && (route == "/reports" || Regex("^/reports/[^/]+/(approve|reissue)$").matches(route)) -> "summary"
        else -> return path
    }
    return path + (if ('?' in path) "&" else "?") + "view=$view"
}
class ApiFailure(val status: Int, val code: String, override val message: String, val details: JSONObject = JSONObject()) : Exception(message)
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
        JSONObject(exchange(reportTransportPath(path, method), method, body?.toString()?.toByteArray(), "application/json", retryId, if (method == "GET" && Regex("^/reports/[^/]+/review$").matches(path.substringBefore('?'))) 2 * 1024 * 1024 else 12 * 1024 * 1024).toString(Charsets.UTF_8).ifBlank { "{}" })
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
    internal fun streamReport(path: String, transfer: ReportFileTransfer, expectedMime: String? = null) {
        val connection = connection(path, "GET")
        connection.setRequestProperty("Accept-Encoding", "identity")
        expectedMime?.let { connection.setRequestProperty("Accept", it) }
        transfer.attach(connection)
        try {
            checkResponse(connection)
            expectedMime?.let { require(connection.contentType?.substringBefore(';')?.trim()?.equals(it, ignoreCase = true) == true) { "The service did not return the requested file type. No file was shared." } }
            val advertised = connection.contentLengthLong
            val packet = expectedMime == "application/zip"
            if (packet) {
                require(advertised in 1L..(128L * 1024 * 1024)) { "The prepared folder needs a known positive size no larger than 128 MiB. No file was shared." }
                require(connection.getHeaderField("Content-Encoding")?.trim()?.equals("identity", ignoreCase = true) != false) { "The prepared folder must arrive without content encoding. No file was shared." }
            }
            require(advertised <= transfer.budget) { "This export exceeds the available private storage budget. Free space or choose a smaller export." }
            transfer.check()
            connection.inputStream.use { input -> transfer.file.outputStream().use { output ->
                val block = ByteArray(32 * 1024); var count = 0L
                while (true) {
                    transfer.check()
                    val read = input.read(block); if (read < 0) break
                    count += read
                    require(count <= transfer.budget) { "This export exceeds the private storage budget. Free space or choose a smaller export." }
                    require(!packet || count <= advertised) { "The prepared folder exceeded its advertised complete size. No file was shared." }
                    require(transfer.file.parentFile!!.usableSpace >= REPORT_DISK_RESERVE) { "Private storage is nearly full. Free space and retry the export." }
                    output.write(block, 0, read)
                }
                transfer.check()
                require(count > 0 && (if (packet) count == advertised else advertised < 0 || count == advertised)) { "The export ended before the complete file arrived. Retry the download." }
            } }
        } catch (error: Throwable) { transfer.file.delete(); throw error }
        finally { connection.disconnect(); if (transfer.cancelled) transfer.file.delete() }
    }
    fun uploadImport(bytes: ByteArray, filename: String, fields: JSONObject, retryId: String): JSONObject {
        require(bytes.isNotEmpty() && bytes.size <= MAX_SOURCE_IMPORT) { "Choose a nonempty UTF-8 CSV no larger than 20 MiB." }
        val boundary = "source-$retryId"
        val output = ByteArrayOutputStream()
        fields.keys().asSequence().sorted().forEach { key ->
            require(key in listOf("grain", "farm_id", "format_profile", "source_year", "delimiter"))
            output.write("--$boundary\r\nContent-Disposition: form-data; name=\"$key\"\r\n\r\n${fields.get(key)}\r\n".toByteArray(Charsets.UTF_8))
        }
        val safeName = filename.replace(Regex("[^a-zA-Z0-9._ -]"), "_").take(100).ifBlank { "source.csv" }
        output.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$safeName\"\r\nContent-Type: text/csv\r\n\r\n".toByteArray())
        output.write(bytes); output.write("\r\n--$boundary--\r\n".toByteArray())
        return JSONObject(exchange("/imports", "POST", output.toByteArray(), "multipart/form-data; boundary=$boundary", retryId).toString(Charsets.UTF_8))
    }
    private fun exchange(path: String, method: String, body: ByteArray?, mime: String, retryId: String?, limit: Int = 12 * 1024 * 1024): ByteArray {
        val connection = connection(path, method)
        try {
            retryId?.let { connection.setRequestProperty("Idempotency-Key", it) }
            if (body != null) { connection.doOutput = true; connection.setRequestProperty("Content-Type", mime); connection.setFixedLengthStreamingMode(body.size); connection.outputStream.use { it.write(body) } }
            checkResponse(connection)
            return connection.inputStream.use { it.bounded(limit) }
        } finally { connection.disconnect() }
    }
    private fun connection(path: String, method: String): HttpURLConnection {
        require(path.startsWith("/") && !path.startsWith("//"))
        return (URL("${base.trimEnd('/')}/api/v1$path").openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000; readTimeout = if (path == "/assistant/chat") 60_000 else 30_000; instanceFollowRedirects = false
            requestMethod = method; setRequestProperty("Accept", "application/json")
            if (token.isNotBlank()) setRequestProperty("Authorization", "Bearer $token")
            if (workspace.isNotBlank()) setRequestProperty("X-Workspace-ID", workspace)
        }
    }
    private fun checkResponse(connection: HttpURLConnection) {
        val status = connection.responseCode
        if (status !in 200..299) {
            val parsed = runCatching { JSONObject(connection.errorStream?.use { it.bounded(64 * 1024) }?.toString(Charsets.UTF_8) ?: "{}").optJSONObject("error") }.getOrNull()
            throw ApiFailure(status, parsed?.optString("code") ?: "http_$status", parsed?.optString("message") ?: "The service returned $status.", parsed?.optJSONObject("details") ?: JSONObject())
        }
    }
}
