package eu.funkyfarm.app

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/** No guide cache: changing the signed-in grant or farm removes the open instructions. */
@Composable internal fun LpisGuide(model: FarmModel, farm: JSONObject) {
    val session = model.session ?: return
    val workspace = session.getJSONObject("workspace"); val farmId = farm.getString("id")
    if (farm.text("workspace_id") != workspace.getString("id")) return
    workspace.optJSONArray("farm_ids")?.let { grants -> if ((0 until grants.length()).none { grants.optString(it) == farmId }) return }
    val binding = listOf(model.origin, session.getJSONObject("user").getString("id"), workspace.toString(), farmId, farm.getInt("revision"), farm.data().opt("country"), farm.data().opt("region"), farm.data().opt("reporting_year"), model.serverVersion).joinToString("|")
    key(binding) { FarmLpisGuide(model, farm, session) }
}

private fun checkedLpisGuide(value: JSONObject, farm: JSONObject): JSONObject {
    fun optional(record: JSONObject, field: String): Any = record.opt(field) ?: JSONObject.NULL
    require(value.getString("farm_id") == farm.getString("id") && value.getInt("farm_revision") == farm.getInt("revision") && listOf("country", "region", "reporting_year").all { optional(value, it) == optional(farm.data(), it) }) { "These instructions do not match this farm revision. Reload the farm before opening them again." }
    val coverage = value.getString("coverage"); val profiles = value.getJSONArray("profiles")
    require(coverage in listOf("documented_steps", "general_guidance_only") && (coverage == "documented_steps") == (profiles.length() > 0) && value.getString("definition_hash").matches(Regex("[0-9a-fA-F]{64}"))) { "The guide could not be read completely. No steps or file formats have been assumed." }
    value.getString("notice"); value.getString("checked_date")
    fun textList(values: JSONArray) { repeat(values.length()) { require(values.get(it) is String) } }
    repeat(profiles.length()) { index ->
        val profile = profiles.getJSONObject(index)
        require(profile.getString("id").isNotBlank() && optional(profile, "country") == optional(value, "country") && profile.opt("import_acceptance_verified") == false)
        profile.getString("title"); profile.getString("applies_to")
        val campaign = optional(profile, "campaign_year"); require(campaign === JSONObject.NULL || campaign is Int || campaign is Long)
        val steps = profile.getJSONArray("steps"); require(steps.length() > 0)
        repeat(steps.length()) { step -> steps.getJSONObject(step).getString("title"); steps.getJSONObject(step).getString("text") }
        listOf("authority_import_formats", "app_export_formats", "limits").forEach { textList(profile.getJSONArray(it)) }
        val sources = profile.getJSONArray("sources"); require(sources.length() > 0)
        repeat(sources.length()) { source -> val item = sources.getJSONObject(source); item.getString("title"); item.getString("url"); item.getString("edition") }
    }
    return value
}

@Composable private fun FarmLpisGuide(model: FarmModel, farm: JSONObject, owner: JSONObject) {
    var open by remember { mutableStateOf(false) }; var attempt by remember { mutableStateOf(0) }
    var guide by remember { mutableStateOf<JSONObject?>(null) }; var problem by remember { mutableStateOf("") }
    var task by remember { mutableStateOf("") }; var loading by remember { mutableStateOf(false) }
    LaunchedEffect(open, attempt) {
        guide = null; task = ""; problem = ""
        if (!open) return@LaunchedEffect
        loading = true
        try {
            val result = model.sourceRequest("/farms/${farm.getString("id")}/lpis-guide")
            if (model.session !== owner) throw CancellationException()
            guide = checkedLpisGuide(result, farm)
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    OutlinedButton(onClick = { open = !open; guide = null; task = "" }) { Text(if (open) "Hide official field-register guidance" else "How do I update the official field register?") }
    if (!open) return
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Check the exact task before leaving this farm. This guide does not change an official register, send an application or establish a deadline.")
        if (loading) Text("Opening the instructions for this farm…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        guide?.let { result ->
            Text("Country: ${result.text("country").ifBlank { "Not recorded" }} · Region: ${result.text("region").ifBlank { "Not recorded" }}")
            Text("Farm reporting year: ${result.opt("reporting_year").takeUnless { it === JSONObject.NULL } ?: "Not recorded"}")
            Text("A file's source year, this farm's reporting year and an official campaign year are separate. Check each in the actual file and official service; none is chosen automatically.")
            Text(result.getString("notice"))
            if (result.getString("coverage") == "general_guidance_only") {
                Text("Detailed steps are not yet known for this country", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text("Only a general official starting page is known. The exact LPIS task, drawing steps and accepted file formats are not established. Ask the authority or your adviser which process applies before uploading a file.")
                LpisOfficialLink(result.text("official_url"), "Open the official starting page")
            } else {
                val profiles = result.getJSONArray("profiles").objects()
                Choice("What do you need to do?", task, listOf("" to "Choose the actual task") + profiles.map { it.getString("id") to it.getString("title") }) { task = it }
                Text("Choose only the task described by the source. These instructions do not cover every map change or aid application.")
                val selected = profiles.find { it.getString("id") == task }
                if (selected == null) Text("Choose a task to see its documented steps and limits.")
                else {
                    Text(selected.getString("title"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(selected.getString("applies_to"))
                    val campaign = selected.opt("campaign_year").takeUnless { it == null || it === JSONObject.NULL }
                    Text("Campaign named by the source: ${campaign ?: "No specific campaign year stated"}")
                    if (campaign != null && campaign != result.opt("reporting_year")) Text("This source names a different campaign from the farm reporting year. Check the current official process before using it.", color = MaterialTheme.colorScheme.error)
                    LpisOfficialLink(selected.text("official_url"), "Open the official instructions for this task")
                    selected.getJSONArray("steps").objects().forEachIndexed { index, step -> Text("${index + 1}. ${step.getString("title")}", fontWeight = FontWeight.Bold); Text(step.getString("text")) }
                    Text("Files from this app", style = MaterialTheme.typography.titleSmall)
                    val exports = selected.getJSONArray("app_export_formats")
                    val names = mapOf("geojson" to "GeoJSON", "kml" to "KML", "correction" to "Change summary (JSON)")
                    Text(if (exports.length() == 0) "No private export formats are listed." else "Private working copies: " + (0 until exports.length()).joinToString(", ") { names[exports.getString(it)] ?: exports.getString(it) } + ". These are not official submissions.")
                    Text("Formats named by the official source", style = MaterialTheme.typography.titleSmall)
                    val formats = selected.getJSONArray("authority_import_formats")
                    if (formats.length() == 0) Text("Accepted import formats are not established for this task.")
                    repeat(formats.length()) { Text(formats.getString(it)) }
                    Text("Live import and acceptance have not been verified. A format name alone does not mean a particular file is accepted or anything has been sent.")
                    Text("What still needs checking", style = MaterialTheme.typography.titleSmall)
                    selected.getJSONArray("limits").let { limits -> repeat(limits.length()) { Text(limits.getString(it)) } }
                    Text("Sources and editions", style = MaterialTheme.typography.titleSmall)
                    selected.getJSONArray("sources").objects().forEach { source -> LpisOfficialLink(source.getString("url"), source.getString("title")); Text(source.getString("edition")) }
                }
            }
            Text("Guide inventory checked ${result.getString("checked_date")}. Check the current official instructions before acting. Keep any actual sending confirmation or reply separately.", style = MaterialTheme.typography.bodySmall)
        }
        OutlinedButton(onClick = { guide = null; task = ""; attempt++ }, enabled = !loading) { Text(if (problem.isBlank()) "Refresh these instructions" else "Try opening the guide again") }
    } }
}

@Composable private fun LpisOfficialLink(raw: String, label: String) {
    val context = LocalContext.current
    val safe = runCatching { URI(raw).takeIf { it.scheme == "https" && !it.host.isNullOrBlank() && it.rawUserInfo == null } }.getOrNull()
    var problem by remember(raw) { mutableStateOf("") }
    if (safe == null) Text("$label · official link unavailable")
    else OutlinedButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(safe.toASCIIString()))) }.onFailure { problem = "No browser could open this official page. No action has been sent." } }) { Text("$label · opens browser") }
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
}
