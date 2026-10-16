package eu.funkyfarmers.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

@Composable internal fun RegulatoryScreen(model: FarmModel, farm: JSONObject, close: () -> Unit) {
    val id = farm.getString("id"); val key = "regulatory:$id"
    LaunchedEffect(id, model.serverVersion) { model.loadExtra(key, "/regulatory/updates?farm_id=$id") }
    val response = model.extras[key]
    var preferences by remember { mutableStateOf(false) }
    fun savePreferences(enabled: Boolean, families: List<String>, read: List<String>) {
        val saved = response?.getJSONObject("preferences") ?: return
        model.enqueue("/regulatory/preferences", obj("farm_id" to id, "expected_revision" to saved.getInt("revision"), "enabled" to enabled, "families" to JSONArray(families), "read_event_ids" to JSONArray(read)))
    }
    Sheet("Official page changes", close) {
        AdministrationStatus(model)
        Text(farm.title(), style = MaterialTheme.typography.titleLarge)
        Text("A changed page is a reason to check the source. It is not automatically a new rule, an established deadline or a reviewed legal requirement.")
        OutlinedButton(onClick = { model.loadExtra(key, "/regulatory/updates?farm_id=$id") }, enabled = !model.busy) { Text("Refresh observations") }
        if (key in model.privateUnavailable) Text("Updates for this farm are not available to your account.")
        else if (response == null) Text("Connect to load observations and your in-app preferences.")
        else {
            if (response.optString("notice").isNotBlank()) Text(response.optString("notice"), style = MaterialTheme.typography.bodySmall)
            response.optJSONObject("monitor")?.let { monitor ->
                Text(if (monitor.optBoolean("enabled")) "Source checks are enabled" else "Source checks are not enabled", style = MaterialTheme.typography.titleMedium)
                val checked = monitor.opt("last_checked_at").takeUnless { it == JSONObject.NULL }?.toString()
                if (checked != null) Text("Last recorded source check: $checked", style = MaterialTheme.typography.bodySmall)
                if (monitor.optInt("error_count") > 0) Text("Some sources could not be checked. Open the original and ask for help if the requirement is unclear.")
            }
            TextButton(onClick = { preferences = true }) { Text("Choose which updates appear here") }
            val items = response.optJSONArray("items")?.objects().orEmpty()
            if (items.isEmpty()) Text("No changed-page observations were returned for this selection. This does not establish that all applicable rules are unchanged.")
            val saved = response.getJSONObject("preferences")
            val read = saved.optJSONArray("read_event_ids").strings()
            val families = saved.optJSONArray("families").strings()
            items.forEach { update -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text(update.optString("title"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(if (update.optBoolean("is_read")) "Read · legal effect still needs review" else "New page observation · not reviewed as a legal change")
                update.optString("required_action").takeIf { it.isNotBlank() }?.let { Text(it) }
                update.optString("relevance").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                val effective = update.opt("effective_date").takeUnless { it == JSONObject.NULL }?.toString()
                Text(if (effective == null) "Effective date not established" else "Reported effective date: $effective · verify the requirement")
                update.optString("source_edition").takeIf { it.isNotBlank() && it != "null" }?.let { Text("Source edition: $it", style = MaterialTheme.typography.bodySmall) }
                update.optString("url").takeIf { it.startsWith("https://") }?.let { OfficialSourceLink(it) }
                if (!update.optBoolean("is_read")) OutlinedButton(onClick = { savePreferences(saved.optBoolean("enabled", true), families, (read + update.getString("id")).distinct()) }, enabled = !model.busy) { Text("Mark this observation as read") }
                update.optString("notice").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            } } }
        }
    }
    if (preferences && response != null) {
        val saved = response.getJSONObject("preferences")
        val draftKey = "regulatory-preferences:$id:${saved.getInt("revision")}" 
        var draft by remember(draftKey) { mutableStateOf(model.draft(draftKey, JSONObject(saved.toString()))) }
        Sheet("Updates shown in this app", { preferences = false }) {
            Text("These preferences control in-app observations. They do not enable push messages or establish legal review.")
            Row { Checkbox(draft.optBoolean("enabled", true), { draft = JSONObject(draft.toString()).put("enabled", it); model.saveDraft(draftKey, draft) }); Text("Show source-change observations for this farm", Modifier.weight(1f).padding(top = 12.dp)) }
            val chosen = draft.optJSONArray("families").strings()
            Text("An empty selection keeps all supported topics.", style = MaterialTheme.typography.bodySmall)
            listOf("annual" to "Annual farm paperwork", "cap" to "CAP preparation", "inputs" to "Input and application records", "inspection" to "Inspection preparation", "sustainability" to "Sustainability schemes").forEach { (value, label) -> Row { Checkbox(value in chosen, { checked -> draft = JSONObject(draft.toString()).put("families", JSONArray(if (checked) chosen + value else chosen - value)); model.saveDraft(draftKey, draft) }); Text(label, Modifier.weight(1f).padding(top = 12.dp)) } }
            Button(onClick = { savePreferences(draft.optBoolean("enabled", true), chosen, saved.optJSONArray("read_event_ids").strings()); preferences = false }, enabled = !model.busy) { Text("Save these preferences") }
        }
    }
}

internal fun JSONArray?.strings(): List<String> = this?.let { array -> (0 until array.length()).map { array.getString(it) } }.orEmpty()
