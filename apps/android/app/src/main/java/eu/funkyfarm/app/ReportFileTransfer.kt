package eu.funkyfarm.app

import kotlinx.coroutines.CancellationException
import java.io.File
import java.net.HttpURLConnection
import java.util.concurrent.atomic.AtomicBoolean

internal const val REPORT_DISK_RESERVE = 32L * 1024 * 1024
internal const val REPORT_EXPORT_BUDGET = 512L * 1024 * 1024

/** One owned private file; cancellation disconnects its request and removes incomplete bytes. */
internal class ReportFileTransfer(val file: File, val budget: Long) {
    private val stopped = AtomicBoolean(false)
    @Volatile private var connection: HttpURLConnection? = null
    val cancelled get() = stopped.get()
    fun attach(value: HttpURLConnection) { connection = value; if (cancelled) { value.disconnect(); throw CancellationException() } }
    fun check() { if (cancelled) throw CancellationException() }
    fun cancel() { stopped.set(true); connection?.disconnect(); file.delete() }
}
