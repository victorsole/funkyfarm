"""Small, opt-in projections of reports; never modify retained snapshots."""

from copy import deepcopy
import json

from .models import ApiError


PAGE_LIMIT = 5
BYTE_LIMIT = 2 * 1024 * 1024
SECTIONS = ("fields", "operations", "evidence", "blockers", "changes", "receipts", "reissues")
IDENTITY_KEYS = ("farm_id", "request_id", "pack_id", "reporting_year", "status", "checksum",
                 "correction_of", "approval", "filing_status", "created_by", "title")
SNAPSHOT_SECTIONS = ("fields", "facts", "operations", "evidence")


def compact_record(report, view="summary"):
    data = report["data"]
    snapshot = data["snapshot"]
    pack = snapshot.get("pack", {})
    result = {key: deepcopy(value) for key, value in report.items() if key != "data"}
    retained = {key: deepcopy(data[key]) for key in IDENTITY_KEYS if key in data}
    retained["transport_view"] = view
    retained["title"] = data.get("title") or f"{pack.get('title') or pack.get('id') or data.get('pack_id') or 'Farm report'} · {data.get('reporting_year', '')}"
    counts = snapshot.get("counts")
    if counts is None:
        counts = {key: len(snapshot.get(key, [])) for key in SNAPSHOT_SECTIONS}
    retained["snapshot"] = {
        "pack": {key: deepcopy(pack.get(key)) for key in ("id", "title", "version")},
        "farm": {key: deepcopy(snapshot.get("farm", {}).get(key)) for key in ("id", "revision", "name", "country")},
        "reporting_year": snapshot.get("reporting_year"),
        "capability_notice": snapshot.get("capability_notice"),
        "counts": deepcopy(counts),
    }
    result["data"] = retained
    return result


def summary_data_sql():
    """Project in PostgreSQL so a list never retrieves entire source snapshots."""
    pairs = [f"'{key}', data->'{key}'" for key in IDENTITY_KEYS]
    pack = ",".join(f"'{key}', data#>'{{snapshot,pack,{key}}}'" for key in ("id", "title", "version"))
    farm = ",".join(f"'{key}', data#>'{{snapshot,farm,{key}}}'" for key in ("id", "revision", "name", "country"))
    counts = ",".join(f"'{key}', jsonb_array_length(coalesce(data#>'{{snapshot,{key}}}', '[]'::jsonb))" for key in SNAPSHOT_SECTIONS)
    pairs.append("'snapshot', jsonb_build_object("
                 f"'pack',jsonb_build_object({pack}),'farm',jsonb_build_object({farm}),"
                 "'reporting_year',data#>'{snapshot,reporting_year}',"
                 "'capability_notice',data#>'{snapshot,capability_notice}',"
                 f"'counts',jsonb_build_object({counts}))")
    return "jsonb_build_object(" + ",".join(pairs) + ")"


def bounded_page(items, *, section, report, fingerprint, offset, limit):
    """Budget the complete encoded response, retaining only whole ordered items."""
    result = {"items": [], "total": len(items), "limit": limit, "offset": offset,
              "next_offset": None, "section": section, "report_revision": report["revision"],
              "snapshot_checksum": report["data"]["checksum"], "check_fingerprint": fingerprint}

    def encode():
        return json.dumps(result, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")

    for item in items[offset:offset + limit]:
        result["items"].append(item)
        following = offset + len(result["items"])
        result["next_offset"] = following if following < len(items) else None
        if len(encode()) > BYTE_LIMIT:
            result["items"].pop()
            if not result["items"]:
                raise ApiError(422, "review_item_too_large", "This complete review item exceeds the phone review limit. Nothing was cut off; use the full report review on another device.",
                               {"section": section, "offset": offset, "byte_limit": BYTE_LIMIT})
            break
    following = offset + len(result["items"])
    result["next_offset"] = following if following < len(items) else None
    return encode()
