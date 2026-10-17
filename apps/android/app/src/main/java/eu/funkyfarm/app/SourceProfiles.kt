package eu.funkyfarm.app

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal fun sourceFailure(error: Throwable): String {
    if (error is CancellationException) throw error
    if (error is ApiFailure) {
        val headers = error.details.optJSONArray("headers")?.strings()?.joinToString(", ")
        return error.message + (headers?.let { " Required source headers: $it." } ?: "") + if (error.status == 409) " Reload the source, farm and column guidance before reviewing again." else ""
    }
    return error.message ?: "The source could not be loaded. Your private draft is retained."
}

@Composable internal fun SourceImportsScreen(model: FarmModel, route: JSONObject, close: () -> Unit) {
    var profiles by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var imports by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var offset by remember { mutableStateOf(0) }; var total by remember { mutableStateOf(0) }
    var profileId by remember { mutableStateOf((route.opt("profile_id") as? String).orEmpty()) }
    var selectedImport by remember { mutableStateOf(route.opt("import_id") as? String) }
    var working by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    suspend fun load() {
        working = true; problem = ""
        try {
            profiles = model.sourceRequest("/imports/profiles").getJSONArray("items").objects()
            val page = model.sourceRequest("/imports?limit=50&offset=$offset")
            imports = page.getJSONArray("items").objects(); total = page.getInt("total")
        } catch (error: Throwable) { profiles = emptyList(); imports = emptyList(); problem = sourceFailure(error) }
        finally { working = false }
    }
    LaunchedEffect(offset) { load() }
    if (route.optString("mode") == "facts") {
        SourceProfileFacts(model, route.optString("farm_id"), route.optString("profile_id"), profiles, close)
        return
    }
    selectedImport?.let { id ->
        SourceImportDetail(model, id, profiles, { scope.launch { load() } }, { selectedImport = null; scope.launch { load() } }, close)
        return
    }
    val profile = profiles.find { it.optString("id") == profileId }
    Sheet("Bring in original source rows", close) {
        Text("Choose the source format documented for your file. Source rows stay proposals until a separate fact review; an import does not change field boundaries or submit an application.")
        if (working) Text("Loading current sources…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { scope.launch { load() } }, enabled = !working) { Text("Reload source choices and saved imports") }
        Choice("What source file do you have?", profileId, listOf("" to "Choose a prepared source format") + profiles.map { it.getString("id") to "${it.optString("label")} · ${it.optString("country")} ${it.optInt("source_year")}" }) { profileId = it }
        if (profile != null) SourceProfileUpload(model, profile, route.opt("farm_id") as? String) { selectedImport = it.getString("id") }
        Text("Other CSV files", style = MaterialTheme.typography.titleMedium)
        Text("The advanced column-mapping editor remains on the website. Prepared formats above can be completed here without mapping columns.")
        WebLink(model, "/app/imports", "Open advanced CSV mapping on the website")
        Text("Sources already in this workspace", style = MaterialTheme.typography.titleLarge)
        imports.forEach { imported -> Card(onClick = { selectedImport = imported.getString("id") }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp)) {
            Text(imported.data().optString("source_name"), fontWeight = FontWeight.Bold)
            Text("${imported.data().optInt("row_count")} original rows · ${imported.data().optString("grain")}", style = MaterialTheme.typography.bodySmall)
        } } }
        if (!working && imports.isEmpty()) Text("No sources are loaded on this page.")
        Row { TextButton(onClick = { offset = maxOf(0, offset - 50) }, enabled = offset > 0 && !working) { Text("Previous sources") }; TextButton(onClick = { offset += 50 }, enabled = offset + imports.size < total && !working) { Text("Next sources") } }
    }
}

@Composable private fun SourceProfileUpload(model: FarmModel, profile: JSONObject, initialFarmId: String?, uploaded: (JSONObject) -> Unit) {
    val key = "source-profile-upload:${profile.getString("id")}"
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("farm_id" to initialFarmId.orEmpty(), "delimiter" to "auto"))) }
    var working by remember(key) { mutableStateOf(false) }; var problem by remember(key) { mutableStateOf("") }
    var sourceChecked by remember(key, profile.optString("definition_hash")) { mutableStateOf(false) }
    var pickerOwner by remember(key) { mutableStateOf<JSONObject?>(null) }
    val context = LocalContext.current; val scope = rememberCoroutineScope()
    val farms = model.records["farms"].orEmpty().filter { it.data().optString("country") == profile.optString("country") }
    val pending = draft.optJSONObject("upload_intent")
    fun change(name: String, value: Any) { draft = JSONObject(draft.toString()).put(name, value); model.saveDraft(key, draft); sourceChecked = false }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) {
            val owner = pickerOwner
            if (owner != null) scope.launch {
                working = true; problem = ""
                try {
                    val (name, bytes) = withContext(Dispatchers.IO) {
                        require(uri.scheme == "content") { "Choose a file from a document provider." }
                        var filename = "source.csv"
                        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) {
                            val size = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (size >= 0 && !cursor.isNull(size)) require(cursor.getLong(size) <= MAX_SOURCE_IMPORT) { "Choose a CSV no larger than 20 MiB." }
                            val label = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (label >= 0) filename = cursor.getString(label) ?: filename
                        } }
                        filename to (context.contentResolver.openInputStream(uri)?.use { it.bounded(MAX_SOURCE_IMPORT) } ?: error("The source file could not be opened."))
                    }
                    draft = model.saveImportFile(key, bytes, name, owner); sourceChecked = false
                } catch (error: Throwable) { problem = sourceFailure(error) }
                finally { working = false }
            }
        }
    }
    Text(profile.optString("label"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
    Text("File source year: ${profile.optInt("source_year")}. Check the year in the actual export; the upload date does not establish it.")
    SourceProfileDefinition(profile)
    Choice("Farm this source belongs to", draft.optString("farm_id"), listOf("" to "Choose the farm for this source") + farms.map { it.getString("id") to it.title() }) { if (pending == null) change("farm_id", it) }
    if (farms.isEmpty()) Text("Add a farm in ${profile.optString("country")} before using this source format.")
    Choice("CSV separator", draft.optString("delimiter"), listOf("auto" to "Check the documented headers", "," to "Comma", ";" to "Semicolon", "\t" to "Tab")) { if (pending == null) change("delimiter", it) }
    Button(onClick = { model.saveDraft(key, draft); pickerOwner = model.session; picker.launch(arrayOf("text/csv", "text/comma-separated-values", "text/plain", "application/csv")) }, enabled = pending == null && !working) { Text("Choose original CSV file") }
    draft.optJSONObject("file")?.let { file ->
        Text("${file.optString("name")} · ${file.optLong("size") / 1024} KiB", style = MaterialTheme.typography.bodySmall)
        Row { Checkbox(sourceChecked, { sourceChecked = it }, enabled = pending == null && !working); Text("I checked this export's source format, year and selected farm.", Modifier.weight(1f).padding(top = 12.dp)) }
        if (pending != null) {
            Text("A delivery is pending. Retry sends this same file and source choices. Resolve it before changing them.")
            if (pending.optString("profile_hash") != profile.optString("definition_hash")) Text("The source guidance changed since this upload was prepared. Retry keeps its original choices; review the current guidance after it is received.")
        }
        Button(onClick = { scope.launch {
            working = true; problem = ""
            try {
                val intent = pending ?: obj("key" to UUID.randomUUID().toString(), "profile_hash" to profile.getString("definition_hash"), "fields" to obj("farm_id" to draft.getString("farm_id"), "format_profile" to profile.getString("id"), "source_year" to profile.getInt("source_year"), "grain" to profile.getString("label"), "delimiter" to draft.getString("delimiter")))
                if (pending == null) { draft = JSONObject(draft.toString()).put("upload_intent", intent); model.saveDraft(key, draft) }
                val result = model.uploadImportFile(file, intent.getJSONObject("fields"), intent.getString("key"))
                model.clearImportFile(key); uploaded(result)
            } catch (error: Throwable) { problem = sourceFailure(error) }
            finally { working = false }
        } }, enabled = !working && (pending != null || sourceChecked && farms.any { it.optString("id") == draft.optString("farm_id") })) { Text(if (pending != null) "Retry this exact upload" else "Upload source for review") }
        TextButton(onClick = { model.clearImportFile(key); draft = obj("farm_id" to "", "delimiter" to "auto"); sourceChecked = false }, enabled = !working) { Text(if (pending == null) "Discard this device file" else "Discard pending device upload") }
        if (pending != null) Text("Discard only removes this device's pending file. A source already received by the service remains in saved imports.", style = MaterialTheme.typography.bodySmall)
    }
    if (working) Text("Reading or uploading source…")
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
}

private fun sourceReady(imported: JSONObject, farm: JSONObject?, profile: JSONObject?, decimal: String): Boolean {
    if (farm == null || profile == null) return false
    val data = imported.data(); val review = data.optJSONObject("profile_review") ?: return false
    val holding = data.opt("holding_reference") as? String ?: return false
    return holding.isNotBlank() && holding.trim().uppercase() !in listOf("NULL", "UNKNOWN") &&
        data.optString("format_profile") == profile.optString("id") && data.optInt("source_year") == profile.optInt("source_year") &&
        farm.data().optString("country") == profile.optString("country") &&
        data.optString("profile_definition_hash") == profile.optString("definition_hash") &&
        review.optString("definition_hash") == profile.optString("definition_hash") && review.optString("profile_id") == profile.optString("id") &&
        review.optBoolean("confirmed_source") && review.optInt("source_year") == data.optInt("source_year") &&
        review.optString("holding_reference") == holding && review.optInt("farm_revision") == farm.optInt("revision") &&
        decimal in listOf(".", ",") && review.optString("decimal_separator") == decimal
}

private fun originalRowValues(imported: JSONObject, row: JSONObject): JSONObject = JSONObject().apply {
    val cells = row.data().optJSONArray("original_row") ?: JSONArray()
    val columns = imported.data().optJSONArray("columns")?.objects().orEmpty()
    columns.forEach { column -> val index = column.getInt("source_index"); if (index < cells.length()) put(column.getString("header"), cells.get(index)) }
    for (index in columns.size until cells.length()) put("Additional cell ${index + 1}", cells.get(index))
}

@Composable private fun SourceImportDetail(model: FarmModel, id: String, profiles: List<JSONObject>, onChanged: () -> Unit, back: () -> Unit, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var imported by remember(id) { mutableStateOf<JSONObject?>(null) }; var farm by remember(id) { mutableStateOf<JSONObject?>(null) }
    var catalogue by remember(id) { mutableStateOf(profiles) }
    var preview by remember(id) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var offset by remember(id) { mutableStateOf(model.draft("source-rows:$id", JSONObject()).optInt("offset", 0)) }; var reload by remember(id) { mutableStateOf(0) }
    var working by remember(id) { mutableStateOf(false) }; var problem by remember(id) { mutableStateOf("") }
    var decimal by remember(id) { mutableStateOf("") }; var confirmed by remember(id) { mutableStateOf(false) }
    var selected by remember(id) { mutableStateOf<Set<Int>>(emptySet()) }
    var acknowledgements by remember(id) { mutableStateOf<Map<Int, Set<String>>>(emptyMap()) }
    val confirmKey = "source-confirm:$id"; val reviewKey = "source-rows:$id"
    var confirmIntent by remember(id) { mutableStateOf(model.draft(confirmKey, JSONObject()).takeIf { it.has("body") }) }
    var rowIntent by remember(id) { mutableStateOf(model.draft(reviewKey, JSONObject()).takeIf { it.has("body") }) }
    var outcomesReloaded by remember(id) { mutableStateOf(false) }
    var note by remember(id) { mutableStateOf("") }; var result by remember(id) { mutableStateOf<JSONObject?>(null) }
    val canReview = model.session?.optJSONObject("workspace")?.optString("role") in listOf("owner", "adviser")
    suspend fun load() {
        working = true; problem = ""; confirmed = false; selected = emptySet(); acknowledgements = emptyMap(); preview = emptyList(); farm = null; imported = null; outcomesReloaded = false
        try {
            catalogue = model.sourceRequest("/imports/profiles").getJSONArray("items").objects()
            val pageOffset = rowIntent?.optInt("offset") ?: offset
            val source = model.sourceRequest("/imports/$id?limit=5&offset=$pageOffset")
            imported = source
            outcomesReloaded = rowIntent != null
            val farmId = source.data().opt("farm_id") as? String
            farm = if (farmId != null) model.sourceRequest("/farms/$farmId") else null
            decimal = source.data().optJSONObject("profile_review")?.optString("decimal_separator").orEmpty()
            val profile = catalogue.find { it.optString("id") == source.data().optString("format_profile") }
            if (sourceReady(source, farm, profile, decimal)) {
                val checked = model.sourceRequest("/imports/$id/preview?limit=5&offset=$pageOffset")
                if (checked.optInt("import_revision") != source.getInt("revision")) throw ApiFailure(409, "revision_conflict", "The source changed while row checks were loading.")
                preview = checked.getJSONArray("items").objects()
            }
        } catch (error: Throwable) { problem = sourceFailure(error) }
        finally { working = false }
    }
    LaunchedEffect(id, offset, reload) { load() }
    val source = imported; val data = source?.data()
    val profile = catalogue.find { it.optString("id") == data?.optString("format_profile") }
    val ready = source != null && sourceReady(source, farm, profile, decimal)
    val originalRows = source?.optJSONObject("rows")?.optJSONArray("items")?.objects().orEmpty()
    Sheet("Check the original source", close) {
        TextButton(onClick = back, enabled = !working) { Text("Back to source files") }
        if (working) Text("Loading or saving current source information…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { reload++ }, enabled = !working) { Text("Reload current source, farm and column guidance") }
        if (source != null && data != null) {
            Text(data.optString("source_name"), style = MaterialTheme.typography.titleLarge)
            Text("${data.optInt("row_count")} original rows · ${data.optString("grain")}")
            if ((data.opt("format_profile") as? String).isNullOrBlank()) {
                Text("This is a generic CSV source. Continue its advanced mapping on the website; prepared source formats use the native review here.")
                WebLink(model, "/app/imports?import=$id", "Review this generic CSV on the website")
            } else {
                Text(profile?.optString("label") ?: data.optString("format_profile"), fontWeight = FontWeight.Bold)
                farm?.let { Text("Farm: ${it.title()} · ${it.data().optString("country")}"); Text("Farm reporting year: ${sourceText(it.data().opt("reporting_year"))}", style = MaterialTheme.typography.bodySmall) }
                Text("File source year: ${sourceText(data.opt("source_year"))}")
                Text("Holding number exactly as supplied: ${sourceText(data.opt("holding_reference"))}")
                profile?.let { SourceProfileDefinition(it) }
                if (profile == null) Text("The current source definition is unavailable. Reload before reviewing rows.")
                Text(if (ready) "Source details are current. Review the original rows before creating proposals." else "Confirm the source, holding number, year, decimal mark and current farm before reusing rows.")
                Choice("Decimal mark in this file", decimal, listOf("" to "Choose after checking the original", "." to "Dot · for example 12.5", "," to "Comma · for example 12,5")) { value ->
                    if (confirmIntent == null && rowIntent == null && !working) { decimal = value; confirmed = false; selected = emptySet(); acknowledgements = emptyMap(); preview = emptyList() }
                }
                Row { Checkbox(confirmed, { confirmed = it }, enabled = canReview && confirmIntent == null && rowIntent == null && !working); Text("I checked this source format, source year, exact holding number and selected farm against the original file.", Modifier.weight(1f).padding(top = 12.dp)) }
                if (!canReview) Text("An owner or authorised adviser must review this source and its row proposals.")
                if (confirmIntent != null) Text("A source-confirmation response is pending. Retry preserves its original revisions and choices.")
                Button(onClick = { scope.launch {
                    working = true; problem = ""
                    try {
                        val currentFarm = farm ?: error("Reload the current farm first.")
                        val intent = confirmIntent ?: obj("key" to UUID.randomUUID().toString(), "body" to obj("expected_revision" to source.getInt("revision"), "expected_farm_revision" to currentFarm.getInt("revision"), "holding_reference" to data.getString("holding_reference"), "decimal_separator" to decimal, "confirm_source" to true))
                        confirmIntent = intent; model.saveDraft(confirmKey, intent)
                        model.sourceRequest("/imports/$id/profile-review", "POST", intent.getJSONObject("body"), intent.getString("key"))
                        model.deleteDraft(confirmKey); confirmIntent = null; onChanged(); reload++
                    } catch (error: Throwable) {
                        if (error is ApiFailure && error.status in 400..499) { model.deleteDraft(confirmKey); confirmIntent = null; confirmed = false; preview = emptyList() }
                        problem = sourceFailure(error)
                    } finally { working = false }
                } }, enabled = canReview && !working && rowIntent == null && farm != null && profile != null && (confirmIntent != null || confirmed && decimal in listOf(".", ",") && (data.opt("holding_reference") as? String)?.isNotBlank() == true)) { Text(if (confirmIntent == null) "Confirm source and load row checks" else "Retry exact source confirmation") }
                Text("This does not change a boundary, establish ownership or certification, calculate balances, or submit an application.", style = MaterialTheme.typography.bodySmall)
                rowIntent?.let { pending ->
                    Text("A row-review outcome needs checking", style = MaterialTheme.typography.titleMedium)
                    Text("Sending these rows again could create a second proposal. Reload first and open any proposal already saved below. Remaining rows need fresh checks before you send them again.")
                    pending.getJSONObject("body").getJSONArray("rows").objects().forEach { selectedRow ->
                        val row = originalRows.takeIf { outcomesReloaded }?.find { it.data().optInt("row_number") == selectedRow.optInt("row_number") }
                        val promoted = row?.data()?.optJSONObject("promoted_record")
                        Text("Row ${selectedRow.optInt("row_number")}: " + if (!outcomesReloaded) "reload to check whether a proposal was saved" else if (promoted != null) "an existing proposal was found" else "no saved proposal is shown on this reloaded page; review current checks before trying again")
                        promoted?.let { ExistingImportProposal(model, it, close) }
                    }
                    OutlinedButton(onClick = { model.deleteDraft(reviewKey); rowIntent = null; result = null; reload++ }, enabled = !working && outcomesReloaded && pending.getJSONObject("body").getJSONArray("rows").objects().all { selectedRow -> originalRows.any { it.data().optInt("row_number") == selectedRow.optInt("row_number") } }) { Text("I checked the outcomes · review remaining rows again") }
                }
                result?.let { ImportRowResults(model, it, close) }
                Text("Original rows on this page", style = MaterialTheme.typography.titleLarge)
                originalRows.forEach { row ->
                    val number = row.data().getInt("row_number")
                    val checked = preview.find { it.optJSONObject("row")?.data()?.optInt("row_number") == number }
                    val promoted = row.data().optJSONObject("promoted_record")
                    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        Text("Source row $number", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        val values = originalRowValues(source, row)
                        SourceRowSummary(values, profile)
                        var expanded by remember(id, row.getString("id"), row.getInt("revision")) { mutableStateOf(false) }
                        TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide original cells · source row $number" else "Show original cells · source row $number") }
                        if (expanded) SourceRowValues(values, profile)
                        if (promoted != null) ExistingImportProposal(model, promoted, close)
                        else if (checked != null && ready) {
                            val required = checked.optJSONArray("requires_acknowledgement").strings()
                            checked.optJSONArray("issues")?.objects()?.forEach { issue -> Text(issue.optString("message"), color = if (issue.optString("severity") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
                            required.forEach { code -> Row {
                                Checkbox(code in acknowledgements[number].orEmpty(), { acknowledged -> val values = acknowledgements[number].orEmpty(); acknowledgements = acknowledgements + (number to if (acknowledged) values + code else values - code) }, enabled = !working && rowIntent == null)
                                Text(checked.optJSONArray("issues")?.objects()?.find { it.optString("code") == code }?.optString("message") ?: "Acknowledge this source check", Modifier.weight(1f).padding(top = 12.dp))
                            } }
                            Row { Checkbox(number in selected, { include -> selected = if (include) selected + number else selected - number }, enabled = canReview && !working && rowIntent == null && checked.optBoolean("can_save")); Text("Create a proposed farm fact from this row", Modifier.weight(1f).padding(top = 12.dp)) }
                        } else Text("Reload and confirm the current source details before reviewing this row.", style = MaterialTheme.typography.bodySmall)
                    } }
                }
                OutlinedTextField(note, { note = it }, label = { Text("What did you check in the selected source rows?") }, modifier = Modifier.fillMaxWidth(), enabled = !working && rowIntent == null)
                val selectionReady = selected.isNotEmpty() && selected.all { number -> preview.find { it.optJSONObject("row")?.data()?.optInt("row_number") == number }?.let { it.optBoolean("can_save") && it.optJSONArray("requires_acknowledgement").strings().all { code -> code in acknowledgements[number].orEmpty() } } == true }
                Button(onClick = { scope.launch {
                    working = true; problem = ""; result = null; outcomesReloaded = false
                    try {
                        val rows = selected.sorted().map { number -> val checked = preview.first { it.getJSONObject("row").data().getInt("row_number") == number }; obj("row_number" to number, "expected_revision" to checked.getJSONObject("row").getInt("revision"), "preview_token" to checked.getString("preview_token"), "acknowledged_issues" to JSONArray(acknowledgements[number].orEmpty().sorted())) }
                        val body = obj("expected_revision" to source.getInt("revision"), "rows" to JSONArray(rows), "note" to note)
                        rowIntent = obj("body" to body, "offset" to offset); model.saveDraft(reviewKey, rowIntent!!)
                        result = model.sourceRequest("/imports/$id/rows/review", "POST", body)
                        if (result!!.optJSONArray("items")?.objects()?.any { it.optJSONObject("error")?.optString("code") in listOf("revision_conflict", "profile_review_required", "preview_changed") } == true) farm = null
                        model.deleteDraft(reviewKey); rowIntent = null; selected = emptySet(); acknowledgements = emptyMap(); preview = emptyList(); model.refresh(); onChanged()
                    } catch (error: Throwable) {
                        if (error is ApiFailure && error.status in 400..499) { model.deleteDraft(reviewKey); rowIntent = null }
                        selected = emptySet(); acknowledgements = emptyMap(); preview = emptyList(); problem = sourceFailure(error)
                    } finally { working = false }
                } }, enabled = ready && canReview && !working && rowIntent == null && confirmIntent == null && selectionReady && note.isNotBlank()) { Text("Create ${selected.size} selected proposed row(s)") }
                Text("Creating proposals does not confirm them. Open each saved fact and review its exact source separately.", style = MaterialTheme.typography.bodySmall)
                Row { TextButton(onClick = { result = null; offset = maxOf(0, offset - 5) }, enabled = !working && rowIntent == null && offset > 0) { Text("Previous rows") }; TextButton(onClick = { result = null; offset += 5 }, enabled = !working && rowIntent == null && offset + originalRows.size < data.optInt("row_count")) { Text("Next rows") } }
                Text("Showing ${if (originalRows.isEmpty()) 0 else offset + 1}–${offset + originalRows.size} of ${data.optInt("row_count")} rows", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable private fun ExistingImportProposal(model: FarmModel, promoted: JSONObject, close: () -> Unit) {
    val kind = promoted.optString("kind"); val id = promoted.optString("id")
    if (kind in listOf("facts", "operations", "purchases", "sales") && id.isNotBlank()) OutlinedButton(onClick = { close(); model.open(kind, id) }) { Text(if (kind == "facts") "Open this fact for separate review" else "Open existing proposed record") }
}

@Composable private fun ImportRowResults(model: FarmModel, result: JSONObject, close: () -> Unit) {
    Text("${result.optInt("saved_count")} rows saved as proposals · ${result.optInt("failed_count")} rows not saved", style = MaterialTheme.typography.titleMedium)
    result.optJSONArray("items")?.objects()?.forEach { item ->
        Text("Row ${item.optInt("row_number")}: ${if (item.optString("status") == "saved") "proposal saved, not confirmed" else "not saved"}", fontWeight = FontWeight.SemiBold)
        item.optJSONObject("record")?.let { ExistingImportProposal(model, it, close) }
        item.optJSONObject("error")?.let { error -> Text(error.optString("message"), color = MaterialTheme.colorScheme.error); if (error.optString("code") in listOf("revision_conflict", "profile_review_required", "preview_changed")) Text("Reload the source and farm, then review fresh checks for this row.") }
    }
}

@Composable private fun SourceProfileFacts(model: FarmModel, farmId: String, profileId: String, profiles: List<JSONObject>, close: () -> Unit) {
    var facts by remember(farmId, profileId) { mutableStateOf<List<JSONObject>>(emptyList()) }; var offset by remember { mutableStateOf(0) }; var nextOffset by remember { mutableStateOf(0) }; var total by remember { mutableStateOf(0) }
    var working by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }; var reload by remember { mutableStateOf(0) }
    LaunchedEffect(farmId, profileId, offset, reload) {
        working = true; problem = ""
        try {
            val page = model.sourceRequest("/facts?farm_id=$farmId&limit=$SOURCE_FACT_PAGE_SIZE&offset=$offset")
            val received = page.getJSONArray("items").objects()
            facts = if (offset == 0) received else (facts + received).distinctBy { it.getString("id") }
            nextOffset = page.optInt("offset", offset) + received.size; total = page.getInt("total")
        }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { working = false }
    }
    val profile = profiles.find { it.optString("id") == profileId }
    Sheet("Review saved source rows", close) {
        Text("Proposed rows need an explicit, separate fact review. Confirmed counts do not establish eligibility or a complete authority application.")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        if (working) Text("Loading saved source rows…")
        facts.filter { sourceProfileId(it) == profileId || profile?.optString("fact_key_prefix")?.takeIf(String::isNotBlank)?.let { prefix -> it.data().optString("key").startsWith(prefix) } == true }.forEach { fact ->
            OutlinedButton(onClick = { close(); model.open("facts", fact.getString("id")) }, modifier = Modifier.fillMaxWidth()) { Column { Text(fact.title()); Text("${fact.data().optString("review_status")} · ${sourceText(fact.data().opt("period"))}", style = MaterialTheme.typography.bodySmall) } }
        }
        if (nextOffset < total) OutlinedButton(onClick = { offset = nextOffset; reload++ }, enabled = !working) { Text("Load more farm facts to find source rows") }
        OutlinedButton(onClick = { facts = emptyList(); offset = 0; nextOffset = 0; reload++ }, enabled = !working) { Text("Refresh saved source rows") }
    }
}
