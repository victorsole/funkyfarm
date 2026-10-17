package eu.funkyfarm.app

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

@Composable internal fun FieldsHome(model: FarmModel, setup: () -> Unit) {
    Text("My fields", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    Text("Keep field names, crops and boundaries with the farm they belong to.")
    WebLink(model, "/app/demo", "Hackathon demo · opens website")
    Text("The jury walkthrough opens in your browser and may ask you to sign in separately. Opening it does not confirm or submit farm records.", style = MaterialTheme.typography.bodySmall)
    if (model.records["farms"].isNullOrEmpty()) { Button(onClick = setup) { Text("Set up my farm first") }; return }
    model.records["farms"].orEmpty().forEach { farm -> FarmFields(model, farm) }
    TextButton(onClick = setup) { Text("Update farm setup") }
}

@Composable private fun FarmFields(model: FarmModel, farm: JSONObject) {
    val id = farm.getString("id"); val key = "fields:$id"; val proposalsKey = "field-proposals:$id"
    LaunchedEffect(id, farm.optInt("revision"), model.serverVersion) { model.loadExtra(key, "/farms/$id/fields"); model.loadExtra(proposalsKey, "/farms/$id/field-proposals") }
    val response = model.extras[key]
    val unavailable = key in model.privateUnavailable
    val fields = if (unavailable) emptyList() else response?.optJSONArray("items")?.objects() ?: farm.data().optJSONArray("parcels")?.objects().orEmpty()
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var newField by remember { mutableStateOf(false) }
    var importingFile by remember(id) { mutableStateOf(false) }
    Text(farm.title(), style = MaterialTheme.typography.titleLarge)
    OutlinedButton(onClick = { model.open("farms", id) }) { Text("Farm details and checked facts") }
    OutlinedButton(onClick = { model.cases = obj("create" to true, "job_type" to "fields", "farm_id" to id) }) { Text("Check these fields as a preparation job") }
    if (unavailable) { Text("These fields are no longer available to this account. Reconnect and check your access."); return }
    WebLink(model, "/app/fields/$id/check", "Check my parcels · opens website")
    Text("The guided parcel check opens in your browser and may ask you to sign in separately. Nothing is confirmed or sent automatically.", style = MaterialTheme.typography.bodySmall)
    LpisGuide(model, farm)
    if (response == null) Text("Showing fields retained with this farm while the current list loads.", style = MaterialTheme.typography.bodySmall)
    fields.forEach { field -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(field.optString("name"), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
        if (field.optString("crop").isNotBlank()) Text("Crop: ${field.optString("crop")}")
        if (field.optBoolean("greenhouse")) Text("Greenhouse")
        FieldOutline(field)
        field.opt("approximate_area_ha")?.takeUnless { it == JSONObject.NULL }?.let { Text("Approximate boundary area: $it ha", style = MaterialTheme.typography.bodySmall) }
        field.optJSONObject("geometry_summary")?.optJSONArray("warnings")?.let { warnings -> repeat(warnings.length()) { Text(warnings.get(it).toString(), color = MaterialTheme.colorScheme.error) } }
        if (field.optString("notes").isNotBlank()) Text(field.optString("notes"))
        OutlinedButton(onClick = { editing = field }) { Text("Propose a field correction") }
    } } }
    if (fields.isEmpty()) Text("No fields recorded yet. You can start with names; a point or boundary is optional.")
    Button(onClick = { newField = true }) { Text("Add a field") }
    OutlinedButton(onClick = { importingFile = true }, enabled = !model.offline) { Text("Preview fields from a GeoJSON or KML file") }
    Text("Drawing, splitting and merging field boundaries continue in the website editor. Review the proposed boundary there before approving it; a location pin is not a boundary.", style = MaterialTheme.typography.bodySmall)
    WebLink(model, "/app/fields/$id", "Draw, split or merge fields on the website")
    Text("The boundary editor opens in your browser and may ask you to sign in. The same farm record is used; edits still need review.", style = MaterialTheme.typography.bodySmall)
    val proposals = model.extras[proposalsKey]?.optJSONArray("items")?.objects().orEmpty()
    if (proposals.isNotEmpty()) Text("Field changes to check", style = MaterialTheme.typography.titleLarge)
    proposals.forEach { proposal -> FieldProposalReview(model, farm, proposal) }
    if (newField || editing != null) FieldProposalEditor(model, farm, editing) { newField = false; editing = null }
    if (importingFile) FieldFileImport(model, farm, { importingFile = false }) {
        model.loadExtra(key, "/farms/$id/fields")
        model.loadExtra(proposalsKey, "/farms/$id/field-proposals")
    }
}

@Composable private fun FieldProposalEditor(model: FarmModel, farm: JSONObject, field: JSONObject?, close: () -> Unit) {
    val key = "field-edit:${farm.getString("id")}:${field?.optString("id") ?: "new"}"
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("parcel" to (field ?: obj("name" to "", "crop" to "", "notes" to "")), "note" to "", "expected_revision" to farm.getInt("revision")))) }
    fun update(name: String, value: Any) { draft = JSONObject(draft.toString()).apply { getJSONObject("parcel").put(name, value) }; model.saveDraft(key, draft) }
    var error by remember { mutableStateOf("") }
    Sheet(if (field == null) "Add a field" else "Suggest a field correction", close) {
        val parcel = draft.getJSONObject("parcel")
        OutlinedTextField(parcel.optString("name"), { update("name", it) }, label = { Text("What do you call this field?") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(parcel.optString("crop"), { update("crop", it) }, label = { Text("Crop · if known") }, modifier = Modifier.fillMaxWidth())
        Row { Checkbox(parcel.optBoolean("greenhouse"), { update("greenhouse", it) }); Text("This is a greenhouse", Modifier.weight(1f).padding(top = 12.dp)) }
        OutlinedTextField(parcel.optString("external_id"), { update("external_id", it) }, label = { Text("Existing field reference · optional") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(parcel.optString("notes"), { update("notes", it) }, label = { Text("Notes about this field") }, modifier = Modifier.fillMaxWidth())
        FieldOutline(parcel)
        Text("A name is enough to start. Add or change the boundary in the website editor; a location pin is not a field boundary.")
        OutlinedTextField(draft.optString("note"), { draft = JSONObject(draft.toString()).put("note", it); model.saveDraft(key, draft) }, label = { Text("Why are you adding or changing it?") }, modifier = Modifier.fillMaxWidth())
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        Button(onClick = {
            runCatching {
                require(parcel.optString("name").isNotBlank() && draft.optString("note").isNotBlank()) { "Add the field name and a short reason." }
                val output = JSONObject().apply { listOf("id", "name", "crop", "greenhouse", "geometry", "point", "external_id", "notes").filter(parcel::has).forEach { put(it, parcel.get(it)) } }
                model.enqueue("/farms/${farm.getString("id")}/field-proposals", obj("expected_revision" to draft.getInt("expected_revision"), "parcel" to output, "note" to draft.optString("note")), draftKey = key); close()
            }.onFailure { error = it.message ?: "Check the field details." }
        }, enabled = !model.busy) { Text("Save field proposal for review") }
    }
}

@Composable internal fun FieldProposalReview(model: FarmModel, farm: JSONObject, proposal: JSONObject) {
    val data = proposal.data()
    if (data.optString("status") != "proposed") return
    val proposed = data.optJSONArray("parcels")?.objects() ?: listOfNotNull(data.optJSONObject("parcel"))
    val previous = data.optJSONArray("previous_parcels")?.objects() ?: listOfNotNull(data.optJSONObject("previous_parcel"))
    val operation = data.optString("operation", "edit")
    val retiring = operation in listOf("split", "merge")
    var reviewed by remember(proposal.optString("id"), proposal.optInt("revision"), farm.optInt("revision")) { mutableStateOf<Set<String>>(emptySet()) }
    var overlap by remember(proposal.optString("id"), proposal.optInt("revision"), farm.optInt("revision")) { mutableStateOf(false) }
    val required = proposed.indices.map { "new:$it" } + previous.indices.map { "previous:$it" }
    val baselineMatches = data.optInt("base_farm_revision") == farm.getInt("revision")
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Review the whole ${operation.replace('_', ' ')} proposal", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Text(data.optString("note"))
        Text("${proposed.size} proposed field(s) · ${previous.size} prior field(s). " + if (retiring) "All prior fields shown below will be retired, not deleted, and linked to the proposed replacements." else "The proposed information replaces the reviewed field revision; retained history remains available.")
        previous.forEachIndexed { index, parcel ->
            FieldReviewParcel(parcel, if (retiring) "Prior field ${index + 1} · will be retired" else "Prior field ${index + 1}")
            val reviewKey = "previous:$index"
            Row { Checkbox(reviewKey in reviewed, { checked -> reviewed = if (checked) reviewed + reviewKey else reviewed - reviewKey }); Text(if (retiring) "I checked this prior field and its retirement." else "I checked this previous field record.", Modifier.weight(1f).padding(top = 12.dp)) }
        }
        proposed.forEachIndexed { index, parcel ->
            FieldReviewParcel(parcel, "Proposed field ${index + 1}")
            val reviewKey = "new:$index"
            Row { Checkbox(reviewKey in reviewed, { checked -> reviewed = if (checked) reviewed + reviewKey else reviewed - reviewKey }); Text("I checked this proposed field, its boundary and details.", Modifier.weight(1f).padding(top = 12.dp)) }
        }
        data.optJSONObject("reference")?.let { reference -> FieldReviewParcel(reference, "Supplied comparison reference · not an official update") }
        var comparison by remember(proposal.optString("id"), proposal.optInt("revision")) { mutableStateOf(false) }
        TextButton(onClick = { comparison = !comparison }) { Text(if (comparison) "Hide comparison and lineage" else "Show comparison and retained lineage") }
        if (comparison) SelectionContainer { Text(obj("comparison" to data.opt("comparison"), "lineage" to data.opt("lineage"), "split_line" to data.opt("split_line")).toString(2), style = MaterialTheme.typography.bodySmall) }
        val warnings = data.optJSONArray("warnings") ?: data.optJSONObject("geometry_summary")?.optJSONArray("warnings") ?: JSONArray()
        repeat(warnings.length()) { Text(warnings.get(it).toString(), color = MaterialTheme.colorScheme.error) }
        data.optJSONArray("overlapping_fields")?.objects()?.forEach { other -> Text("Reported overlap: ${other.optString("name")} · ${other.optString("id")}", style = MaterialTheme.typography.bodySmall) }
        if (warnings.toString().contains("overlap", true)) Row { Checkbox(overlap, { overlap = it }); Text("I checked and accept the reported overlap.", Modifier.weight(1f).padding(top = 12.dp)) }
        if (!baselineMatches) Text("The farm changed after this proposal. Refresh and prepare a new proposal against the current farm before approving.", color = MaterialTheme.colorScheme.error)
        if (retiring && previous.isEmpty()) Text("The prior fields are missing from this proposal. Reload it before reviewing the replacements.", color = MaterialTheme.colorScheme.error)
        Button(onClick = { model.enqueue("/field-proposals/${proposal.getString("id")}/approve", obj("expected_revision" to proposal.getInt("revision"), "expected_farm_revision" to farm.getInt("revision"), "note" to "Every proposed and prior field, including any retirement, explicitly checked in Android", "accept_overlap" to overlap)) }, enabled = baselineMatches && proposed.isNotEmpty() && (!retiring || previous.isNotEmpty()) && required.all { it in reviewed } && !model.busy && (!warnings.toString().contains("overlap", true) || overlap)) { Text("Approve all reviewed field changes") }
    } }
}

@Composable internal fun FieldReviewParcel(parcel: JSONObject, heading: String) {
    Text(heading, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
    Text(parcel.optString("name").ifBlank { "Supplied reference" })
    FieldOutline(parcel)
    parcel.keys().asSequence().filter { it !in listOf("name", "geometry") }.forEach { key ->
        SelectionContainer { Text("${key.replace('_', ' ')}: ${parcel.get(key)}", style = MaterialTheme.typography.bodySmall) }
    }
    var geometry by remember(parcel.toString()) { mutableStateOf(false) }
    if (parcel.optJSONObject("geometry") != null) {
        TextButton(onClick = { geometry = !geometry }) { Text(if (geometry) "Hide source coordinates" else "Show source coordinates") }
        if (geometry) SelectionContainer { Text(parcel.getJSONObject("geometry").toString(2), style = MaterialTheme.typography.bodySmall) }
    }
}

private fun polygonRings(geometry: JSONObject): List<List<Pair<Double, Double>>> {
    val coordinates = geometry.optJSONArray("coordinates") ?: return emptyList()
    val polygons = if (geometry.optString("type") == "Polygon") listOf(coordinates) else if (geometry.optString("type") == "MultiPolygon") (0 until coordinates.length()).mapNotNull { coordinates.optJSONArray(it) } else emptyList()
    var vertices = 0
    return polygons.flatMap { polygon -> (0 until polygon.length()).mapNotNull { ringIndex -> polygon.optJSONArray(ringIndex)?.let { ring ->
        (0 until ring.length()).map { index -> val point = ring.getJSONArray(index); val longitude = point.getDouble(0); val latitude = point.getDouble(1); require(longitude.isFinite() && latitude.isFinite() && longitude in -180.0..180.0 && latitude in -90.0..90.0); require(++vertices <= 20_000); longitude to latitude }
    } } }
}

@Composable internal fun FieldOutline(field: JSONObject) {
    val geometry = field.optJSONObject("geometry")
    val rings = remember(geometry?.toString()) { geometry?.let { runCatching { polygonRings(it) }.getOrNull() }.orEmpty() }
    val points = rings.flatten()
    if (points.isEmpty()) {
        val point = field.optJSONObject("point")
        Text(if (point != null) "Location pin: ${point.opt("latitude")}, ${point.opt("longitude")}. No boundary recorded." else "No field boundary recorded.", style = MaterialTheme.typography.bodySmall)
        return
    }
    val west = points.minOf { it.first }; val east = points.maxOf { it.first }; val south = points.minOf { it.second }; val north = points.maxOf { it.second }
    Canvas(Modifier.fillMaxWidth().height(190.dp).semantics { contentDescription = "Saved boundary outline for ${field.optString("name")}. North is at the top. No background map." }) {
        drawRect(Color(0xFFEAF0E5))
        val spanX = (east - west).coerceAtLeast(.000001); val spanY = (north - south).coerceAtLeast(.000001)
        val scale = minOf((size.width - 32) / spanX, (size.height - 32) / spanY)
        val xOffset = (size.width - spanX * scale) / 2; val yOffset = (size.height - spanY * scale) / 2
        val outline = Path().apply { fillType = PathFillType.EvenOdd; rings.forEach { ring -> ring.forEachIndexed { index, (longitude, latitude) -> val x = (xOffset + (longitude - west) * scale).toFloat(); val y = (yOffset + (north - latitude) * scale).toFloat(); if (index == 0) moveTo(x, y) else lineTo(x, y) }; close() } }
        drawPath(outline, Color(0xFFB8D0A6)); drawPath(outline, Color(0xFF285840), style = Stroke(width = 3f))
    }
    Text("Outline from the saved coordinates. No background map or official parcel verification.", style = MaterialTheme.typography.bodySmall)
}

@Composable internal fun WebLink(model: FarmModel, path: String, label: String) {
    val context = LocalContext.current
    OutlinedButton(onClick = {
        runCatching {
            val relative = Uri.parse(path)
            require(relative.scheme == null && relative.authority == null && relative.fragment == null && relative.path.orEmpty().startsWith("/app/"))
            val api = Uri.parse(model.origin)
            val local = api.host in listOf("10.0.2.2", "127.0.0.1", "localhost")
            val origin = api.buildUpon().apply { if (local) encodedAuthority("${api.host}:5189") }.encodedPath(relative.encodedPath).encodedQuery(relative.encodedQuery).fragment(null).build()
            require(origin.scheme == "https" || local)
            context.startActivity(Intent(Intent.ACTION_VIEW, origin).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { model.notify("The browser could not open this page. Reconnect to the configured website and sign in there.") }
    }, enabled = !model.offline) { Text(label) }
}
