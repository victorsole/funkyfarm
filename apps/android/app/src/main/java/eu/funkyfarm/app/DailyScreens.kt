@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
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
import java.math.BigDecimal
import java.time.LocalDate

private val workTypes = listOf(
    "fertiliser_application" to "Spread fertiliser", "pesticide_application" to "Applied a crop treatment",
    "irrigation" to "Irrigated a field", "harvest" to "Recorded a harvest", "work" to "Did some farm work",
    "observation" to "Noticed something", "purchase" to "Bought something", "sale" to "I sold something",
    "animal_birth" to "Animal birth", "animal_death" to "Animal death", "animal_purchase" to "Bought animals",
    "animal_sale" to "Animals leaving after a sale", "animal_movement" to "Moved animals", "animal_treatment" to "Treated animals"
)

@Composable internal fun RecordWorkHome(model: FarmModel, capture: (String) -> Unit, open: (Pair<String, String>) -> Unit) {
    Text("What happened on the farm?", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    Text("Start with the work you did. Check the date, amount and unit before saving it for review.")
    workTypes.filterNot { it.first.startsWith("animal_") }.forEach { type -> OutlinedButton(onClick = { capture(type.first) }, modifier = Modifier.fillMaxWidth()) { Text(type.second) } }
    var animals by remember { mutableStateOf(false) }
    TextButton(onClick = { animals = !animals }) { Text(if (animals) "Hide animal records" else "Record something about animals") }
    if (animals) {
        Text("Animal events track what happened to the animals. Record money received separately with I sold something.", style = MaterialTheme.typography.bodySmall)
        workTypes.filter { it.first.startsWith("animal_") }.forEach { type -> OutlinedButton(onClick = { capture(type.first) }, modifier = Modifier.fillMaxWidth()) { Text(type.second) } }
    }
    Text("Recent records", style = MaterialTheme.typography.titleLarge)
    val recent = (model.records["operations"].orEmpty() + model.records["purchases"].orEmpty() + model.records["sales"].orEmpty()).sortedByDescending { it.optString("created_at") }
    if (recent.isEmpty()) Text("Your saved work, purchases and sales will appear here.")
    recent.forEach { record -> Card(onClick = { open(record.optString("kind") to record.getString("id")) }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(record.title(), fontWeight = FontWeight.Bold); Text("${when (record.optString("kind")) { "sales" -> "Sale"; "purchases" -> "Purchase"; else -> "Farm work" }} · ${record.data().optString("date")} · ${when (record.data().optString("review_status")) { "confirmed" -> "Checked"; "rejected" -> "Rejected"; else -> "Waiting for review" }}") } } }
    listOf("operations", "purchases", "sales").forEach { kind -> if (model.records[kind].orEmpty().size < (model.totals[kind] ?: 0)) OutlinedButton(onClick = { model.loadMore(kind) }, enabled = !model.busy) { Text(when (kind) { "operations" -> "Load older work records"; "sales" -> "Load older sales"; else -> "Load older purchases" }) } }
}

@Composable internal fun FarmOnboarding(model: FarmModel, close: () -> Unit, handoff: (String) -> Unit) {
    val existing = model.records["farms"].orEmpty().firstOrNull()
    val key = "guided-onboarding:${existing?.optString("id") ?: "new"}"
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("name" to existing?.data()?.optString("name").orEmpty(), "country" to existing?.data()?.optString("country").orEmpty(), "region" to existing?.data()?.optString("region").orEmpty(), "farm_type" to existing?.data()?.optString("farm_type").orEmpty(), "reporting_year" to LocalDate.now().year, "start" to "details", "expected_revision" to existing?.optInt("revision")))) }
    fun update(name: String, value: Any) { draft = JSONObject(draft.toString()).put(name, value); model.saveDraft(key, draft) }
    var error by remember { mutableStateOf("") }
    Sheet("A good place to start", close) {
        Text("A few details help us ask useful questions. You can bring existing records or involve an adviser at any time.")
        OutlinedTextField(draft.optString("name"), { update("name", it) }, label = { Text("What is your farm called?") }, modifier = Modifier.fillMaxWidth())
        Choice("Where is the farm?", draft.optString("country"), euCountries) { update("country", it) }
        OutlinedTextField(draft.optString("region"), { update("region", it) }, label = { Text("Region or state") }, modifier = Modifier.fillMaxWidth())
        Choice("What kind of farm?", draft.optString("farm_type"), listOf("arable" to "Crops and arable", "livestock" to "Livestock", "mixed" to "Mixed farming", "horticulture" to "Fruit, vegetables and horticulture", "other" to "Something else")) { update("farm_type", it) }
        OutlinedTextField(draft.optString("reporting_year"), { update("reporting_year", it) }, label = { Text("Which year are you working on?") }, modifier = Modifier.fillMaxWidth())
        Choice("How would you like to begin?", draft.optString("start"), listOf("details" to "Start with the details I know", "imports" to "I already have records to bring in", "advisers" to "I work with an adviser")) { update("start", it) }
        val docs = model.records["documents"].orEmpty()
        val selected = remember(key) { mutableStateListOf<String>().apply { draft.optJSONArray("previous_document_ids")?.let { values -> repeat(values.length()) { add(values.getString(it)) } } } }
        if (docs.isNotEmpty()) {
            Text("Any documents you have already added?", style = MaterialTheme.typography.titleMedium)
            docs.take(30).forEach { doc -> Row { Checkbox(doc.getString("id") in selected, { checked -> if (checked) selected.add(doc.getString("id")) else selected.remove(doc.getString("id")); update("previous_document_ids", JSONArray(selected)) }); Text(doc.title(), Modifier.weight(1f).padding(top = 12.dp)) } }
            Text("Attaching a document does not confirm its contents.", style = MaterialTheme.typography.bodySmall)
        }
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        Button(onClick = {
            runCatching {
                val year = draft.optString("reporting_year").toInt(); require(year in 1900..2200)
                require(draft.optString("name").isNotBlank() && draft.optString("country").isNotBlank() && draft.optString("farm_type").isNotBlank()) { "Add the farm name, country and type before continuing." }
                val body = obj("name" to draft.optString("name"), "country" to draft.optString("country"), "region" to draft.optString("region"), "farm_type" to draft.optString("farm_type"), "reporting_year" to year, "previous_document_ids" to JSONArray(selected))
                if (existing != null) body.put("farm_id", existing.getString("id")).put("expected_revision", draft.getInt("expected_revision"))
                model.enqueue("/workflow/onboard", body, draftKey = key)
                if (draft.optString("start") in listOf("imports", "advisers")) handoff(draft.optString("start")) else close()
            }.onFailure { error = it.message ?: "Check these details." }
        }, enabled = !model.busy) { Text("Save my farm details") }
        Text("Your draft stays encrypted on this device if you lose connection. You decide when it is sent.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable internal fun GuidedCapture(model: FarmModel, type: String, record: JSONObject? = null, close: () -> Unit) {
    val kind = when (type) { "purchase" -> "purchases"; "sale" -> "sales"; else -> "operations" }
    val financial = kind in listOf("purchases", "sales")
    val key = "guided-capture:$type" + (record?.optString("id")?.let { ":edit:$it" } ?: "")
    val firstFarm = model.records["farms"].orEmpty().singleOrNull()
    val initial = if (record != null) JSONObject(record.data().toString()).put("expected_revision", record.getInt("revision")) else obj("farm_id" to firstFarm?.optString("id").orEmpty(), "title" to workTypes.find { it.first == type }?.second.orEmpty(), "date" to LocalDate.now().toString(), "unit" to "", "currency" to "EUR", "credit" to false)
    var draft by remember(key) { mutableStateOf(model.draft(key, initial)) }
    var acknowledged by remember { mutableStateOf<Set<String>>(emptySet()) }
    var error by remember { mutableStateOf("") }
    fun update(name: String, value: Any) {
        draft = JSONObject(draft.toString()).apply {
            if (name == "farm_id" && opt("farm_id") != value) { put("parcel_id", JSONObject.NULL); remove("parcel"); remove("field_id"); remove("group_id") }
            put(name, value)
        }
        model.saveDraft(key, draft); model.clearCheck(key); acknowledged = emptySet()
    }
    fun body(): JSONObject {
        require(draft.optString("farm_id").isNotBlank()) { "Choose your farm." }; LocalDate.parse(draft.optString("date"))
        val data = obj("farm_id" to draft.getString("farm_id"), "title" to draft.optString("title"), "date" to draft.optString("date"), "temporal_basis" to "calendar_date", "period" to draft.optString("date"), "notes" to draft.optString("notes"))
        require(data.optString("title").isNotBlank()) { "Give this record a short name." }
        if (kind == "operations") data.put("type", type) else data.put("category", draft.optString("category")).put("currency", draft.optString("currency"))
        val numericFields = if (financial) listOf("quantity", "amount", "tax_amount", "tax_rate") else listOf("quantity", "hours")
        numericFields.forEach { name -> if (draft.optString(name).isNotBlank() && draft.opt(name) != JSONObject.NULL) { val raw = draft.getString(name); require(raw.matches(Regex("[+-]?\\d+(?:[.,]\\d+)?"))) { "Enter the number without thousands separators." }; data.put(name, raw) } else if (record?.data()?.has(name) == true) data.put(name, JSONObject.NULL) }
        if (draft.optString("quantity").isNotBlank() && draft.opt("quantity") != JSONObject.NULL) { require(draft.optString("unit").isNotBlank()) { "Choose the unit printed on your source." }; data.put("unit", draft.getString("unit")) } else if (record != null) data.put("unit", draft.optString("unit").takeUnless { it == "null" }?.ifBlank { null } ?: JSONObject.NULL)
        val referenceFields = if (financial) listOf("document_id", "invoice_number", if (kind == "sales") "buyer" else "supplier") else listOf("parcel_id", "document_id", "product", "operator")
        referenceFields.forEach { name -> if (draft.optString(name).isNotBlank() && draft.opt(name) != JSONObject.NULL) data.put(name, draft.getString(name)) else if (record != null && draft.has(name)) data.put(name, if (name in listOf("document_id", "parcel_id") || draft.opt(name) == JSONObject.NULL) JSONObject.NULL else "") }
        if (financial) data.put("credit", draft.optBoolean("credit"))
        if (type == "pesticide_application") appendTreatmentDetails(data, draft)
        return obj("kind" to kind, "data" to data).apply { if (record != null) put("record_id", record.getString("id")).put("expected_revision", draft.getInt("expected_revision")) }
    }
    Sheet(workTypes.find { it.first == type }?.second ?: "Record farm work", close) {
        Choice("Which farm?", draft.optString("farm_id"), model.records["farms"].orEmpty().map { it.getString("id") to it.title() }) { update("farm_id", it) }
        if (record != null) Text("This saved edit keeps revision ${draft.getInt("expected_revision")}. The service checks it again before changing the proposal.", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(draft.optString("date"), { update("date", it) }, label = { Text(if (kind == "sales") "Actual sale date · YYYY-MM-DD" else "When did it happen? · YYYY-MM-DD") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(draft.optString("title"), { update("title", it) }, label = { Text("A short name for this record") }, modifier = Modifier.fillMaxWidth())
        if (kind == "operations") {
            val farm = model.records["farms"].orEmpty().find { it.optString("id") == draft.optString("farm_id") }
            val parcels = farm?.data()?.optJSONArray("parcels")?.objects().orEmpty().filter { it.optString("id").isNotBlank() && it.opt("active") != false }
            Choice("Which field? · optional", draft.optString("parcel_id"), listOf("" to "Whole farm / no field selected") + parcels.map { it.optString("id") to it.optString("name") }) { update("parcel_id", it) }
        }
        OutlinedTextField(draft.optString("quantity"), { update("quantity", it) }, label = { Text(if (type.startsWith("animal_")) "How many animals?" else if (financial) "Quantity printed on the source · optional" else "How much? · optional") }, modifier = Modifier.fillMaxWidth())
        Choice("Unit as recorded on the source", draft.optString("unit"), listOf("kg" to "Kilograms · kg", "g" to "Grams · g", "t" to "Tonnes · t", "L" to "Litres · L", "mL" to "Millilitres · mL", "m3" to "Cubic metres · m³", "ha" to "Hectares · ha", "animals" to "Animals", "units" to "Items / units")) { update("unit", it) }
        OutlinedTextField(draft.optString("unit"), { update("unit", it) }, label = { Text("Or enter the unit exactly as written") }, modifier = Modifier.fillMaxWidth())
        Text(if (financial) "Keep the supplied quantity and unit. No conversion or tax calculation is applied." else if (type == "pesticide_application") "No unit conversion is applied. Keep the actual dose and treated size separately in the treatment details below." else "No unit conversion is applied. Keep rates and actual quantities distinct in the source notes.", style = MaterialTheme.typography.bodySmall)
        if (financial) {
            OutlinedTextField(draft.optString("category"), { update("category", it) }, label = { Text(if (kind == "sales") "What was sold? · category" else "What was bought? · category") }, modifier = Modifier.fillMaxWidth())
            val party = if (kind == "sales") "buyer" else "supplier"
            OutlinedTextField(draft.optString(party), { update(party, it) }, label = { Text(if (kind == "sales") "Buyer · if supplied" else "Supplier · if supplied") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(draft.optString("invoice_number"), { update("invoice_number", it) }, label = { Text("Invoice or receipt reference · optional") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(draft.optString("amount"), { update("amount", it) }, label = { Text(if (kind == "sales") "Amount received · printed total" else "Amount on the receipt · printed total") }, modifier = Modifier.fillMaxWidth())
            Choice("Currency printed on the source", draft.optString("currency"), listOf("EUR", "BGN", "CZK", "DKK", "HUF", "PLN", "RON", "SEK").map { it to it }) { update("currency", it) }
            OutlinedTextField(draft.optString("currency"), { update("currency", it) }, label = { Text("Printed currency code · e.g. EUR or USD") }, modifier = Modifier.fillMaxWidth())
            Row { Checkbox(draft.optBoolean("credit"), { update("credit", it) }); Text("This is a credit or refund", Modifier.weight(1f).padding(top = 12.dp)) }
            var taxDetails by remember(key) { mutableStateOf(draft.optString("tax_amount").isNotBlank() || draft.optString("tax_rate").isNotBlank()) }
            TextButton(onClick = { taxDetails = !taxDetails }) { Text(if (taxDetails) "Hide printed tax details" else "Add tax details printed on the source") }
            if (taxDetails) {
                OutlinedTextField(draft.optString("tax_amount"), { update("tax_amount", it) }, label = { Text("Tax amount exactly as printed · optional") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(draft.optString("tax_rate"), { update("tax_rate", it) }, label = { Text("Tax rate exactly as printed · optional") }, modifier = Modifier.fillMaxWidth())
                Text("These are supplied source figures, not calculated tax or a tax-return assessment.", style = MaterialTheme.typography.bodySmall)
            }
        } else {
            if (type in listOf("fertiliser_application", "pesticide_application", "animal_treatment")) OutlinedTextField(draft.optString("product"), { update("product", it) }, label = { Text("Product as printed on its label") }, modifier = Modifier.fillMaxWidth())
            if (type == "work") OutlinedTextField(draft.optString("hours"), { update("hours", it) }, label = { Text("Time spent · hours") }, modifier = Modifier.fillMaxWidth())
            if (type == "pesticide_application") CropTreatmentDetails(draft, ::update)
        }
        Choice("Supporting document · optional", draft.optString("document_id"), listOf("" to "No document selected") + model.records["documents"].orEmpty().map { it.getString("id") to it.title() }) { update("document_id", it) }
        if (financial) Text("Choose the document that supports this purchase or sale. Its contents do not determine the transaction direction or fill in the buyer, date or amount.", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(draft.optString("notes"), { update("notes", it) }, label = { Text(if (type.startsWith("animal_")) "Animal/group identifier, locations and details" else "Anything else to keep with this record?") }, modifier = Modifier.fillMaxWidth().heightIn(min = 100.dp))
        Text("Saved here as you type. Checking asks the service about missing details, units and possible duplicates. Nothing is confirmed automatically.")
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { runCatching { model.checkCapture(key, body()) }.onFailure { error = it.message ?: "Check these details." } }, enabled = !model.busy) { Text("Check this record") }
        val checked = model.extras["check:$key"]?.optJSONObject("result")
        if (checked != null) {
            checked.optJSONArray("issues")?.objects()?.forEach { issue -> Text(issue.optString("message"), color = if (issue.optString("severity") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
            val required = checked.optJSONArray("requires_acknowledgement")?.let { values -> (0 until values.length()).map { values.getString(it) } }.orEmpty()
            required.forEach { code -> val issue = checked.optJSONArray("issues")?.objects()?.find { it.optString("code") == code }; Row { Checkbox(code in acknowledged, { selected -> acknowledged = if (selected) acknowledged + code else acknowledged - code }); Text(issue?.optString("message") ?: code.replace('_', ' '), Modifier.weight(1f).padding(top = 12.dp)) } }
            Button(onClick = { runCatching { model.submitCapture(key, body(), acknowledged.toList()); close() }.onFailure { error = it.message ?: "Check this record again." } }, enabled = checked.optBoolean("can_save") && required.all { it in acknowledged } && !model.busy) { Text("Save this record for review") }
        }
        TextButton(onClick = { model.deleteDraft(key); model.clearCheck(key); close() }) { Text(if (record != null) "Discard this device edit" else "Discard this device draft") }
        if (record != null) Text("If the server record changed, discard this device edit and refresh the record before starting again. Your pending delivery is managed separately in Account.", style = MaterialTheme.typography.bodySmall)
    }
}

internal fun countryOptions(): List<Pair<String, String>> = euCountries

@Composable internal fun Choice(label: String, selected: String, options: List<Pair<String, String>>, change: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column { Text(label, style = MaterialTheme.typography.labelLarge); Box { OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) { Text(options.find { it.first == selected }?.second ?: "Choose an option") }; DropdownMenu(expanded, { expanded = false }) { options.forEach { (id, title) -> DropdownMenuItem(text = { Text(title) }, onClick = { expanded = false; change(id) }) } } } }
}

private val euCountries = listOf("AT" to "Austria", "BE" to "Belgium", "BG" to "Bulgaria", "HR" to "Croatia", "CY" to "Cyprus", "CZ" to "Czechia", "DK" to "Denmark", "EE" to "Estonia", "FI" to "Finland", "FR" to "France", "DE" to "Germany", "GR" to "Greece", "HU" to "Hungary", "IE" to "Ireland", "IT" to "Italy", "LV" to "Latvia", "LT" to "Lithuania", "LU" to "Luxembourg", "MT" to "Malta", "NL" to "Netherlands", "PL" to "Poland", "PT" to "Portugal", "RO" to "Romania", "SK" to "Slovakia", "SI" to "Slovenia", "ES" to "Spain", "SE" to "Sweden")
