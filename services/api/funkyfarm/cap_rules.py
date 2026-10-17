"""Pure parcel-correction preparation guidance; never authority permission."""

from copy import deepcopy
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import re

_PATH = Path(__file__).resolve().parents[3] / "shared" / "cap-correction-rules.json"
_RULES = json.loads(_PATH.read_text(encoding="utf-8"))
RULE_VERSION = _RULES["version"]
RULE_HASH = hashlib.sha256(json.dumps(_RULES, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def rule_catalogue():
    """A copy of the installed citation registry, not a live legal lookup."""
    return deepcopy(_RULES)


def _date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _source_pointer(value):
    return (isinstance(value, dict) and isinstance(value.get("kind"), str) and bool(value["kind"].strip())
            and isinstance(value.get("id"), str) and bool(value["id"].strip())
            and type(value.get("revision")) is int and value["revision"] > 0)


def evaluate_correction(context, today=None):
    """Evaluate supplied context only, without DB/network access or inferred facts.

    A caller must authorise source pointers separately. Even a structurally valid
    pointer does not verify national law. Missing facts cannot grant permission.
    """
    context = context if isinstance(context, dict) else {}
    today = today if isinstance(today, date) else date.today()
    missing, restrictions, selected_sources = [], [], ["beneficiary_responsibility", "official_channel", "correction_deadline"]
    dates = {key: _date(context.get(key)) for key in ("filed_on", "national_deadline", "first_instalment_on", "check_announced_on")}
    invalid = [key for key, value in dates.items() if context.get(key) not in (None, "") and value is None]
    invalid.extend(key for key in ("filed_on", "check_announced_on") if dates[key] and dates[key] > today)
    regime = context.get("regime", "unknown")
    national, instalment = dates["national_deadline"], dates["first_instalment_on"]
    applicable = regime in ("ams", "other", "animals")
    ceiling = instalment - timedelta(days=15) if applicable and instalment and instalment > date.min + timedelta(days=14) else None
    linked = _source_pointer(context.get("national_deadline_source"))
    deadline_status = "missing" if national is None else "source_linked_not_legally_verified" if linked else "unverified"
    if national and ceiling and national > ceiling:
        deadline_status = "eu_ceiling_conflict"
    effective = national if linked and national and ceiling and national <= ceiling else None
    deadlines = {"national": national.isoformat() if national else None,
                 "eu_latest_possible": ceiling.isoformat() if ceiling else None,
                 "effective": effective.isoformat() if effective else None, "status": deadline_status}
    fictional = context.get("fictional") is True

    def result(status, title, explanation):
        return {"status": status, "title": ("Fictional example — " if fictional else "") + title,
                "explanation": explanation, "missing": list(dict.fromkeys(missing)), "deadlines": deadlines,
                "restrictions": list(dict.fromkeys(restrictions)),
                "sources": [{"key": key, **deepcopy(_RULES["sources"][key])} for key in dict.fromkeys(selected_sources)],
                "rule_version": RULE_VERSION, "rule_hash": RULE_HASH, "fictional": fictional,
                "disclaimer": ("Fictional preparation example. " if fictional else "") + "Preparation guidance only, not legal eligibility, permission to amend or withdraw, submission, or authority acceptance. Source-linked dates still require the actual national rule and official instructions to be reviewed."}

    if regime not in ("ams", "other", "animals", "unknown"):
        missing.append("regime")
        return result("needs_information", "Check the intervention type", "Choose an explicitly established correction regime; do not infer it from the crop or farm type.")
    if regime == "animals":
        selected_sources.append("animal_correction")
        return result("not_covered", "Animal correction needs its own review", "This parcel-focused guide does not evaluate the separate animal identification/registration cutoff or automatic-claim withdrawal conditions.")
    if invalid:
        missing.extend(invalid)
        return result("needs_information", "Check the supplied dates", "Use real ISO dates. Original filing and check-notification dates must describe past or current events, not planned events.")
    if regime == "unknown":
        missing.append("regime")
    if dates["filed_on"] is None:
        missing.append("filed_on")
    if national is None:
        missing.append("national_deadline")
    if not linked:
        missing.append("national_deadline_source")
    if instalment is None:
        missing.append("first_instalment_on")
    channel = context.get("finding_channel", "unknown")
    scope = context.get("check_scope", "unknown")
    breach = context.get("non_monitorable_breach")
    if channel not in ("ams", "administrative", "outside_monitoring", "unknown"):
        missing.append("finding_channel")
        return result("needs_information", "Check how the finding was made", "Use the actual authority notice to identify the finding channel.")
    if scope not in ("affected", "unaffected", "unknown"):
        missing.append("check_scope")
        return result("needs_information", "Check which part is affected", "Keep the proposed change tied to its actual check scope.")
    if breach is not None and type(breach) is not bool:
        missing.append("non_monitorable_breach")
        return result("needs_information", "Check the condition type", "A non-monitorable breach must be explicitly yes, no or unknown.")
    if channel in ("ams", "administrative"):
        selected_sources.extend(["administrative_or_ams_finding", "ams_response"])
    if regime == "ams":
        selected_sources.append("ams_correction")
        if breach is None:
            missing.append("non_monitorable_breach")
        if dates["check_announced_on"]:
            restrictions.append("The AMS branch restricts amendments or withdrawals after the Member State has notified an intended on-site check. Do not borrow the other-intervention unaffected-part exception.")
            return result("restricted", "An announced check changes the route", "On the supplied AMS/check-notice facts, do not treat this as an ordinary amendment. Preserve the draft and ask the authority about the specific case and any separate applicable procedure.")
        if breach is True and channel == "outside_monitoring":
            restrictions.append("The AMS branch restricts changes concerning non-monitorable eligibility breaches revealed outside AMS or administrative checks.")
            return result("restricted", "The reported finding restricts this route", "Prepare the evidence privately, but seek the authority's instructions rather than assuming this breach can be removed by an ordinary amendment.")
        if (breach is True and channel == "unknown") or (channel == "outside_monitoring" and breach is None):
            missing.append("finding_channel" if channel == "unknown" else "non_monitorable_breach")
            return result("ask_authority", "Clarify this finding before choosing a route", "The supplied facts do not establish whether the AMS non-monitorable-condition restriction applies.")
    elif regime == "other":
        selected_sources.append("other_correction")
        restrictions.append("This context does not establish awareness arising from an unannounced on-site check. Review that condition separately; preparation is not permission.")
        if dates["check_announced_on"]:
            if scope == "affected":
                restrictions.append("An announced on-site check restricts ordinary changes concerning the affected part.")
                return result("restricted", "Check-related changes need the official route", "On the supplied check-scope facts, preserve the proposed correction and ask the authority about the affected part.")
            if scope == "unknown":
                missing.append("check_scope")
                return result("ask_authority", "Establish which part the check concerns", "Article 7 distinguishes unaffected parts; a general check announcement is insufficient to establish that exception for this change.")
            restrictions.append("The unaffected-part exception requires actual scope evidence concerning the detected on-site non-compliance; the date alone does not establish it.")
            return result("ask_authority", "Check the unaffected-part exception", "The reported unaffected scope may be relevant, but the actual check/finding and national instructions must establish the exception. The draft can still be prepared privately.")
    if deadline_status == "eu_ceiling_conflict":
        restrictions.append("The supplied national deadline is later than the calculated EU ceiling. Neither value has been silently substituted.")
        return result("ask_authority", "The supplied deadline needs checking", "Verify the applicable national rule and the first-instalment date. A computed ceiling cannot replace the authority's deadline.")
    if effective and today > effective:
        restrictions.append("The source-linked supplied national date has passed; this is not independent verification of the legal deadline or every exception.")
        return result("restricted", "The supplied correction window has passed", "Keep preparing the evidence, but ask the authority whether another correction route or exception applies. Do not assume an ordinary amendment is still timely.")
    if effective and today == effective:
        missing.append("national_deadline_time_and_timezone")
        return result("ask_authority", "Check today's exact cutoff", "The date alone does not establish the authority's closing time or timezone.")
    if missing:
        return result("needs_information", "Complete the correction context", "Keep working on the private draft. Establish the intervention, original filing, control-stage facts and sourced national timing before reviewing the ordinary correction route.")
    return result("may_prepare", "Prepare the correction for review", "The supplied context supports preparing a draft and its evidence. It does not establish legal permission, an unaffected-part exception, official transmission or acceptance. Check the national rule, control-stage facts and official channel with the authority before filing.")
