@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package eu.funkyfarmers.app

import android.graphics.BitmapFactory
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.time.LocalDate

private val Green = Color(0xFF285840)
private val Ink = Color(0xFF24312B)
private val Paper = Color(0xFFF8F6EE)
private val Lilac = Color(0xFFE5DDF0)
private val tabs = listOf("Home", "Record work", "My fields", "Paperwork", "Documents")

@Composable fun FarmerApp(model: FarmModel, chooseFiles: () -> Unit, camera: () -> Unit, assemble: () -> Unit, share: (ByteArray, String, String) -> Unit) {
    MaterialTheme(colorScheme = lightColorScheme(primary = Green, onPrimary = Color.White, background = Paper, surface = Paper, onSurface = Ink, secondaryContainer = Lilac)) {
        var account by remember { mutableStateOf(false) }
        var editor by remember { mutableStateOf<Pair<String, JSONObject?>?>(null) }
        var note by remember { mutableStateOf(false) }
        var confirmLogout by remember { mutableStateOf(false) }
        var onboarding by remember { mutableStateOf(false) }
        var capture by remember { mutableStateOf<String?>(null) }
        var reports by remember { mutableStateOf(false) }
        var support by remember { mutableStateOf<String?>(null) }
        var questions by remember { mutableStateOf<JSONObject?>(null) }
        val session = model.session
        if (session == null) { Login(model); return@MaterialTheme }
        BackHandler(model.detail != null) { model.detail = null }
        Scaffold(
            topBar = { TopAppBar(title = { Column { Text("Funky Farmers", fontWeight = FontWeight.Bold); Text("A little less paperwork.", style = MaterialTheme.typography.labelSmall) } }, navigationIcon = { if (model.detail != null) TextButton(onClick = { model.detail = null }) { Text("Back") } }, actions = { TextButton(onClick = { account = true }) { Text("Account") } }) },
            bottomBar = { NavigationBar(containerColor = Paper) { tabs.forEachIndexed { index, tab -> NavigationBarItem(selected = model.tab == tab, onClick = { model.tab = tab; model.detail = null }, icon = { Text(listOf("⌂", "≡", "▤", "◇", "▥")[index], style = MaterialTheme.typography.titleLarge) }, label = { Text(tab, maxLines = 2) }, alwaysShowLabel = true) } } }
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                if (model.busy) WorkingIndicator()
                if (model.offline) Notice("Saved copy · offline / service unavailable")
                if (model.message.isNotEmpty()) Row(Modifier.fillMaxWidth().background(Lilac).padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) { Text(model.message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall); TextButton(onClick = { model.notify("") }) { Text("Dismiss") } }
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (model.detail != null) {
                        val route = model.detail!!
                        val item = model.item
                        if (item == null) { Heading("Opening record"); Text("This record is loaded only after workspace authorization."); OutlinedButton(onClick = { model.open(route.first, route.second) }) { Text("Try again") } }
                        else RecordDetail(model, route.first, item, { editor = route.first to item }, share)
                    } else if (model.tab == "Home") {
                        Heading("A little less to keep in your head.")
                        Text("Keep today's work together. See what needs a check before the next deadline.", style = MaterialTheme.typography.bodyLarge)
                        if (model.records["farms"].isNullOrEmpty()) {
                            Button(onClick = { onboarding = true }) { Text("Tell us about your farm") }
                            Text("Start with your country and farm. Existing records or an adviser can help fill in the rest.")
                        } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { model.tab = "Record work" }) { Text("Record today's work") }
                            OutlinedButton(onClick = { model.tab = "Documents" }) { Text("Add a document") }
                        }
                        OutlinedButton(onClick = model::refresh, enabled = !model.busy) { Text("Refresh workspace") }
                        val home = model.extras["home"]
                        home?.optJSONArray("next_actions")?.objects()?.take(5)?.forEach { action ->
                            val id = action.optString("record_id")
                            Card(onClick = {
                                when (action.optString("kind")) {
                                    "onboarding" -> onboarding = true
                                    "capture" -> model.tab = "Record work"
                                    "request" -> if (id.isNotBlank()) model.open("requests", id)
                                    "task" -> if (id.isNotBlank()) model.open("tasks", id)
                                    "review" -> { val target = if (action.optString("href").contains("operations")) "operations" else if (action.optString("href").contains("purchases")) "purchases" else if (action.optString("href").contains("sales")) "sales" else "facts"; model.records[target].orEmpty().firstOrNull { it.data().optString("review_status") == "proposed" }?.let { model.open(target, it.getString("id")) } ?: run { model.tab = "Record work" } }
                                    "annual_review" -> model.records["farms"].orEmpty().firstOrNull()?.let { questions = it }
                                    "compliance", "preparation" -> model.administration = "preparation" to null
                                    "regulatory", "updates" -> model.administration = "updates" to null
                                    "adviser" -> model.administration = "adviser" to null
                                    "help" -> model.administration = "help" to null
                                    else -> model.tab = "Paperwork"
                                }
                            }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(action.optString("title"), fontWeight = FontWeight.Bold); Text(action.optString("message")) } }
                        }
                        val pendingFacts = model.records["facts"].orEmpty().filter { it.data().optString("review_status") == "proposed" }
                        val pendingSales = model.records["sales"].orEmpty().filter { it.data().optString("review_status") == "proposed" }
                        val draftReports = model.records["reports"].orEmpty().filter { it.data().optString("status") == "draft" }
                        val activeRequests = model.records["requests"].orEmpty().filter { it.data().optString("status") !in listOf("responded", "closed") }
                        Heading("Ready for your attention")
                        pendingFacts.take(3).forEach { RecordRow(it, "Check proposed fact") { model.open("facts", it.getString("id")) } }
                        pendingSales.take(3).forEach { RecordRow(it, "Check recorded sale") { model.open("sales", it.getString("id")) } }
                        draftReports.take(3).forEach { RecordRow(it, "Preview and approve") { model.open("reports", it.getString("id")) } }
                        activeRequests.sortedBy { it.data().optString("deadline", "9999") }.take(5).forEach { RecordRow(it, status(it)) { model.open("requests", it.getString("id")) } }
                        if (pendingFacts.isEmpty() && pendingSales.isEmpty() && draftReports.isEmpty() && activeRequests.isEmpty()) Text("Nothing else in the saved records needs your attention right now.")
                        home?.optJSONArray("missing_information")?.objects()?.forEach { missing -> Notice(missing.optString("label") + ". " + missing.optString("message")) }
                        model.records["farms"].orEmpty().firstOrNull()?.let { farm -> OutlinedButton(onClick = { questions = farm }) { Text("Check what is missing for this year") } }
                        TextButton(onClick = { support = "imports" }) { Text("Bring in existing records") }
                        AdministrationEntryPoints(model)
                        PendingChanges(model)
                    } else if (model.tab == "Record work") {
                        RecordWorkHome(model, { capture = it }, { model.open(it.first, it.second) })
                    } else if (model.tab == "My fields") {
                        FieldsHome(model, { onboarding = true })
                    } else {
                        val kind = if (model.tab == "Documents") "documents" else "requests"
                        Heading(model.tab)
                        if (kind == "documents") {
                            Text("Keep the original. Suggested answers always need your review.")
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Button(onClick = chooseFiles) { Text("Choose files") }; OutlinedButton(onClick = camera) { Text("Take photo") } }
                            TextButton(onClick = { note = true }) { Text("Write a note") }
                            Intake(model, assemble)
                        } else {
                            Text("Letters, deadlines and the answers you have checked, kept together.")
                            Button(onClick = { editor = "requests" to null }) { Text("Add a letter or request") }
                            OutlinedButton(onClick = { reports = true }) { Text("Prepared reports and exports") }
                            model.records["farms"].orEmpty().forEach { farm -> OutlinedButton(onClick = { questions = farm }) { Text("Check missing answers · ${farm.title()}") } }
                            TextButton(onClick = { support = "connections" }) { Text("Country forms and connections") }
                            AdministrationEntryPoints(model)
                        }
                        OutlinedButton(onClick = model::refresh, enabled = !model.busy) { Text("Refresh") }
                        var search by remember(model.tab) { mutableStateOf("") }
                        OutlinedTextField(value = search, onValueChange = { search = it }, label = { Text("Search ${model.tab.lowercase()}") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                        val values = model.records[kind].orEmpty().filter { search.isBlank() || it.title().contains(search, true) || it.data().toString().contains(search, true) }
                        if (values.isEmpty()) Text(if (search.isBlank()) "No ${model.tab.lowercase()} recorded yet." else "No records match your search.")
                        values.forEach { value -> RecordRow(value, status(value)) { model.open(kind, value.getString("id")) } }
                        if (model.records[kind].orEmpty().size < (model.totals[kind] ?: 0)) {
                            Text("Showing ${model.records[kind].orEmpty().size} of ${model.totals[kind]} records. Search applies to records loaded on this device.", style = MaterialTheme.typography.bodySmall)
                            OutlinedButton(onClick = { model.loadMore(kind) }, enabled = !model.busy && !model.offline) { Text("Load more ${model.tab.lowercase()}") }
                        }
                    }
                    Spacer(Modifier.height(16.dp))
                }
            }
        }
        if (editor != null) { val edit = editor!!; Editor(model, edit.first, edit.second, { editor = null }) }
        if (onboarding) FarmOnboarding(model, { onboarding = false }, { support = it; onboarding = false })
        capture?.let { type -> GuidedCapture(model, type) { capture = null } }
        questions?.let { farm -> GuidedQuestions(model, farm) { questions = null } }
        support?.let { section -> SupportHandoff(model, section) { support = null } }
        AdministrationDestination(model)
        if (reports) Sheet("Reports and exports", { reports = false }) {
            Text("Prepare a report, check the original facts, then approve the exact version you want to export.")
            Button(onClick = { reports = false; editor = "reports" to null }) { Text("Prepare a report") }
            model.records["reports"].orEmpty().forEach { report -> RecordRow(report, status(report)) { reports = false; model.open("reports", report.getString("id")) } }
            if (model.records["reports"].isNullOrEmpty()) Text("No reports prepared yet.")
        }
        if (note) NoteEditor(model) { note = false }
        if (account) Sheet("Your private workspace", { account = false }) {
            Text(session.optJSONObject("user")?.optString("display_name").orEmpty(), style = MaterialTheme.typography.titleLarge)
            Text(session.optJSONObject("user")?.optString("email").orEmpty())
            Text(session.optJSONObject("workspace")?.optString("name").orEmpty())
            Text("API: ${model.origin}", style = MaterialTheme.typography.bodySmall)
            Text("Drafts and queued files are encrypted with AndroidKeyStore, scoped to this account and workspace. Signing out removes them from this device.")
            Text("The interface uses no automatic motion. Android font scaling, TalkBack labels and system touch targets are supported.")
            PendingChanges(model)
            TextButton(onClick = { account = false; onboarding = true }) { Text("Farm setup") }
            TextButton(onClick = { account = false; support = "imports" }) { Text("Imports and existing records") }
            TextButton(onClick = { account = false; model.administration = "help" to null }) { Text("Help with my next step") }
            TextButton(onClick = { account = false; model.administration = "community" to null }) { Text("Ask other farmers · shared questions") }
            OutlinedButton(onClick = { confirmLogout = true }) { Text("Sign out and clear this device") }
        }
        if (confirmLogout) AlertDialog(onDismissRequest = { confirmLogout = false }, title = { Text("Clear this account's device data?") }, text = { Text("Unsent drafts, camera pages and pending changes will be removed. Synchronized server records remain in your workspace.") }, confirmButton = { TextButton(onClick = { confirmLogout = false; account = false; editor = null; note = false; model.logout() }) { Text("Sign out and clear") } }, dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Keep working") } })
    }
}

@Composable private fun Heading(text: String) { Text(text, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() }) }
@Composable private fun Notice(text: String) { Text(text, Modifier.fillMaxWidth().background(Lilac).padding(12.dp), style = MaterialTheme.typography.bodySmall) }
private fun status(record: JSONObject): String = record.data().let { data -> listOf(data.optString("status"), data.optString("review_status"), data.optString("deadline").takeIf { it.isNotBlank() && it != "null" }?.let { "Due $it" }.orEmpty()).filter { it.isNotBlank() }.joinToString(" · ").ifBlank { "Revision ${record.optInt("revision", 1)}" } }
@Composable private fun RecordRow(value: JSONObject, caption: String, open: () -> Unit) { Card(onClick = open, modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color.White)) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { Text(value.title(), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold); Text(caption, style = MaterialTheme.typography.bodySmall, color = Green) } } }

@Composable private fun Login(model: FarmModel) {
    var endpoint by remember { mutableStateOf(model.origin) }; var email by remember { mutableStateOf("") }; var password by remember { mutableStateOf("") }; var name by remember { mutableStateOf("") }; var register by remember { mutableStateOf(false) }
    Surface(Modifier.fillMaxSize(), color = Paper) { Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(20.dp)); Image(painterResource(R.drawable.elephant_logo), "Funky Farmers elephant", Modifier.size(88.dp)); Text("Funky Farmers", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold); Text("Less paperwork. More growing.", style = MaterialTheme.typography.titleLarge)
        Text("Your farm records, source documents and reviewed reports in one private workspace.")
        Heading(if (register) "Create your workspace" else "Welcome back")
        if (model.message.isNotBlank()) Notice(model.message)
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(password, { password = it }, label = { Text("Password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
        if (register) OutlinedTextField(name, { name = it }, label = { Text("Your name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        if (register) Text("Use a password of at least 12 characters.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = { model.authenticate(endpoint.trim().trimEnd('/'), email, password, name, register); password = "" }, enabled = !model.busy && email.isNotBlank() && password.length >= (if (register) 12 else 1) && (!register || name.isNotBlank()), modifier = Modifier.fillMaxWidth()) { Text(if (register) "Create private workspace" else "Sign in") }
        TextButton(onClick = { register = !register }) { Text(if (register) "I already have an account" else "Create an account") }
        if (model.shared.isNotEmpty()) Text("${model.shared.size} shared files are encrypted on this device. You choose whether to add them after signing in.")
        var config by remember { mutableStateOf(false) }; TextButton(onClick = { config = !config }) { Text("Local API connection") }
        if (config) { OutlinedTextField(endpoint, { endpoint = it }, label = { Text("API origin") }, modifier = Modifier.fillMaxWidth()); Text("Android emulator: http://10.0.2.2:8139. Physical devices require a reachable HTTPS service or an authorized USB reverse connection.", style = MaterialTheme.typography.bodySmall) }
        if (model.busy) WorkingIndicator()
    } }
}

@Composable private fun WorkingIndicator() {
    val context = LocalContext.current
    val reducedMotion = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    if (reducedMotion) Text("Working…", Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall)
    else LinearProgressIndicator(Modifier.fillMaxWidth())
}

@Composable internal fun Sheet(title: String, close: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) { Surface(Modifier.fillMaxWidth(.96f).fillMaxHeight(.94f), shape = MaterialTheme.shapes.large, color = Paper) { Column(Modifier.padding(20.dp)) { Row(verticalAlignment = Alignment.CenterVertically) { Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge); TextButton(onClick = close) { Text("Close") } }; Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp), content = content) } } }
}

@Composable private fun PendingChanges(model: FarmModel) {
    val jobs = model.queue()
    if (jobs.isEmpty()) return
    Heading("Pending changes · ${jobs.size}")
    Text("These changes are saved on this device. Retries use the same identity; conflicting revisions need your decision.")
    jobs.forEach { job -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val body = job.optJSONObject("body")
        val title = job.optJSONObject("attachment")?.optString("name") ?: body?.optJSONObject("data")?.optString("title")?.takeIf { it.isNotBlank() } ?: body?.optString("title")?.takeIf { it.isNotBlank() } ?: when {
            job.optString("path") == "/workflow/onboard" -> "Farm setup"
            job.optString("path") == "/workflow/answer" -> "Answer for your paperwork"
            job.optString("path").contains("field-proposals") -> "Field change"
            job.optString("path").contains("/reports") -> "Prepared report or response"
            job.optString("path").contains("/review") -> "Record review"
            job.optString("path").startsWith("/compliance/") -> "Preparation checklists"
            job.optString("path").startsWith("/regulatory/") -> "In-app update preferences"
            job.optString("path").startsWith("/adviser/questions") -> "Private adviser conversation"
            job.optString("path").startsWith("/community") -> "Deliberate community publication or moderation"
            else -> "Saved change"
        }
        Text(title, fontWeight = FontWeight.SemiBold)
        Text(when (job.optString("state")) { "sending" -> "Syncing · retry if interrupted"; "conflict" -> "Conflict: review needed"; "needs_review" -> "Server refused this action · review its reason"; else -> "Saved on device · queued" })
        if (job.optString("error").isNotBlank()) Text(job.optString("error"), style = MaterialTheme.typography.bodySmall)
        if (job.optString("state") == "conflict") {
            OutlinedButton(onClick = { model.inspectConflict(job) }) { Text("Load latest record for comparison") }
            SelectionContainer { Text("Your pending change\n${job.optJSONObject("body")?.toString(2)}", style = MaterialTheme.typography.bodySmall) }
            job.optJSONObject("current")?.let { current ->
                SelectionContainer { Text("Latest server record\n${current.toString(2)}", style = MaterialTheme.typography.bodySmall) }
                if (job.optString("method") == "PATCH") Button(onClick = { model.resolveConflict(job) }) { Text("Use my values against this latest revision") }
                else Text("Discard this pending action and review the latest record again before approving or confirming.")
            }
        } else OutlinedButton(onClick = { model.retry(job.getString("id")) }, enabled = !model.busy) { Text("Retry now") }
        TextButton(onClick = { model.discard(job.getString("id")) }, enabled = !model.busy) { Text("Discard pending change") }
        var technical by remember(job.optString("id")) { mutableStateOf(false) }
        TextButton(onClick = { technical = !technical }) { Text(if (technical) "Hide delivery details" else "Delivery details") }
        if (technical) Text("Retry reference: ${job.getString("id")}", style = MaterialTheme.typography.labelSmall)
    } } }
}

@Composable private fun Intake(model: FarmModel, assemble: () -> Unit) {
    if (model.shared.isNotEmpty()) { Notice("${model.shared.size} shared files await a workspace choice."); Button(onClick = { runCatching { model.bindShared() }.onFailure { model.notify(it.message ?: "The shared files could not be bound.") } }) { Text("Add shared files to this workspace") } }
    if (model.staged.isEmpty()) return
    Heading("Review before upload")
    Text("PDF, PNG, JPEG and UTF-8 text. Each document is limited to 10 MiB. Camera pages are assembled in the order shown.")
    model.staged.forEachIndexed { index, part -> Card { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${index + 1}. ${part.optString("name")}", fontWeight = FontWeight.Bold)
        Text("${part.optLong("size") / 1024} KiB · ${part.optString("mime")}", style = MaterialTheme.typography.bodySmall)
        if (part.optBoolean("scan")) {
            val preview = remember(part.optString("id")) { runCatching { val bytes = model.attachmentBytes(part); BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = 8 })?.asImageBitmap() }.getOrNull() }
            preview?.let { Image(it, "Camera page ${index + 1}, review its orientation and readability", Modifier.fillMaxWidth().heightIn(max = 260.dp)) }
            Row { TextButton(onClick = { model.moveAttachment(index, -1) }, enabled = index > 0) { Text("Move up") }; TextButton(onClick = { model.moveAttachment(index, 1) }, enabled = index < model.staged.lastIndex) { Text("Move down") } }
        } else Button(onClick = { model.upload(part) }, enabled = !model.busy) { Text("Upload this document") }
        TextButton(onClick = { model.removeAttachment(part) }) { Text("Remove from this device") }
    } } }
    if (model.staged.any { it.optBoolean("scan") }) Button(onClick = assemble) { Text("Page order checked · assemble PDF") }
}

@Composable private fun NoteEditor(model: FarmModel, close: () -> Unit) {
    var text by remember { mutableStateOf(model.draft("capture-note", obj("text" to "")).optString("text")) }
    Sheet("Write a source note", close) { OutlinedTextField(text, { text = it; model.saveDraft("capture-note", obj("text" to it)) }, label = { Text("Your note") }, modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp)); Text("This is a manually supplied source, not an observed or verified farm fact."); Button(onClick = { model.stage(text.toByteArray(), "Farm note.txt", "text/plain"); model.deleteDraft("capture-note"); close() }, enabled = text.isNotBlank()) { Text("Save note for review") } }
}
