package eu.funkyfarmers.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable internal fun SupportHandoff(model: FarmModel, section: String, close: () -> Unit) {
    val farms = model.records["farms"].orEmpty()
    var farmId by remember(section) { mutableStateOf(farms.firstOrNull()?.optString("id").orEmpty()) }
    val farm = farms.find { it.optString("id") == farmId }
    val country = farm?.data()?.optString("country").orEmpty()
    val capabilitiesKey = "capabilities:$country"
    LaunchedEffect(section, country) {
        if (section == "connections" && country.isNotBlank()) {
            model.loadExtra(capabilitiesKey, "/connections/capabilities?country=$country")
            model.loadExtra("connections:$farmId", "/connections?farm_id=$farmId")
        }
    }
    Sheet(when (section) { "imports" -> "Bring your existing records"; "advisers" -> "Work with an adviser"; else -> "Country forms and connections" }, close) {
        when (section) {
            "imports" -> {
                Text("Use the website to bring in work records, purchases or sales from your other farm software. It gives you room to compare columns, source units and proposed matches before saving anything.")
                Text("You can add photos, PDFs and notes directly in Documents here. A file import stays a proposal until you check its values.")
                Button(onClick = { model.tab = "Documents"; close() }) { Text("Add a document in this app") }
                WebLink(model, "/app/imports", "Open file imports on the website")
                Text("This continues in your browser. Sign in there if asked. The full import mapping editor is available on the website.", style = MaterialTheme.typography.bodySmall)
            }
            "advisers" -> {
                Text("Invite an adviser to help with selected farm records, or review an invitation you received. Your farm stays in its own private workspace.")
                Text("The website lets you check the person, permissions and farm scope before granting access. Nothing is shared just by opening it.")
                WebLink(model, "/app/advisers", "Open adviser access on the website")
                Text("Adviser invitations and portfolio management continue in your browser. They are not a complete native feature in this app.", style = MaterialTheme.typography.bodySmall)
            }
            else -> {
                if (farms.isEmpty()) Text("Add your farm and country first so the available routes match it.")
                else Choice("Which farm?", farmId, farms.map { it.getString("id") to it.title() }) { farmId = it }
                Text("See what a connection actually supports before setting it up. A national API or a prepared file does not mean automatic filing is available.")
                model.extras[capabilitiesKey]?.optString("notice")?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                val capabilities = model.extras[capabilitiesKey]?.optJSONArray("items")?.objects().orEmpty()
                capabilities.forEach { capability -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(capability.optString("title"), fontWeight = FontWeight.Bold)
                    Text(if (capability.optBoolean("live_read")) "Public data can be read after setup." else "Manual authority-portal handoff.")
                    if (!capability.optBoolean("automatic_filing")) Text("Nothing is filed automatically.")
                    capability.optJSONArray("setup_requirements")?.let { values -> repeat(values.length()) { Text(values.optString(it)) } }
                    capability.optJSONArray("limitations")?.let { values -> repeat(values.length()) { Text(values.optString(it), style = MaterialTheme.typography.bodySmall) } }
                } } }
                val configured = model.extras["connections:$farmId"]?.optJSONArray("items")?.objects().orEmpty()
                if (configured.isNotEmpty()) Text("Routes already saved for this farm", style = MaterialTheme.typography.titleMedium)
                configured.forEach { connection -> Text("${connection.title()} · ${connection.data().optString("status").replace('_', ' ')}") }
                if (farmId.isNotBlank()) WebLink(model, "/app/connections?farm_id=$farmId", "Review connection setup on the website")
                Text("Connection credentials, report comparison and the final handoff are handled on the website. You review them there; opening the page shares no authority credentials or reports.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
