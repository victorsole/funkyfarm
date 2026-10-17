package eu.funkyfarm.app

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.UUID

private const val FIELD_FILE_LIMIT = 512_000
private const val FIELD_FILE_PAGE = 10
private val fieldFileKeyboard = KeyboardOptions(autoCorrectEnabled = false)

/** Raw picked contents live only in this screen's memory, never in device drafts. */
@Composable internal fun FieldFileImport(model: FarmModel, farm: JSONObject, close: () -> Unit, changed: () -> Unit) {
    val farmId = farm.getString("id"); val key = "field-file-import:$farmId"
    val owner = model.session
    val binding = "${model.origin}:${owner?.optJSONObject("user")?.optString("id")}:${owner?.optJSONObject("workspace")?.optString("id")}:$farmId:${farm.getInt("revision")}:${model.serverVersion}"
    val currentBinding by rememberUpdatedState(binding)
    val context = LocalContext.current; val scope = rememberCoroutineScope()
    var draft by remember(key, owner) { mutableStateOf(model.draft(key, JSONObject())) }
    var currentFarm by remember(key, owner) { mutableStateOf<JSONObject?>(null) }
    var preview by remember(key, owner) { mutableStateOf<JSONObject?>(null) }
    var filename by remember(key, owner) { mutableStateOf("") }; var contents by remember(key, owner) { mutableStateOf<String?>(null) }
    var year by remember(key, owner) { mutableStateOf("") }; var origin by remember(key, owner) { mutableStateOf("my_file") }
    var uploadIntent by remember(key, owner) { mutableStateOf<JSONObject?>(null) }
    var busy by remember(key, owner) { mutableStateOf(false) }; var problem by remember(key, owner) { mutableStateOf("") }
    var acknowledged by remember(key, owner) { mutableStateOf(false) }; var page by remember(key, owner) { mutableStateOf(0) }
    var reload by remember(key, owner) { mutableStateOf(0) }; var generation by remember(key, owner) { mutableStateOf(0) }
    var discard by remember(key, owner) { mutableStateOf(false) }
    var job by remember(key, owner) { mutableStateOf<Job?>(null) }; var pickerBinding by remember(key, owner) { mutableStateOf<String?>(null) }
    val pending = draft.optJSONObject("propose_intent")
    fun guard(expected: String, token: Int) { if (model.session !== owner || currentBinding != expected || generation != token) throw CancellationException() }
    fun save(value: JSONObject) { if (model.session === owner) { draft = value; model.saveDraft(key, value) } }
    fun invalidateSource() { generation++; job?.cancel(); busy = false; preview = null; uploadIntent = null; acknowledged = false; page = 0; save(JSONObject()) }
    fun verifyImport(value: JSONObject, expectedRevision: Int): JSONObject {
        require(value.data().getString("farm_id") == farmId) { "This file preview belongs to a different farm." }
        require(value.data().getInt("farm_revision") == expectedRevision || draft.optJSONObject("propose_intent") != null) { "The farm changed since this file preview. Choose the file again against the current farm; no proposal was rebased." }
        require(value.data().getJSONArray("rows").length() <= 100) { "This file preview exceeds the 100-field limit. Use a smaller file." }
        return value
    }
    DisposableEffect(binding) { onDispose { generation++; job?.cancel(); contents = null; uploadIntent = null } }
    LaunchedEffect(binding, reload) {
        generation++; val token = generation; job?.cancel(); busy = true; problem = ""; acknowledged = false; preview = null; currentFarm = null
        try {
            val fresh = model.sourceRequest("/farms/$farmId"); guard(binding, token)
            require(fresh.getString("id") == farmId)
            currentFarm = fresh
            draft.text("import_id").takeIf(String::isNotBlank)?.let { id ->
                val loaded = model.sourceRequest("/field-imports/${UUID.fromString(id)}"); guard(binding, token)
                require(loaded.getString("id") == id && loaded.data().getString("farm_id") == farmId) { "This is not the original file preview for this farm." }
                if (loaded.data().text("status") == "proposed") {
                    val proposal = model.sourceRequest("/field-proposals/${UUID.fromString(loaded.data().getString("proposal_id"))}"); guard(binding, token)
                    require(proposal.data().getString("farm_id") == farmId) { "The recovered proposal belongs to a different farm." }
                    save(JSONObject()); model.notify("The file proposal was already received. Review the saved field changes before approving them."); changed(); close()
                } else {
                    require(loaded.data().text("status") == "preview") { "This file preview is no longer available for proposal selection." }
                    preview = verifyImport(loaded, fresh.getInt("revision")); filename = loaded.data().text("filename"); origin = loaded.data().getString("source_origin"); year = loaded.data().opt("source_year").takeUnless { it == null || it === JSONObject.NULL }?.toString().orEmpty()
                }
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { if (currentBinding == binding && generation == token) { problem = sourceFailure(error); if (error is ApiFailure && error.status in listOf(401, 403, 404)) { save(JSONObject()); contents = null } } }
        finally { if (currentBinding == binding && generation == token) busy = false }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        val pickedBinding = pickerBinding
        if (uri != null && pickedBinding == currentBinding && model.session === owner && pending == null) {
            invalidateSource(); val token = generation; busy = true; problem = ""
            job = scope.launch {
                try {
                    val file = withContext(Dispatchers.IO) {
                        require(uri.scheme == "content") { "Choose a local file from a document provider." }
                        var name = ""
                        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) {
                            val size = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (size >= 0 && !cursor.isNull(size)) require(cursor.getLong(size) in 1L..FIELD_FILE_LIMIT.toLong()) { "Choose a nonempty file no larger than 512,000 bytes." }
                            val label = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (label >= 0) name = cursor.getString(label).orEmpty()
                        } }
                        require(name.substringAfterLast('.', "").lowercase() in listOf("geojson", "json", "kml")) { "Choose a GeoJSON (.geojson or .json) or KML (.kml) file, not a ZIP or another format." }
                        val bytes = context.contentResolver.openInputStream(uri)?.use { it.bounded(FIELD_FILE_LIMIT) } ?: error("The selected file could not be opened.")
                        require(bytes.isNotEmpty() && !(bytes.size >= 2 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4b.toByte())) { "Choose an unpacked text file, not a ZIP archive." }
                        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
                        name to text
                    }
                    guard(pickedBinding!!, token); filename = file.first; contents = file.second
                } catch (error: CancellationException) { throw error }
                catch (error: Throwable) { if (currentBinding == pickedBinding && generation == token) { contents = null; filename = ""; problem = sourceFailure(error) } }
                finally { if (currentBinding == pickedBinding && generation == token) busy = false }
            }
        }
    }
    Sheet("Preview a field file", close) {
        Text(farm.title(), style = MaterialTheme.typography.titleLarge)
        Text("Choose up to 20 fields from a file preview. This adds one private proposal for separate review; it does not match or overwrite existing fields, change official identifiers or submit an LPIS update.")
        Text("GeoJSON or KML · strict UTF-8 text · at most 512,000 bytes and 100 fields. Compressed archives are not accepted.")
        if (pending == null) {
            Choice("Where did this file come from?", origin, listOf("my_file" to "My own file", "public_reference" to "Public reference file")) { if (!busy) { invalidateSource(); origin = it } }
            OutlinedTextField(year, { if (!busy) { invalidateSource(); year = it } }, label = { Text("Actual source year · optional") }, keyboardOptions = fieldFileKeyboard, enabled = !busy, modifier = Modifier.fillMaxWidth())
            Text("Leave the year blank if the file does not establish it. The current year is not assumed.")
            if (origin == "public_reference") Text("A public reference may cover other farms or years and is not proof of your holding, ownership, current boundary or official acceptance.", color = MaterialTheme.colorScheme.error)
            OutlinedButton(onClick = { pickerBinding = binding; picker.launch(arrayOf("application/geo+json", "application/json", "application/vnd.google-earth.kml+xml", "text/xml", "application/xml", "text/plain", "application/octet-stream")) }, enabled = !busy && currentFarm != null) { Text("Choose GeoJSON or KML file") }
        }
        if (filename.isNotBlank()) Text("Selected file: $filename")
        if (contents != null && pending == null) Button(onClick = {
            val fresh = currentFarm ?: return@Button; val expected = binding; val token = ++generation; busy = true; problem = ""; acknowledged = false
            job = scope.launch {
                try {
                    require(year.isBlank() || year.matches(Regex("[0-9]{4}")) && year.toInt() in 1900..2200) { "Enter the actual four-digit source year or leave it blank." }
                    val intent = uploadIntent ?: obj("key" to UUID.randomUUID().toString(), "body" to obj("expected_farm_revision" to fresh.getInt("revision"), "filename" to filename, "format" to if (filename.endsWith(".kml", true)) "kml" else "geojson", "contents" to contents, "source_year" to year.takeIf(String::isNotBlank)?.toInt(), "source_origin" to origin)).also { uploadIntent = it }
                    val result = model.sourceRequest("/farms/$farmId/field-imports", "POST", intent.getJSONObject("body"), intent.getString("key")); guard(expected, token)
                    preview = verifyImport(result, fresh.getInt("revision")); save(obj("import_id" to result.getString("id"), "selected_ids" to JSONArray(), "note" to "")); uploadIntent = null; contents = null; page = 0
                } catch (error: CancellationException) { throw error }
                catch (error: Throwable) { if (currentBinding == expected && generation == token) problem = sourceFailure(error) }
                finally { if (currentBinding == expected && generation == token) busy = false }
            }
        }, enabled = !busy && currentFarm != null) { Text(if (uploadIntent == null) "Preview this file" else "Retry this exact file preview") }
        if (busy) Text("Loading the file or checking the current farm…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { reload++ }, enabled = !busy) { Text("Reload this preview and current farm") }
        preview?.let { imported ->
            val rows = imported.data().getJSONArray("rows").objects(); val selected = draft.optJSONArray("selected_ids")?.let { values -> (0 until values.length()).map { values.getString(it) }.toSet() }.orEmpty()
            Text(imported.data().text("filename"), style = MaterialTheme.typography.titleMedium)
            Text("${selected.size} selected · maximum 20 · ${rows.size} fields in this preview")
            if (imported.data().text("source_origin") == "public_reference") Text("Public reference only. Check that each chosen field really belongs to this farm and the stated source year is correct.", color = MaterialTheme.colorScheme.error)
            Text("Source year: ${imported.data().opt("source_year").takeUnless { it == JSONObject.NULL } ?: "Not established"}")
            if (rows.isEmpty()) Text("No fields were supplied in this preview. Nothing can be proposed.")
            val start = page * FIELD_FILE_PAGE; val visible = rows.drop(start).take(FIELD_FILE_PAGE)
            Text("${if (visible.isEmpty()) 0 else start + 1}–${start + visible.size} of ${rows.size} preview fields")
            visible.forEachIndexed { index, row -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val rowId = row.getString("id")
                Text("Field ${start + index + 1} · ${row.text("name")}", fontWeight = FontWeight.Bold)
                Text("Crop: ${row.text("crop").ifBlank { "Not supplied" }}"); Text("Existing reference: ${row.text("external_id").ifBlank { "Not supplied" }}")
                FieldOutline(row)
                row.optJSONObject("geometry_summary")?.opt("approximate_area_ha")?.takeUnless { it == JSONObject.NULL }?.let { Text("Approximate area from this outline: $it ha") }
                row.optJSONArray("warnings")?.let { warnings -> repeat(warnings.length()) { Text(warnings.get(it).toString(), color = MaterialTheme.colorScheme.error) } }
                Row { Checkbox(rowId in selected, { checked -> acknowledged = false; save(JSONObject(draft.toString()).put("selected_ids", JSONArray((if (checked) selected + rowId else selected - rowId).toList()))) }, enabled = !busy && pending == null && (rowId in selected || selected.size < 20)); Text("Select field ${start + index + 1} for the proposal", Modifier.weight(1f).padding(top = 12.dp)) }
            } } }
            Row { TextButton(onClick = { page-- }, enabled = !busy && page > 0) { Text("Previous preview fields") }; TextButton(onClick = { page++ }, enabled = !busy && start + visible.size < rows.size) { Text("Next preview fields") } }
            OutlinedTextField(draft.text("note"), { acknowledged = false; save(JSONObject(draft.toString()).put("note", it)) }, label = { Text("Why are you adding these fields? · required") }, keyboardOptions = fieldFileKeyboard, enabled = !busy && pending == null, modifier = Modifier.fillMaxWidth())
            Row { Checkbox(acknowledged, { acknowledged = it }, enabled = !busy && pending == null); Text("I checked every selected outline, field name, crop, reference, source year and warning. These are additions, not automatic replacements.", Modifier.weight(1f).padding(top = 12.dp)) }
            if (pending != null) Text("A proposal delivery is unresolved. Retry keeps its exact selected fields, farm revision and delivery identity; it is never rebased onto a changed farm.")
            if (pending != null && imported.data().getInt("farm_revision") != currentFarm?.optInt("revision")) Text("The farm has since changed. Exact retry can recover an already-received proposal, but cannot create a new proposal against a newer farm revision.", color = MaterialTheme.colorScheme.error)
            Button(onClick = {
                val expected = binding; val token = ++generation; busy = true; problem = ""
                job = scope.launch {
                    try {
                        val intent = pending ?: obj("key" to UUID.randomUUID().toString(), "body" to obj("expected_revision" to imported.getInt("revision"), "expected_farm_revision" to currentFarm!!.getInt("revision"), "selected_ids" to JSONArray(selected.toList()), "note" to draft.getString("note"), "acknowledged" to true)).also { save(JSONObject(draft.toString()).put("propose_intent", it)) }
                        val result = model.sourceRequest("/field-imports/${imported.getString("id")}/propose", "POST", intent.getJSONObject("body"), intent.getString("key")); guard(expected, token)
                        require(result.getJSONObject("proposal").data().getString("farm_id") == farmId && result.getJSONObject("import").getString("id") == imported.getString("id"))
                        save(JSONObject()); changed(); close()
                    } catch (error: CancellationException) { throw error }
                    catch (error: Throwable) { if (currentBinding == expected && generation == token) { acknowledged = false; problem = sourceFailure(error) } }
                    finally { if (currentBinding == expected && generation == token) busy = false }
                }
            }, enabled = !busy && currentFarm != null && (pending != null || acknowledged && selected.size in 1..20 && selected.all { id -> rows.any { it.getString("id") == id } } && draft.text("note").isNotBlank())) { Text(if (pending == null) "Create one field proposal for review" else "Retry this exact field proposal") }
        }
        if (pending != null && preview == null) Text("The saved proposal intent remains private. Reload the original preview before retrying; a stale or unavailable preview is not an empty selection.")
        if (draft.has("import_id") || contents != null || pending != null) TextButton(onClick = { discard = true }, enabled = !busy) { Text("Discard this device selection after comparison") }
    }
    if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text("Discard the device selection?") }, text = { Text("A proposal may already have been received if its response was lost. Reload and compare the saved field changes first. Discard removes this device's selection and retry intent only; it does not undo or remove any server preview, proposal or approved field.") }, confirmButton = { TextButton(onClick = { invalidateSource(); contents = null; filename = ""; discard = false }) { Text("Discard device selection only") } }, dismissButton = { TextButton(onClick = { discard = false }) { Text("Keep and compare") } })
}
