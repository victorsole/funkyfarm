package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.time.LocalDate

internal const val CZECH_JOURNAL_PACK = "cz-ppp-journal-2026"
internal const val CZECH_HOLDER_KEY = "cz.ppp.holder"
internal val czechLiteralKeyboardOptions = KeyboardOptions(autoCorrectEnabled = false)
internal fun JSONObject.text(key: String): String = opt(key).takeUnless { it === JSONObject.NULL }?.toString().orEmpty()

@Composable internal fun CzechJournalDetails(draft: JSONObject, update: (String, Any) -> Unit) {
    val details = draft.optJSONObject("cz_ppp") ?: JSONObject()
    fun change(key: String, value: Any) { update("cz_ppp", JSONObject(details.toString()).put(key, value)) }
    Text("Czech crop-protection journal", style = MaterialTheme.typography.titleLarge)
    Text("One actual application per entry. The same field and date can have several applications. These details prepare a manual record; they do not send anything to JUDPOR or establish permission to use a product.")
    Choice("Location recorded for this application", details.text("location_kind"), listOf("" to "Choose the actual location type", "lpis_land" to "Land registered in LPIS", "other_land" to "Other land", "forest" to "Forest", "object" to "Object, building or facility")) { value ->
        val copy = JSONObject(details.toString())
        listOf("dpb_square", "dpb_code", "cadastral_parcel_numbers", "lhc_code", "jprl", "object_type", "object_description").forEach { copy.remove(it) }
        copy.put("location_kind", value)
        if (value == "object") { copy.remove("sowing_date"); copy.remove("sown_area_ha"); copy.remove("crop_end") }
        update("cz_ppp", copy)
    }
    if (details.text("location_kind").isNotBlank()) OutlinedTextField(details.text("cadastral_area"), { change("cadastral_area", it) }, label = { Text("Cadastral area exactly as recorded") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
    when (details.text("location_kind")) {
        "lpis_land" -> {
            OutlinedTextField(details.text("dpb_square"), { change("dpb_square", it) }, label = { Text("LPIS DPB square · exact reference") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(details.text("dpb_code"), { change("dpb_code", it) }, label = { Text("LPIS DPB code · exact reference") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
        }
        "other_land", "object" -> OutlinedTextField(details.optJSONArray("cadastral_parcel_numbers").strings().joinToString("\n"), { change("cadastral_parcel_numbers", JSONArray(it.split('\n').filter(String::isNotBlank))) }, label = { Text("Cadastral parcel numbers · one exact identifier per line") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth().heightIn(min = 90.dp))
        "forest" -> {
            OutlinedTextField(details.text("lhc_code"), { change("lhc_code", it) }, label = { Text("Forest LHC code") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
            listOf("oddeleni" to "JPRL · oddělení", "dilec" to "JPRL · dílec", "porost" to "JPRL · porost", "porostni_skupina" to "JPRL · porostní skupina").forEach { (key, label) ->
                OutlinedTextField(details.optJSONObject("jprl")?.text(key).orEmpty(), { value -> change("jprl", JSONObject((details.optJSONObject("jprl") ?: JSONObject()).toString()).put(key, value)) }, label = { Text(label) }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
            }
        }
    }
    if (details.text("location_kind") == "object") {
        OutlinedTextField(details.text("object_type"), { change("object_type", it) }, label = { Text("Object or facility type") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(details.text("object_description"), { change("object_description", it) }, label = { Text("Precise object or facility description") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
    }
    Choice("Subject treated", details.text("subject_kind"), listOf("" to "Choose what was actually treated", "crop" to "Crop or crop product", "tree" to "Trees", "forest" to "Forest stand", "other" to "Other subject")) { value ->
        val copy = JSONObject(details.toString()).put("subject_kind", value)
        if (value in listOf("tree", "forest")) { copy.remove("sowing_date"); copy.remove("crop_end") }
        else if (copy.optJSONObject("crop_end")?.text("status") == "not_applicable") copy.remove("crop_end")
        update("cz_ppp", copy)
    }
    if (details.text("location_kind") != "object") OutlinedTextField(draft.text("_cz_sown_area"), { update("_cz_sown_area", it) }, label = { Text("Sown or planted area · original ha figure, up to 2 decimals") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
    val subjectExempt = details.text("subject_kind") in listOf("tree", "forest")
    val objectLocation = details.text("location_kind") == "object"
    if (!subjectExempt && !objectLocation) OutlinedTextField(details.text("sowing_date"), { change("sowing_date", it) }, label = { Text("Actual sowing or planting date · YYYY-MM-DD") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
    else Text(if (subjectExempt) "Sowing and crop-end dates do not apply to the recorded tree or forest subject. Record the exemption below; do not invent dates." else "Sowing and crop-end dates are not required for an object. Leave the optional follow-up unspecified unless you actually recorded it.")
    val end = details.optJSONObject("crop_end") ?: JSONObject()
    Choice(if (objectLocation && !subjectExempt) "Crop-growing end · optional for an object" else "Crop-growing end", end.text("status"), listOf("" to "Not yet specified") + if (subjectExempt) listOf("not_applicable" to "Not applicable · tree or forest subject") else listOf("pending" to "Pending · crop has not ended or date not known", "recorded" to "Actual end date recorded")) { change("crop_end", obj("status" to it)) }
    if (end.text("status") == "recorded") OutlinedTextField(end.text("date"), { change("crop_end", JSONObject(end.toString()).put("date", it)) }, label = { Text("Actual crop-growing end date · YYYY-MM-DD") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(details.text("target_organism_or_purpose"), { change("target_organism_or_purpose", it) }, label = { Text("Target organism or actual treatment purpose") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
    Choice("Mixture recorded for this application", details.text("mixture"), listOf("" to "Not recorded", "S" to "Single product · S", "TM" to "Tank mixture · TM")) { change("mixture", it) }
    val efficacy = details.optJSONObject("efficacy") ?: JSONObject()
    Choice("Efficacy follow-up", efficacy.text("status"), listOf("" to "Not yet specified", "pending" to "Pending · result not yet known", "recorded" to "Result actually observed")) { change("efficacy", obj("status" to it)) }
    if (efficacy.text("status") == "recorded") Choice("Actual efficacy result", efficacy.text("value"), listOf("" to "Choose the observed result", "1" to "Effective · 1", "0" to "Ineffective · 0")) { selected -> change("efficacy", JSONObject(efficacy.toString()).apply { if (selected.isBlank()) remove("value") else put("value", selected.toInt()) }) }
    Text("Keep actual dose and treated size in the treatment details above. Dose supports 3 decimals; treated size and sown area support 2. Original comma/dot strings are retained, with no rounding or unit conversion. Pending follow-up is not a completed annual obligation.", style = MaterialTheme.typography.bodySmall)
}

internal fun appendCzechJournal(data: JSONObject, draft: JSONObject) {
    val details = JSONObject((draft.optJSONObject("cz_ppp") ?: JSONObject()).toString())
    listOf("location_kind", "subject_kind", "mixture").forEach { if (details.text(it).isBlank()) details.remove(it) }
    listOf("crop_end", "efficacy").forEach { if (details.optJSONObject(it)?.text("status").isNullOrBlank()) details.remove(it) }
    val originals = JSONObject()
    listOf("dose", "treated_size", "quantity").forEach { key -> if (draft.text(key).isNotBlank()) originals.put(key, draft.text(key)) }
    val sown = draft.text("_cz_sown_area")
    if (details.text("location_kind") != "object" && sown.isNotBlank()) {
        require(sown.matches(Regex("[+]?\\d+(?:[.,]\\d+)?"))) { "Enter the supplied sown area without thousands separators." }
        val number = BigDecimal(sown.replace(',', '.'))
        require(number.signum() >= 0 && number.stripTrailingZeros().scale() <= 2) { "Sown area supports 2 decimals. Keep the actual source figure; do not round it silently." }
        details.put("sown_area_ha", number); originals.put("sown_area_ha", sown)
    } else details.remove("sown_area_ha")
    if (details.text("sowing_date").isNotBlank()) LocalDate.parse(details.getString("sowing_date")) else details.remove("sowing_date")
    details.optJSONObject("crop_end")?.let { end -> if (end.text("status") == "recorded") { if (end.text("date").isNotBlank()) LocalDate.parse(end.getString("date")) else end.remove("date") } else end.remove("date") }
    details.optJSONObject("efficacy")?.let { if (it.text("status") != "recorded") it.remove("value") }
    details.put("original_numbers", originals)
    data.put("cz_ppp", details).put("review_status", "proposed")
}

internal fun restoreCzechOriginals(draft: JSONObject): JSONObject = draft.apply {
    optJSONObject("cz_ppp")?.let { details ->
        details.optJSONObject("original_numbers")?.let { originals -> listOf("dose", "treated_size", "quantity").forEach { key -> if (originals.opt(key) is String) put(key, originals.getString(key)) } }
        put("_cz_sown_area", details.optJSONObject("original_numbers")?.text("sown_area_ha")?.takeIf(String::isNotBlank) ?: details.text("sown_area_ha"))
    }
}
