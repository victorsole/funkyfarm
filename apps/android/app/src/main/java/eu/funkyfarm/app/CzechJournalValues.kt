package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

private val czechLabels = mapOf("location_kind" to "Location type", "cadastral_area" to "Cadastral area", "dpb_square" to "LPIS DPB square", "dpb_code" to "LPIS DPB code", "cadastral_parcel_numbers" to "Cadastral parcel numbers", "lhc_code" to "Forest LHC code", "jprl" to "Forest JPRL reference", "oddeleni" to "Oddělení", "dilec" to "Dílec", "porost" to "Porost", "porostni_skupina" to "Porostní skupina", "object_type" to "Object type", "object_description" to "Precise object description", "subject_kind" to "Subject treated", "sown_area_ha" to "Sown or planted area · ha", "sowing_date" to "Actual sowing or planting date", "crop_end" to "Crop-growing end", "target_organism_or_purpose" to "Target organism or treatment purpose", "mixture" to "Mixture code", "efficacy" to "Efficacy", "original_numbers" to "Original numeric strings", "dose" to "Dose", "treated_size" to "Treated size", "quantity" to "Total quantity · optional", "status" to "Status", "date" to "Actual date", "value" to "Supplied value")

@Composable internal fun CzechValue(label: String, value: Any?) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        when (value) {
            is JSONObject -> value.keys().asSequence().forEach { key -> CzechValue(czechLabels[key] ?: key.replace('_', ' '), value.get(key)) }
            is JSONArray -> if (value.length() == 0) Text("No values recorded") else repeat(value.length()) { CzechValue("Item ${it + 1}", value.get(it)) }
            else -> SelectionContainer { Text(when { value == null || value === JSONObject.NULL -> "Not recorded"; value is String && value.isEmpty() -> "Blank supplied value"; else -> value.toString() }) }
        }
    }
}

@Composable internal fun CzechHolderValue(value: JSONObject) {
    Text("Recorded holder identity · not inferred from the farm name", style = MaterialTheme.typography.titleMedium)
    CzechValue("Holder type", when (value.text("kind")) { "natural_person" -> "Natural person"; "legal_person" -> "Legal person"; else -> null })
    CzechValue("Name as supplied", value.opt("name")); CzechValue("Business address as supplied", value.opt("address"))
    val identification = value.optJSONObject("identification_number")
    CzechValue("Identification number status", when (identification?.text("status")) { "provided" -> "Number supplied"; "not_assigned" -> "Not assigned · explicitly recorded"; else -> "Unknown · still unresolved" })
    if (identification?.text("status") == "provided") CzechValue("Identification number", identification.opt("value"))
    if (value.has("birth_date")) CzechValue("Actual birth date", value.get("birth_date"))
}

@Composable internal fun CzechJournalValue(data: JSONObject) {
    Text("One actual application · kept separate from other entries", style = MaterialTheme.typography.titleMedium)
    listOf("date" to "Actual application date", "crop" to "Crop, tree or other treated subject", "product" to "Full trade name", "dose_unit" to "Dose unit", "treated_unit" to "Treated-size unit", "unit" to "Total-quantity unit").forEach { (key, label) -> CzechValue(label, data.opt(key)) }
    val details = data.optJSONObject("cz_ppp") ?: JSONObject()
    val originals = details.optJSONObject("original_numbers") ?: JSONObject()
    listOf("dose", "treated_size", "quantity").forEach { key ->
        CzechValue(czechLabels.getValue(key) + " · original figure", if (originals.has(key)) originals.get(key) else data.opt(key))
        if (originals.has(key)) CzechValue(czechLabels.getValue(key) + " · stored number, no conversion", data.opt(key))
    }
    details.keys().asSequence().filter { it !in listOf("efficacy", "crop_end", "original_numbers") }.forEach { key -> CzechValue(czechLabels[key] ?: key.replace('_', ' '), if (key == "sown_area_ha" && originals.has(key)) originals.get(key) else details.get(key)) }
    if (originals.has("sown_area_ha")) CzechValue("Sown or planted area · stored ha number, no conversion", details.opt("sown_area_ha"))
    CzechFollowUp(details)
    if (data.has("supersedes_id")) CzechValue("Correction of original application", data.get("supersedes_id"))
    if (data.has("superseded_by")) CzechValue("Separately confirmed replacement", data.get("superseded_by"))
    data.keys().asSequence().filter { it !in listOf("farm_id", "pack_id", "sources", "cz_ppp", "date", "crop", "product", "dose", "dose_unit", "treated_size", "treated_unit", "quantity", "unit", "supersedes_id", "superseded_by") }.forEach { key -> CzechValue(key.replace('_', ' '), data.get(key)) }
    Text("Pending follow-up is not zero or a completed annual obligation. Manual journal preparation is not JUDPOR transmission or authority acceptance.", style = MaterialTheme.typography.bodySmall)
}

@Composable private fun CzechFollowUp(details: JSONObject) {
    val efficacy = details.optJSONObject("efficacy")
    CzechValue("Efficacy follow-up", when (efficacy?.text("status")) { "pending" -> "Pending · result not yet known"; "recorded" -> when (efficacy.text("value")) { "1" -> "Effective · 1"; "0" -> "Ineffective · 0"; else -> "Result missing · not treated as zero" }; else -> "Not recorded" })
    val end = details.optJSONObject("crop_end")
    CzechValue("Crop-growing end", when (end?.text("status")) { "pending" -> "Pending · actual end not established"; "not_applicable" -> "Not applicable · recorded tree or forest subject"; "recorded" -> end.text("date").takeIf(String::isNotBlank) ?: "Actual date missing"; else -> "Not recorded" })
}

@Composable internal fun RetainedCzechJournal(journal: JSONObject) {
    Text(journal.text("title"), style = MaterialTheme.typography.titleMedium)
    Text("Retained journal context · manual record preparation, not JUDPOR transmission")
    listOf("country", "reporting_year", "schema_id", "pack_id").forEach { if (journal.has(it)) CzechValue(it.replace('_', ' '), journal.get(it)) }
    journal.optJSONObject("source")?.let { source ->
        SourceReferences(JSONArray().put(source))
        listOf("sha256", "edition", "published_at", "checked_at", "source_type").forEach { if (source.has(it)) CzechValue("Source ${it.replace('_', ' ')}", source.get(it)) }
        listOf("url", "attachment_url").forEach { key -> (source.opt(key) as? String)?.takeIf { it.startsWith("https://") }?.let { OfficialSourceLink(it) } }
    }
    val entry = journal.getJSONObject("entry")
    CzechValue("Retained application identity", entry.opt("operation_id")); CzechValue("Retained application revision", entry.opt("operation_revision"))
    val values = entry.getJSONObject("values")
    val originals = entry.optJSONObject("original_numbers") ?: JSONObject()
    val columns = journal.getJSONArray("columns").objects()
    columns.forEach { column ->
        val key = column.getString("key")
        CzechValue(column.getString("label"), if (values.has(key)) values.get(key) else null)
        if (originals.has(key)) CzechValue("${column.getString("label")} · original supplied figure", originals.get(key))
        val unit = column.text("unit_field").takeIf(String::isNotBlank)?.let { values.opt(it) as? String }?.takeIf(String::isNotBlank) ?: (column.opt("unit") as? String)
        unit?.takeIf(String::isNotBlank)?.let { Text("Original unit: $it · no conversion applied", style = MaterialTheme.typography.bodySmall) }
        if (column.has("decimal_places")) Text("Source precision: ${column.getInt("decimal_places")} decimal places · no silent rounding", style = MaterialTheme.typography.bodySmall)
        if (column.optBoolean("optional")) Text("Optional source column", style = MaterialTheme.typography.bodySmall)
        column.text("conditional").takeIf(String::isNotBlank)?.let { condition -> Text("Source condition: " + when (condition) { "lpis_land" -> "LPIS land"; "other_land|object" -> "Other land or an object"; "forest" -> "Forest"; "object" -> "An object or facility"; "land" -> "Land, including forest"; "land excluding trees/forest" -> "Land excluding the recorded tree or forest subject"; else -> condition }, style = MaterialTheme.typography.bodySmall) }
    }
    values.keys().asSequence().filter { key -> columns.none { it.optString("key") == key } }.forEach { key -> CzechValue(czechLabels[key] ?: key.replace('_', ' '), values.get(key)) }
    entry.optJSONObject("data")?.optJSONObject("cz_ppp")?.let { CzechFollowUp(it) }
    entry.optJSONArray("issues")?.objects()?.forEach { Text(it.optString("message"), color = if (it.optString("severity") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
}
