"""Opt-in Czech journal journey using the installed, exact project APK.

Requires FUNKYFARM_ANDROID_CZECH_JOURNEY=1 plus explicit ANDROID_SERIAL,
FUNKYFARM_ANDROID_ADB, FUNKYFARM_ANDROID_AAPT and FUNKYFARM_ANDROID_APK.
No install/build, screenshots, authority traffic or unrelated app inspection.
The farmers/service_url fixtures retain dedicated local database/API guards.
"""

from decimal import Decimal
from hashlib import sha256
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

import pytest

from conftest import farm_data
from test_android_source_journey import AppUI, PACKAGE, eventually


pytestmark = pytest.mark.skipif(
    os.environ.get("FUNKYFARM_ANDROID_CZECH_JOURNEY") != "1",
    reason="Requires explicit disposable Android Czech-journey opt-in.",
)
PACK = "cz-ppp-journal-2026"


def choose(ui, label, option):
    """Associate an exact own-app label with the nearest visible button below it."""
    ui.dismiss_keyboard()
    ui.locate(label)

    def fail(reason):
        path = ui.failure_artifact(label)
        raise AssertionError(f"{reason}: {label}. Guarded artifact: {path}")

    for _ in range(3):
        tree = ui.hierarchy()
        parents = {child: parent for parent in tree.iter() for child in parent}

        def visible(node):
            left, top, right, bottom = ui.bounds(node)
            if not (right > left >= 0 and bottom > top >= 0):
                return False
            x, y = (left + right) // 2, (top + bottom) // 2
            ancestor = node
            while ancestor is not None:
                if ancestor.get("enabled") == "false" or ancestor.get("visible-to-user") == "false":
                    return False
                if ancestor.get("class") in ("android.widget.ScrollView", "androidx.recyclerview.widget.RecyclerView"):
                    l, t, r, b = ui.bounds(ancestor)
                    if not (l <= x < r and t <= y < b):
                        return False
                ancestor = parents.get(ancestor)
            return True

        labels = [node for node in tree.iter("node") if node.get("package") == PACKAGE
                  and label in (node.get("text"), node.get("content-desc")) and visible(node)]
        if len(labels) > 1:
            fail("Ambiguous visible native choice label")
        candidates = []
        if labels:
            label_left, _, label_right, label_bottom = ui.bounds(labels[0])
            for node in tree.iter("node"):
                if (node.get("package") != PACKAGE or node.get("class") not in {"android.widget.Button", "android.view.View"}
                        or node.get("checkable") == "true"
                        or node.get("clickable") != "true" or node.get("enabled") != "true" or not visible(node)):
                    continue
                left, top, right, _ = ui.bounds(node)
                if top >= label_bottom and min(right, label_right) > max(left, label_left):
                    candidates.append((top - label_bottom, node))
        if candidates:
            nearest_gap = min(gap for gap, _ in candidates)
            nearest = [node for gap, node in candidates if gap == nearest_gap]
            if len(nearest) != 1:
                fail("Ambiguous nearest native choice button")
            ui.tap_node(nearest[0])
            ui.tap(option, scroll=False)
            return
        ui.swipe(True)
    fail("No single visible project choice button below label")


def test_android_farmer_captures_and_approves_requestless_czech_journal(farmers, service_url, tmp_path):
    serial = os.environ.get("ANDROID_SERIAL", "")
    assert re.fullmatch(r"emulator-\d+", serial), "Only an explicitly named disposable emulator is supported."
    paths = {name: Path(os.environ.get(name, "")) for name in (
        "FUNKYFARM_ANDROID_ADB", "FUNKYFARM_ANDROID_AAPT", "FUNKYFARM_ANDROID_APK")}
    assert all(path.is_absolute() and path.is_file() for path in paths.values()), "Supply explicit absolute SDK/APK paths."
    ui = AppUI(str(paths["FUNKYFARM_ANDROID_ADB"]), serial, tmp_path)
    assert ui.command("shell", "getprop", "ro.kernel.qemu").strip() == "1"
    badging = subprocess.run([str(paths["FUNKYFARM_ANDROID_AAPT"]), "dump", "badging", str(paths["FUNKYFARM_ANDROID_APK"])],
                             capture_output=True, text=True, timeout=30)
    assert badging.returncode == 0 and re.search(r"package: name='eu\.funkyfarm\.app'", badging.stdout), "Refusing another package's APK."
    installed = ui.command("shell", "pm", "path", PACKAGE).strip().splitlines()
    assert len(installed) == 1 and re.fullmatch(r"package:/data/app/[^\s]+/base\.apk", installed[0]), "Require the installed standalone project APK."
    installed_hash = ui.command("shell", "sha256sum", installed[0].removeprefix("package:")).split()[0]
    assert installed_hash == sha256(paths["FUNKYFARM_ANDROID_APK"].read_bytes()).hexdigest(), "Installed APK differs from the explicitly supplied artifact."
    address = urlsplit(service_url)
    assert address.scheme == "http" and address.hostname in ("127.0.0.1", "localhost") and address.port
    assert not address.username and not address.password and not address.query and not address.fragment
    farmer = farmers("Native Czech authored journal reviewer")
    ui.redactions.update((farmer.email, farmer.password))
    farm = farmer.create("farms", {**farm_data("Native Czech authored field holding"), "country": "CZ", "region": None})
    holder_name = "Authored Czech Holder 007"
    application_title = "Authored actual Czech application 007"
    ui.command("shell", "am", "force-stop", PACKAGE)
    # Both clears target only this explicitly opted-in disposable project package.
    ui.command("shell", "pm", "clear", PACKAGE)
    try:
        ui.command("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
        ui.foreground(timeout=30)
        ui.tap("Local API connection")
        origin = f"http://10.0.2.2:{address.port}"
        ui.fill("API origin", origin)
        ui.fill("Email", farmer.email)
        ui.fill("Password", farmer.password)
        assert ui.locate("API origin", kind="edit").get("text") == origin
        ui.tap("Sign in")
        ui.locate("A little less to keep in your head.", scroll=False)
        ui.tap("Record work")
        ui.tap("Czech crop-protection journal")
        ui.fill("Application year · actual treatment dates decide which entries belong", "2026")
        ui.locate("No letter is linked. Check this journal before approving it.")
        ui.tap("Record holder details")
        choose(ui, "Holder type", "Legal person")
        ui.fill("Holder's full name or legal name", holder_name)
        ui.fill("Holder's business address", "Authored business address 001")
        choose(ui, "Identification number", "A number is assigned and supplied")
        ui.fill("Identification number exactly as recorded", "00001234")
        ui.fill("Where did you check this holder identity? · required", "Compared the fictional original holder record")
        ui.tap("Check holder details")
        ui.tap("Save holder proposal for separate review")
        holder = eventually(lambda: farmer.get("/facts").json()["items"],
                            lambda items: len(items) == 1, "Native holder form did not create one proposal.")[0]
        assert holder["data"]["key"] == "cz.ppp.holder" and holder["data"]["review_status"] == "proposed"
        assert holder["data"]["value"] == {
            "kind": "legal_person", "name": holder_name, "address": "Authored business address 001",
            "identification_number": {"status": "provided", "value": "00001234"}}
        assert holder["data"]["temporal_basis"] == "static" and holder["data"].get("period") is None
        assert farmer.get("/reports").json()["total"] == 0
        ui.tap(f"Review holder · {holder_name} · proposed")
        ui.check("I checked this exact value, unit, period and evidence.")
        ui.tap("Confirm this fact")
        eventually(lambda: farmer.get(f"/facts/{holder['id']}").json(),
                   lambda item: item["data"]["review_status"] == "confirmed", "Separate native holder confirmation did not persist.")

        ui.tap("Record work")
        ui.tap("Czech crop-protection journal")
        ui.tap("Add another actual application")
        ui.fill("When did it happen? · YYYY-MM-DD", "2026-06-18")
        ui.fill("A short name for this record", application_title)
        ui.fill("Product as printed on its label", "Authored product not a permission claim")
        ui.tap("Add actual treatment and label details")
        choose(ui, "What was treated?", "A field or surface")
        for label, value in (
            ("Product authorisation printed on the label", "AUTHORED-ONLY"),
            ("Actual dose", "0,500"), ("Dose unit exactly as recorded", "L/ha"),
            ("Actual treated area or size", "3,25"), ("Treated size unit", "ha"),
            ("Actual treatment location", "Authored exact LPIS location"), ("Crop treated", "Authored cereal"),
        ):
            ui.fill(label, value)
        choose(ui, "Does the label require the application time?", "No")
        choose(ui, "Does the label require the growth stage?", "No")
        choose(ui, "Location recorded for this application", "Land registered in LPIS")
        ui.fill("Cadastral area exactly as recorded", "Authored cadastral area 001")
        ui.fill("LPIS DPB square · exact reference", "000012")
        ui.fill("LPIS DPB code · exact reference", "0007/01")
        choose(ui, "Subject treated", "Crop or crop product")
        ui.fill("Sown or planted area · original ha figure, up to 2 decimals", "3,75")
        ui.fill("Actual sowing or planting date · YYYY-MM-DD", "2026-03-04")
        choose(ui, "Crop-growing end", "Pending · crop has not ended or date not known")
        ui.fill("Target organism or actual treatment purpose", "Authored recorded target")
        choose(ui, "Mixture recorded for this application", "Single product · S")
        choose(ui, "Efficacy follow-up", "Pending · result not yet known")
        ui.tap("Check this record")
        for warning in (
            "Please check this number: 0,500 will be saved as 0.500.",
            "The supplied crop-end follow-up is still pending, not complete. This warning does not make crop-end reporting a requirement for objects.",
            "Efficacy has not been observed yet; pending is not an ineffective result.",
        ):
            ui.check(warning)
        ui.tap("Save this record for review")
        operation = eventually(lambda: farmer.get("/operations").json()["items"],
                               lambda items: len(items) == 1, "Native application form did not create one proposed event.")[0]
        data, details = operation["data"], operation["data"]["cz_ppp"]
        assert data["review_status"] == "proposed" and data["farm_id"] == farm["id"]
        assert data["date"] == data["period"] == "2026-06-18" and data["temporal_basis"] == "calendar_date"
        assert Decimal(str(data["dose"])) == Decimal("0.500") and data["dose_unit"] == "L/ha"
        assert Decimal(str(data["treated_size"])) == Decimal("3.25") and data["treated_unit"] == "ha"
        assert data.get("quantity") is None and data.get("unit") is None, "Dose times area must not invent a total quantity."
        assert details["dpb_square"] == "000012" and details["dpb_code"] == "0007/01"
        assert details["crop_end"] == details["efficacy"] == {"status": "pending"}
        assert details["original_numbers"] == {"dose": "0,500", "treated_size": "3,25", "sown_area_ha": "3,75"}
        assert Decimal(str(details["sown_area_ha"])) == Decimal("3.75") and details["mixture"] == "S"
        assert farmer.get("/requests").json()["total"] == farmer.get("/reports").json()["total"] == 0
        ui.tap("Open this application for separate review")
        ui.locate("Pending · result not yet known")
        ui.locate("Pending · actual end not established")
        ui.fill("What did you check against the journal source?", "Checked actual date exact LPIS references original units and pending followups")
        ui.check("I checked the actual record, amounts, units, dates and evidence.")
        ui.tap("Confirm this record")
        operation = eventually(lambda: farmer.get(f"/operations/{operation['id']}").json(),
                               lambda item: item["data"]["review_status"] == "confirmed", "Separate native application confirmation did not persist.")

        ui.tap("Record work")
        ui.tap("Czech crop-protection journal")
        ui.check("Include this exact confirmed application in the report")
        ui.locate("1 application identities selected. Selection is explicit; no entries are merged by field or date.")
        ui.tap("Check selected entries in a journal preview")
        draft = eventually(lambda: farmer.get("/reports", params={"view": "summary"}).json()["items"],
                           lambda items: len(items) == 1, "Native requestless selection did not prepare one preview.")[0]
        assert draft["data"]["status"] == "draft" and draft["data"].get("request_id") is None
        assert draft["data"]["pack_id"] == PACK and draft["data"].get("approval") is None
        assert farmer.get("/requests").json()["total"] == 0
        metadata = farmer.get(f"/reports/{draft['id']}", params={"view": "review"}).json()["data"]
        assert metadata["can_approve"] and metadata["review"]["sections"]["operations"] == 1
        assert metadata["review"]["sections"]["evidence"] == 0
        ui.tap("Home")
        ui.tap("Paperwork")
        ui.tap("Prepared reports and exports")
        ui.tap(draft["data"]["title"])
        ui.locate("Review this report")
        ui.locate("Showing 1–1 of 1 · Answers and source rows")
        ui.tap("Show complete value · answer 1")
        ui.locate(holder_name)
        ui.locate("00001234")
        ui.tap("Hide complete value · answer 1")
        choose(ui, "Which part would you like to check?", "Farm activities (1)")
        ui.locate("Showing 1–1 of 1 · Farm activities")
        ui.tap("Show retained journal entry · activity 1")
        ui.locate("Retained application identity")
        ui.locate(operation["id"])
        for original in ("0,500", "3,25", "3,75"):
            ui.locate(original)
        ui.locate("Pending · result not yet known")
        ui.locate("Pending · actual end not established")
        ui.tap("Hide retained journal entry · activity 1")
        choose(ui, "Which part would you like to check?", "Evidence documents (0)")
        ui.locate("No items in this verified section (0 of 0).")
        assert farmer.get(f"/reports/{draft['id']}").json()["data"]["status"] == "draft", "Viewing a preview must not approve it."
        ui.check("I reviewed this exact report and its evidence.")
        ui.tap("Approve this report")
        issued = eventually(lambda: farmer.get(f"/reports/{draft['id']}").json(),
                            lambda item: item["data"]["status"] == "issued", "Explicit native report approval did not persist.")
        snapshot = issued["data"]["snapshot"]
        assert issued["data"]["request_id"] is None and issued["data"]["filing_status"] == "not_filed"
        assert [item["id"] for item in snapshot["operations"]] == [operation["id"]]
        retained = snapshot["operations"][0]["data"]["cz_ppp"]
        assert retained["original_numbers"] == details["original_numbers"]
        assert retained["efficacy"] == retained["crop_end"] == {"status": "pending"}
        assert next(item for item in snapshot["fields"] if item.get("fact_key") == "cz.ppp.holder")["value"] == holder["data"]["value"]
        assert farmer.get("/operations").json()["total"] == 1 and farmer.get("/requests").json()["total"] == 0
        assert farmer.get(f"/farms/{farm['id']}").json() == farm
    finally:
        ui.command("shell", "am", "force-stop", PACKAGE)
        ui.command("shell", "pm", "clear", PACKAGE)
