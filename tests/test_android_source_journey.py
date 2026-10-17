"""Opt-in installed-app journey on an explicitly disposable Android emulator.

No screenshots, desktop access, instrumentation hooks, or real authorities.
Set FUNKYFARM_ANDROID_SOURCE_JOURNEY=1 and explicit ANDROID_SERIAL,
FUNKYFARM_ANDROID_ADB, FUNKYFARM_ANDROID_AAPT, FUNKYFARM_ANDROID_APK paths.
The existing farmers/service_url fixtures retain their dedicated-DB guards.
"""

import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
from urllib.parse import urlsplit
from uuid import uuid4
import xml.etree.ElementTree as ET

import pytest

from conftest import confirm, fact_data, farm_data


pytestmark = pytest.mark.skipif(os.environ.get("FUNKYFARM_ANDROID_SOURCE_JOURNEY") != "1", reason="Requires explicit disposable Android emulator opt-in.")
PACKAGE = "eu.funkyfarm.app"


def eventually(read, accept, description, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if accept(value):
            return value
        time.sleep(0.25)
    raise AssertionError(description)


class AppUI:
    """Bounded public accessibility interaction, never another app's content."""

    def __init__(self, adb, serial, artifact_directory):
        self.adb, self.serial = adb, serial
        self.artifact_directory = artifact_directory
        self.last_guarded_tree = None
        self.redactions = set()
        self.command_metadata = {}
        self.hierarchy_read_events = []

    def command(self, *arguments, timeout=40):
        result = subprocess.run([self.adb, "-s", self.serial, *arguments], capture_output=True, text=True, timeout=timeout)
        self.command_metadata = {"exit_code": result.returncode, "stdout_bytes": len(result.stdout.encode("utf-8")), "stderr_bytes": len(result.stderr.encode("utf-8"))}
        assert result.returncode == 0, f"ADB operation {arguments[0]} failed (output intentionally withheld)."
        return result.stdout

    def foreground(self, timeout=0):
        allowed = {PACKAGE, "com.android.documentsui", "com.google.android.documentsui"}
        deadline = time.monotonic() + timeout
        while True:
            activities = self.command("shell", "dumpsys", "activity", "activities")
            resumed = [line for line in activities.splitlines() if "ActivityRecord{" in line and ("mResumedActivity" in line or "topResumedActivity" in line)]
            if resumed:
                assert all(any(f" {name}/" in line for name in allowed) for line in resumed), "Refusing to inspect an unrelated foreground application."
                return
            assert time.monotonic() < deadline, "No confirmed allowed foreground activity became ready."
            time.sleep(0.25)

    def hierarchy(self):
        allowed = {PACKAGE, "com.android.documentsui", "com.google.android.documentsui"}
        # The hierarchy may include the system bars or the active keyboard,
        # but never capture pixels or other application windows.
        for attempt in range(1, 4):
            self.foreground()
            output = self.command("exec-out", "uiautomator", "dump", "/dev/tty")
            start, end = output.find("<?xml"), output.rfind("</hierarchy>")
            if start >= 0 and end >= start:
                if attempt > 1:
                    event = {"attempt": attempt, "status": "complete_xml", **self.command_metadata}
                    self.hierarchy_read_events.append(event)
                    self.readiness_artifact()
                break
            event = {"attempt": attempt, "status": "no_complete_xml", "xml_start_present": start >= 0,
                     "xml_end_present": end >= 0, **self.command_metadata}
            self.hierarchy_read_events.append(event)
            self.readiness_artifact()
            if attempt == 3:
                path = self.failure_artifact("Complete accessibility hierarchy after three guarded reads")
                raise AssertionError(f"The allowed app supplied no complete hierarchy. Guarded artifact: {path}")
            time.sleep(0.25)
        tree = ET.fromstring(output[start:end + len("</hierarchy>")])
        system = {"com.android.systemui", "com.android.inputmethod.latin", "com.google.android.inputmethod.latin"}
        assert all(node.get("package", "") in allowed | system | {""} for node in tree.iter("node")), "Unexpected application in accessibility hierarchy."
        self.last_guarded_tree = tree
        return tree

    def readiness_artifact(self):
        path = self.artifact_directory / "android-hierarchy-readiness.json"
        path.write_text(json.dumps(self.hierarchy_read_events, indent=2), encoding="utf-8")
        print("Native accessibility readiness: " + json.dumps(self.hierarchy_read_events[-1]), flush=True)

    def failure_artifact(self, label):
        """Persist only the previously authorized hierarchy; never take a new dump."""
        controls = []

        def visit(node, redact=False):
            redact = redact or node.get("password") == "true" or node.get("class") == "android.widget.EditText"
            if node.tag == "node" and node.get("package") in {PACKAGE, "com.android.documentsui", "com.google.android.documentsui"}:
                control = {key: node.get(key, "") for key in ("package", "class", "bounds", "clickable", "enabled", "checkable", "checked")}
                for key in ("text", "content-desc"):
                    value = "[redacted input]" if redact else node.get(key, "")
                    for secret in self.redactions:
                        value = value.replace(secret, "[redacted]")
                    control[key] = value
                controls.append(control)
            for child in node:
                visit(child, redact)

        if self.last_guarded_tree is not None:
            visit(self.last_guarded_tree)
        path = self.artifact_directory / "android-last-guarded-controls.json"
        path.write_text(json.dumps({"missing_control": label, "controls": controls}, ensure_ascii=False, indent=2), encoding="utf-8")
        summary = [{"text": (item["text"] or item["content-desc"])[:140], "role": item["class"], "bounds": item["bounds"]} for item in controls if item["text"] or item["content-desc"]][:12]
        print("Native guarded failure controls: " + json.dumps(summary, ensure_ascii=False), flush=True)
        return path

    @staticmethod
    def bounds(node):
        values = list(map(int, re.findall(r"-?\d+", node.get("bounds", ""))))
        return values if len(values) == 4 else [0, 0, 0, 0]

    def swipe(self, up=True):
        tree = self.hierarchy()
        bounds = [self.bounds(node) for node in tree.iter("node") if node.get("package") == PACKAGE]
        width = max((value[2] for value in bounds), default=1080)
        height = max((value[3] for value in bounds), default=1920)
        x, upper, lower = width // 2, int(height * 0.25), int(height * 0.78)
        self.command("shell", "input", "swipe", str(x), str(lower if up else upper), str(x), str(upper if up else lower), "250")

    def locate(self, label, *, kind=None, prefix=False, scroll=True):
        # Two bounded passes allow returning from the bottom of a long row
        # review without assuming fixed screen coordinates or font sizes.
        for direction in ([True, False] if scroll else [True]):
            previous, unchanged = None, 0
            for _ in range(45 if scroll else 15):
                tree = self.hierarchy()
                parents = {child: parent for parent in tree.iter() for child in parent}
                resolved = []
                for node in tree.iter("node"):
                    names = [node.get("text", ""), node.get("content-desc", "")]
                    if not any(name.startswith(label) if prefix else name == label for name in names):
                        continue
                    candidate = node
                    scope_size = 1
                    if kind:
                        while candidate is not None:
                            matches = [item for item in candidate.iter("node") if (
                                item.get("checkable") == "true" if kind == "check" else
                                item.get("class") == "android.widget.EditText")]
                            if matches:
                                scope_size = len(list(candidate.iter("node")))
                                matches = [item for item in matches if item.get("enabled") == "true"]
                                if kind == "check" and node.get("checkable") != "true":
                                    # Compose can flatten a Row into a broad root.
                                    # Only a checkbox to the label's left with
                                    # overlapping vertical bounds is eligible.
                                    lx1, ly1, _, ly2 = self.bounds(node)
                                    matches = [item for item in matches if (
                                        self.bounds(item)[2] <= lx1 + 12
                                        and min(self.bounds(item)[3], ly2) > max(self.bounds(item)[1], ly1))]
                                    if len(matches) > 1:
                                        path = self.failure_artifact(label)
                                        raise AssertionError(f"Ambiguous checkbox beside native label: {label}. Guarded artifact: {path}")
                                candidate = matches[0] if len(matches) == 1 else None
                                break
                            candidate = parents.get(candidate)
                        if candidate is None:
                            continue
                    x1, y1, x2, y2 = self.bounds(candidate)
                    if x2 > x1 >= 0 and y2 > y1 >= 0 and candidate.get("enabled") == "true":
                        resolved.append((scope_size, candidate))
                if resolved:
                    # Warning text appears once as information and once beside
                    # its checkbox: the smallest shared semantic row wins.
                    return min(resolved, key=lambda match: match[0])[1]
                signature = tuple((node.get("text"), node.get("bounds")) for node in tree.iter("node"))
                unchanged = unchanged + 1 if signature == previous else 0
                previous = signature
                if scroll:
                    if unchanged >= 2:
                        break
                    self.swipe(direction)
                else:
                    time.sleep(0.25)
        path = self.failure_artifact(label)
        raise AssertionError(f"Expected native control was not available: {label}. Guarded artifact: {path}")

    def tap_node(self, node):
        x1, y1, x2, y2 = self.bounds(node)
        self.command("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))

    def tap(self, label, **options):
        self.tap_node(self.locate(label, **options))

    def check(self, label):
        node = self.locate(label, kind="check")
        if node.get("checked") != "true":
            self.tap_node(node)

    def fill(self, label, value):
        self.tap_node(self.locate(label, kind="edit"))
        self.command("shell", "input", "keycombination", "113", "29")
        self.command("shell", "input", "keyevent", "67")
        self.command("shell", "input", "text", shlex.quote(value.replace(" ", "%s")))
        # KEYCODE_ESCAPE hides the IME without navigating away from the app.
        self.command("shell", "input", "keyevent", "111")


def test_android_farmer_reviews_luxembourg_source_rows_and_retained_report(farmers, service_url, tmp_path):
    serial = os.environ.get("ANDROID_SERIAL", "")
    assert re.fullmatch(r"emulator-\d+", serial), "Only an explicitly named disposable emulator is supported."
    paths = {name: Path(os.environ.get(name, "")) for name in ("FUNKYFARM_ANDROID_ADB", "FUNKYFARM_ANDROID_AAPT", "FUNKYFARM_ANDROID_APK")}
    assert all(path.is_file() for path in paths.values()), "Supply explicit installed SDK adb/aapt and the scoped APK file."
    ui = AppUI(str(paths["FUNKYFARM_ANDROID_ADB"]), serial, tmp_path)
    assert ui.command("shell", "getprop", "ro.kernel.qemu").strip() == "1"
    badging = subprocess.run([str(paths["FUNKYFARM_ANDROID_AAPT"]), "dump", "badging", str(paths["FUNKYFARM_ANDROID_APK"])], capture_output=True, text=True, timeout=30)
    assert badging.returncode == 0 and re.search(r"package: name='eu\.funkyfarm\.app'", badging.stdout), "Refusing an APK for another package."
    address = urlsplit(service_url)
    assert address.hostname in ("127.0.0.1", "localhost") and address.scheme == "http"
    print("Native source journey: fictional API setup", flush=True)
    farmer = farmers("Native Luxembourg authored source reviewer")
    ui.redactions.add(farmer.password)
    farm = farmer.create("farms", {**farm_data("Native Luxembourg source holding"), "country": "LU", "region": None, "farm_type": "arable"})
    request = farmer.create("requests", {"farm_id": farm["id"], "title": "Native authored Luxembourg preparation", "recipient": "Fictional source reviewer", "country": "LU", "region": None, "reporting_year": 2026, "deadline": None, "pack_id": "LU-cap-2026", "requirements": [], "status": "draft"})
    filename = "authored-lu-" + uuid4().hex[:10] + ".csv"
    source = tmp_path / filename
    # Deliberately short rows still require review of absent optional columns.
    source.write_text("id_parcel;expl_code;a_parcel;assur_harv;extra_blank;extra_null;extra_zero\n000007;000123;125,00;TRUE;;NULL;0\n000008;000123;NaN;true;;NULL;0\n", encoding="utf-8")
    remote = "/sdcard/Download/" + filename
    ui.command("install", "-r", str(paths["FUNKYFARM_ANDROID_APK"]), timeout=180)
    ui.command("shell", "am", "force-stop", PACKAGE)
    # This explicit disposable emulator's package only; no other app data.
    ui.command("shell", "pm", "clear", PACKAGE)
    ui.command("push", str(source), remote)
    ui.command("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file://" + remote)
    try:
        print("Native source journey: local app login", flush=True)
        ui.command("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        # Cold launch can initially report no resumed activity on API 36.
        # Wait on metadata only; any actual unrelated foreground fails closed.
        ui.foreground(timeout=30)
        ui.tap("Local API connection")
        ui.fill("API origin", f"http://10.0.2.2:{address.port}")
        ui.fill("Email", farmer.email)
        ui.fill("Password", farmer.password)
        ui.tap("Sign in")
        ui.locate("A little less to keep in your head.", scroll=False)
        ui.tap("My fields")
        ui.locate(farm["data"]["name"])
        ui.tap("Home")
        print("Native source journey: catalogue and document-picker intake", flush=True)
        ui.tap("Bring in existing records")
        ui.tap("Bring in a prepared source file")
        ui.tap("Choose a prepared source format")
        for label in ("Agricultural parcel export row", "Vineyard parcel export row", "Domestic vineyard quota subparcel", "Foreign vineyard quota subparcel"):
            ui.locate(label, prefix=True)
        ui.tap("Agricultural parcel export row", prefix=True)
        ui.tap("Choose the farm for this source")
        ui.tap(farm["data"]["name"])
        ui.tap("Choose original CSV file")
        # ACTION_OPEN_DOCUMENT: stay in the system document picker, not a
        # hidden URI injection or app-specific import shortcut.
        ui.tap("Show roots", scroll=False)
        ui.tap("Downloads", scroll=False)
        ui.tap(filename)
        ui.check("I checked this export's source format, year and selected farm.")
        ui.tap("Upload source for review")
        ui.locate("Check the original source", scroll=False)
        ui.locate("File source year: 2026")
        ui.locate("Holding number exactly as supplied: 000123")
        ui.tap("Choose after checking the original")
        ui.tap("Comma · for example 12,5")
        ui.check("I checked this source format, source year, exact holding number and selected farm against the original file.")
        ui.tap("Confirm source and load row checks")
        print("Native source journey: original rows and explicit warning review", flush=True)
        imported = eventually(lambda: farmer.get("/imports").json()["items"], lambda items: len(items) == 1 and items[0]["data"].get("profile_review"), "Native source confirmation did not persist.")[0]
        preview = farmer.get(f"/imports/{imported['id']}/preview").json()["items"]
        assert preview[0]["can_save"] and not preview[1]["can_save"]
        assert {"profile_invalid_number", "profile_invalid_boolean"} <= {issue["code"] for issue in preview[1]["issues"]}
        invalid_number = next(issue["message"] for issue in preview[1]["issues"] if issue["code"] == "profile_invalid_number")
        ui.locate(invalid_number)
        # Real UI readback distinguishes unknown, blank and literal zero.
        ui.tap("Show original cells · source row 1")
        for label in ("Measured parcel area (a_parcel)", "Original unit: a · no conversion applied", "125,00", "Empty source cell", "NULL · literal source text", "0"):
            ui.locate(label)
        ui.tap("Hide original cells · source row 1")
        for code in preview[0]["requires_acknowledgement"]:
            message = next(issue["message"] for issue in preview[0]["issues"] if issue["code"] == code)
            ui.check(message)
        ui.check("Create a proposed farm fact from this row")
        ui.fill("What did you check in the selected source rows?", "Checked exact original year holding codes decimal comma Ar and source warnings")
        ui.tap("Create 1 selected proposed row(s)")
        ui.locate("1 rows saved as proposals · 0 rows not saved")
        facts = eventually(lambda: farmer.get("/facts").json()["items"], lambda items: len(items) == 1, "Selected valid row did not become exactly one proposed fact.")
        fact = facts[0]
        assert fact["data"]["review_status"] == "proposed"
        assert fact["data"]["value"] == {"id_parcel": "000007", "expl_code": "000123", "a_parcel": "125,00", "assur_harv": "TRUE", "extra_blank": "", "extra_null": "NULL", "extra_zero": "0"}
        assert re.fullmatch(r"lu\.fa\.agriculture_row\.[a-f0-9]{64}", fact["data"]["key"])
        assert farmer.get(f"/farms/{farm['id']}").json() == farm
        print("Native source journey: reload and separate fact confirmation", flush=True)
        ui.tap("Reload current source, farm and column guidance")
        ui.tap("Open this fact for separate review")
        ui.check("I checked this exact value, unit, period and evidence.")
        ui.tap("Confirm this fact")
        fact = eventually(lambda: farmer.get(f"/facts/{fact['id']}").json(), lambda value: value["data"]["review_status"] == "confirmed", "Separate native fact review did not persist.")
        ui.tap("Home")
        ui.tap("Check what is missing for this year")
        ui.locate("0 of 0 answers checked")
        ui.locate("1 confirmed source rows · 0 waiting for review")
        guided = farmer.get("/workflow/questions", params={"request_id": request["id"]}).json()
        assert guided["questions"] == [] and guided["total_count"] == 0
        ui.tap("Close")
        print("Native source journey: reviewed request and retained report", flush=True)
        ui.tap("Paperwork")
        ui.tap(request["data"]["title"])
        ui.tap("Prepare report from this request")
        draft = eventually(lambda: farmer.get("/reports").json()["items"], lambda items: len(items) == 1, "Native request did not prepare a report.")[0]
        ui.tap("Open report · draft")
        ui.locate("Measured parcel area (a_parcel)")
        ui.locate("Original unit: a · no conversion applied")
        ui.locate("125,00")
        ui.check("I reviewed this exact report and its evidence.")
        ui.tap("Approve this report")
        issued = eventually(lambda: farmer.get(f"/reports/{draft['id']}").json(), lambda value: value["data"]["status"] == "issued", "Native report approval did not persist.")
        field = next(value for value in issued["data"]["snapshot"]["fields"] if value.get("fact_id") == fact["id"])
        assert field["row_schema"]["id"] == "lu-agriculture-2026" and field["value"] == fact["data"]["value"]
        assert issued["data"]["filing_status"] == "not_filed"
        before = {format: farmer.get(f"/reports/{issued['id']}/download?format={format}").content for format in ("json", "csv", "pdf", "xlsx")}
        correction_data = {key: value for key, value in fact["data"].items() if key not in ("reviewed_at", "reviewed_by", "review_note")}
        correction = farmer.create("facts", {**correction_data, "supersedes_id": fact["id"], "review_status": "proposed", "value": {**fact["data"]["value"], "a_parcel": "126,00"}})
        confirm(farmer, correction, "Separate corrected source observation; retained native-approved report stays unchanged.")
        for format, content in before.items():
            assert farmer.get(f"/reports/{issued['id']}/download?format={format}").content == content
        assert farmer.get("/operations").json()["total"] == 0
        assert farmer.get(f"/farms/{farm['id']}").json() == farm
        print("Native source journey: saved-source fact pagination", flush=True)
        # Newer ordinary observations must not make older source rows
        # unreachable in the farm's paginated, profile-filtered review list.
        for index in range(6):
            farmer.create("facts", fact_data(farm["id"], key=f"native_pagination_observation_{index}", value=index, unit=None))
        first_page = farmer.get("/facts", params={"farm_id": farm["id"], "limit": 5}).json()
        assert first_page["total"] == 8 and len(first_page["items"]) == 5
        assert all(item["data"]["key"].startswith("native_pagination_observation_") for item in first_page["items"])
        ui.tap("Home")
        ui.tap("Refresh workspace")
        ui.tap("Check what is missing for this year")
        ui.tap("Review saved rows from this table")
        ui.tap("Refresh saved source rows")
        ui.tap("Load more farm facts to find source rows")
        ui.locate("rejected · 2026")
        ui.locate("confirmed · 2026")
        ui.locate("Refresh saved source rows")
        visible_text = {node.get("text", "") for node in ui.hierarchy().iter("node")}
        assert {"rejected · 2026", "confirmed · 2026"} <= visible_text
        assert "Load more farm facts to find source rows" not in visible_text
        ui.tap("Close")
        ui.tap("My fields")
        ui.tap("Farm details and checked facts")
        ui.locate("5 of 8 workspace facts loaded.", prefix=True)
        ui.tap("Load more workspace facts for this farm list")
        ui.locate("8 of 8 workspace facts loaded.", prefix=True)
        ui.locate("Compare competing evidence")
        visible_text = {node.get("text", "") for node in ui.hierarchy().iter("node")}
        assert "Load more workspace facts for this farm list" not in visible_text
    finally:
        ui.command("shell", "am", "force-stop", PACKAGE)
        ui.command("shell", "rm", "-f", remote)
