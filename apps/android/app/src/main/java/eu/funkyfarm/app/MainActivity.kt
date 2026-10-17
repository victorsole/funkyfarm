package eu.funkyfarm.app

import android.content.ClipData
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModelProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

class MainActivity : ComponentActivity() {
    private lateinit var model: FarmModel
    private var cameraFile: File? = null
    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> uris.forEach(::ingest) }
    private val camera = registerForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val file = cameraFile
        if (success && file != null) runCatching { model.stage(file.inputStream().use { it.bounded(MAX_DOCUMENT) }, "Camera page.jpg", "image/jpeg", scan = true) }.onFailure { model.notify(it.message ?: "The photo could not be saved.") }
        file?.delete(); cameraFile = null
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        model = ViewModelProvider(this)[FarmModel::class.java]
        cameraFile = savedInstanceState?.getString("camera_path")?.let { path -> File(path).takeIf { it.parentFile == File(cacheDir, "camera") } }
        if (savedInstanceState == null) receive(intent)
        setContent { FarmerApp(model, ::pickFiles, ::takePhoto, ::assemblePages, ::shareFile, ::shareDownloadedFile) }
    }
    override fun onSaveInstanceState(outState: Bundle) { cameraFile?.let { outState.putString("camera_path", it.absolutePath) }; super.onSaveInstanceState(outState) }
    override fun onDestroy() { if (::model.isInitialized) model.cancelReportExport(); super.onDestroy() }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); receive(intent) }
    private fun receive(intent: Intent) {
        if (intent.action == Intent.ACTION_VIEW) {
            val uri = intent.data ?: return
            val match = Regex("^funkyfarm://record/(requests|documents|reports|farms)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$").matchEntire(uri.toString())
            if (match != null && model.session != null) model.open(match.groupValues[1], match.groupValues[2])
            else model.notify("Sign in, then open the record link again. A link does not grant access.")
            return
        }
        @Suppress("DEPRECATION")
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            else -> emptyList()
        }
        uris.take(10).forEach(::ingest)
        if (uris.size > 10) model.notify("Only the first 10 shared files were accepted. Share the remaining files separately.")
        if (intent.action == Intent.ACTION_SEND && uris.isEmpty()) intent.getStringExtra(Intent.EXTRA_TEXT)?.let { text ->
            runCatching { model.stage(text.toByteArray(Charsets.UTF_8), "Shared note.txt", "text/plain") }.onFailure { model.notify(it.message ?: "The shared note was rejected.") }
        }
    }
    private fun ingest(uri: Uri) {
        runCatching {
            require(uri.scheme == "content") { "Only files shared by a document provider are accepted." }
            val mime = contentResolver.getType(uri) ?: error("The file type is unknown.")
            var name = "Document"
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) require(cursor.getLong(sizeColumn) <= MAX_DOCUMENT) { "The document exceeds 10 MiB." }
                    val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameColumn >= 0) name = cursor.getString(nameColumn)
                }
            }
            val bytes = contentResolver.openInputStream(uri)?.use { it.bounded(MAX_DOCUMENT) } ?: error("The shared file could not be read.")
            model.stage(bytes, name, mime)
            if (model.session != null) { model.tab = "Documents"; model.detail = null }
        }.onFailure { model.notify(it.message ?: "This file was rejected; the original remains with its provider.") }
    }
    private fun pickFiles() { filePicker.launch(arrayOf("application/pdf", "image/png", "image/jpeg", "text/plain")) }
    private fun takePhoto() {
        runCatching {
            val file = File(File(cacheDir, "camera").apply { mkdirs() }, "${UUID.randomUUID()}.jpg")
            cameraFile = file
            camera.launch(FileProvider.getUriForFile(this, "$packageName.files", file))
        }.onFailure { cameraFile?.delete(); cameraFile = null; model.notify("No camera app is available. Choose a photo or file instead.") }
    }
    private fun assemblePages() {
        runCatching {
            val pages = model.staged.filter { it.optBoolean("scan") }
            require(pages.isNotEmpty() && pages.size <= 10) { "Review between 1 and 10 camera pages." }
            val output = ByteArrayOutputStream()
            val pdf = PdfDocument()
            try {
                pages.forEachIndexed { index, part ->
                    val bytes = model.attachmentBytes(part)
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "A camera page cannot be decoded." }
                    var sample = 1
                    while (bounds.outWidth / sample > 1800 || bounds.outHeight / sample > 1800) sample *= 2
                    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: error("The camera page is unreadable.")
                    val page = pdf.startPage(PdfDocument.PageInfo.Builder(595, 842, index + 1).create())
                    page.canvas.drawColor(AndroidColor.WHITE)
                    val scale = minOf(555f / bitmap.width, 802f / bitmap.height)
                    val width = bitmap.width * scale; val height = bitmap.height * scale
                    page.canvas.drawBitmap(bitmap, null, android.graphics.RectF((595 - width) / 2, (842 - height) / 2, (595 + width) / 2, (842 + height) / 2), null)
                    pdf.finishPage(page); bitmap.recycle()
                }
                pdf.writeTo(output)
            } finally { pdf.close() }
            require(output.size() <= MAX_DOCUMENT) { "The assembled PDF exceeds 10 MiB. Remove pages and try again." }
            // Preserve reviewed page order; source photos are removed only after the new draft is durable.
            model.saveAssembledPdf(output.toByteArray(), pages)
            model.notify("Reviewed pages assembled as one PDF. Upload it when ready.")
        }.onFailure { model.notify(it.message ?: "The PDF could not be assembled. Your pages are retained.") }
    }
    private fun shareFile(bytes: ByteArray, filename: String, mime: String) {
        runCatching {
            model.cancelReportExport()
            val directory = File(cacheDir, "exports").apply { mkdirs() }
            directory.listFiles()?.forEach { it.delete() }
            val file = File(directory, filename.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(120))
            file.outputStream().use { it.write(bytes) }
            shareDownloadedFile(file, mime)
        }.onFailure { model.notify(it.message ?: "No sharing app is available.") }
    }
    private fun shareDownloadedFile(file: File, mime: String) {
        val directory = File(cacheDir, "exports").canonicalFile
        require(file.canonicalFile.parentFile == directory && file.isFile && file.length() > 0) { "The complete private export is unavailable. Download it again." }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val send = Intent(Intent.ACTION_SEND).apply { type = mime; putExtra(Intent.EXTRA_STREAM, uri); clipData = ClipData.newRawUri("Reviewed export", uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        startActivity(Intent.createChooser(send, "Save or share this private file"))
    }
}
