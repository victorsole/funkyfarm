"""Stream original organizer Challenge 1 rows into a review-only fact CSV.

No application records are created. Import the CSV with grain
holding_id,year,key; promote a row only after reviewing its value_json and
provenance. Organizer values describe synthetic holdings, not real growers.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from pathlib import Path
import re
import sys
import zipfile


TABLE = "combined_challenge1_farm_reporting_ready"
DATA_MEMBER = f"combined/{TABLE}.csv"
COUNTRIES = ("DE", "ES", "FR", "IT", "NL", "PL")
NULL = "\\N"
DEFAULT_COLUMNS = (
    "uaa_ha", "organic", "anc_flag", "natura2000_flag",
    "main_livestock_category", "total_livestock_units", "stocking_density_lu_ha",
    "subsidies_excl_investment_eur", "payment_total_eur", "payment_biss_eur",
    "payment_eco_scheme_eur", "payment_anc_eur", "total_output_eur",
    "total_inputs_eur", "cash_flow_eur", "economics_fertiliser_eur",
    "economics_crop_protection_eur", "static_labour_awu",
    "yield_wheat_t_ha", "yield_maize_t_ha",
)
# The organizer explicitly says structure/labour/livestock are static. Mixed
# "row.year; structural fields static" lineage cannot make those annual events.
ANNUAL_INDICATORS = frozenset({
    "subsidies_excl_investment_eur", "direct_payments_eur",
    "basic_income_support_eur", "crop_subsidies_eur", "livestock_subsidies_eur",
    "environmental_subsidies_eur", "lfa_anc_subsidies_eur",
    "rural_development_eur", "yield_wheat_t_ha", "yield_maize_t_ha",
    "total_output_eur", "total_inputs_eur", "farm_net_value_added_eur",
    "fnva_per_awu_eur", "cash_flow_eur", "gross_investment_eur", "year",
})
HEADERS = (
    "holding_id", "year", "country", "key", "label", "value_json",
    "raw_value", "unit", "period", "temporal_basis", "review_status",
    "source_path", "source_sha256", "source_row", "source_key",
    "source_column", "source_grain", "source_units", "source_reference_period",
    "source_table", "source_column_or_rule", "value_origin", "sqlite_type",
    "source_version", "lineage_path", "lineage_sha256", "temporal_warning",
    "dataset_status",
)
JSON_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\Z")


class SourceError(ValueError):
    pass


def area_argument(value):
    try:
        return Decimal(value)
    except InvalidOperation as exc:
        raise argparse.ArgumentTypeError("Area must be a decimal number of hectares.") from exc


class OrganizerSource:
    def __init__(self, path: Path):
        self.path = path.resolve(strict=True)
        self.archive = zipfile.ZipFile(self.path) if self.path.is_file() else None
        if self.archive is not None:
            self.names = self.archive.namelist()
        elif not self.path.is_dir():
            raise SourceError("Source must be the original ZIP or extracted dataset directory.")

    def close(self):
        if self.archive is not None:
            self.archive.close()

    def member(self, relative: str):
        if self.archive is not None:
            matches = [n for n in self.names if n == relative or n.endswith("/" + relative)]
            if len(matches) != 1:
                raise SourceError(f"Expected one original source member: {relative}; found {len(matches)}.")
            return matches[0]
        for prefix in (self.path, self.path / "dg-agri-hackathon-datasets"):
            candidate = prefix / relative
            if candidate.is_file():
                return candidate
        raise SourceError(f"Original dataset file unavailable: {relative}")

    @contextmanager
    def binary(self, member):
        with (self.archive.open(member) if self.archive is not None else member.open("rb")) as stream:
            yield stream

    def location(self, member):
        return f"{self.path}!/{member}" if self.archive is not None else str(member.resolve())

    def digest(self, member):
        with self.binary(member) as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()

    def rows(self, member):
        with self.binary(member) as binary:
            with io.TextIOWrapper(binary, encoding="utf-8-sig", newline="") as stream:
                reader = csv.DictReader(stream, strict=True)
                columns = reader.fieldnames
                if not columns or len(columns) != len(set(columns)) or any(not c for c in columns):
                    raise SourceError(f"Empty or duplicate source headers: {member}")
                for number, row in enumerate(reader, 2):
                    if None in row or any(value is None for value in row.values()):
                        raise SourceError(f"Ragged source record {member}, CSV record {number}.")
                    yield number, row


def load_metadata(source):
    lineage_member = source.member("combined/combined_column_provenance.csv")
    lineage = {}
    for _, row in source.rows(lineage_member):
        if row["published_table"] == TABLE:
            column = row["published_column"]
            if column in lineage:
                raise SourceError(f"Duplicate column lineage: {column}")
            lineage[column] = row
    table_member = source.member("combined/combined_table_provenance.csv")
    tables = [row for _, row in source.rows(table_member) if row["published_table"] == TABLE]
    if len(tables) != 1 or tables[0]["grain_keys"] != "holding_id,year":
        raise SourceError("Organizer metadata does not establish the expected holding_id,year grain.")
    if not lineage:
        raise SourceError("Organizer column provenance is missing.")
    return lineage, tables[0], source.location(lineage_member), source.digest(lineage_member)


def select_rows(source, member, countries, years, per_country, max_area):
    chosen = {country: [] for country in countries}
    result = {}
    for number, row in source.rows(member):
        country, year, holding = row["country"], row["year"], row["holding_id"]
        if country not in chosen or year not in years:
            continue
        if not holding or holding == NULL:
            raise SourceError(f"Missing holding identifier at source record {number}.")
        raw_area = row["uaa_ha"]
        if raw_area in ("", NULL):
            continue
        try:
            area = Decimal(raw_area)
        except InvalidOperation as exc:
            raise SourceError(f"Invalid UAA at source record {number}: {raw_area!r}") from exc
        if not area.is_finite() or area < 0:
            raise SourceError(f"Invalid UAA at source record {number}: {raw_area!r}")
        if holding not in chosen[country]:
            if area >= max_area or len(chosen[country]) >= per_country:
                continue
            chosen[country].append(holding)
        key = (holding, year)
        if key in result:
            raise SourceError(f"Duplicate original holding/year grain {key!r}; refusing repeated annual totals.")
        if area >= max_area:
            raise SourceError(f"Selected holding {holding} is not below {max_area} ha in {year}.")
        result[key] = (number, row)
    for country, holdings in chosen.items():
        if len(holdings) != per_country:
            raise SourceError(f"Only {len(holdings)} qualifying holdings for {country}; requested {per_country}.")
        for holding in holdings:
            for year in years:
                if (holding, year) not in result:
                    raise SourceError(f"Missing requested source year {year} for {holding}.")
    return sorted(result.values(), key=lambda item: item[0])


def temporal(column, metadata):
    reference = metadata["reference_period"]
    if reference.startswith("static"):
        return "static", ""
    if reference == "row.year":
        return "campaign_year", ""
    if reference == "row.year; structural fields static":
        return ("campaign_year", "") if column in ANNUAL_INDICATORS else ("static", "structural source; not a new annual observation")
    return "static", "ambiguous/diagnostic metadata retained as undated reference context"


def value_json(raw, metadata, column):
    if raw == NULL:
        return "null"
    if raw == "":
        return '""'
    # IDs and code lists remain strings, even when they happen to be digits.
    numeric = metadata["sqlite_type"] in ("REAL", "INTEGER") or metadata["unit_or_coding"] in {"EUR", "ha", "t/ha", "LU/ha"}
    numeric = numeric and "code" not in metadata["unit_or_coding"]
    numeric = numeric and not column.endswith("_id") and column != "year"
    if numeric:
        if not JSON_NUMBER.fullmatch(raw):
            raise SourceError(f"Invalid numeric source lexeme for {column}: {raw!r}")
        return raw
    return json.dumps(raw, ensure_ascii=False)


def proposals(rows, columns, lineage, table, source_path, source_hash, lineage_path, lineage_hash):
    for number, row in rows:
        for column in columns:
            metadata = lineage[column]
            raw = row[column]
            basis, warning = temporal(column, metadata)
            units = metadata["unit_or_coding"]
            yield {
                "holding_id": row["holding_id"], "year": row["year"], "country": row["country"],
                "key": column, "label": column.replace("_", " "),
                "value_json": value_json(raw, metadata, column), "raw_value": raw,
                "unit": units, "period": row["year"] if basis == "campaign_year" else "",
                "temporal_basis": basis, "review_status": "proposed",
                "source_path": source_path, "source_sha256": source_hash,
                "source_row": number,
                "source_key": json.dumps({"holding_id": row["holding_id"], "year": row["year"]}, separators=(",", ":")),
                "source_column": column, "source_grain": table["grain_keys"],
                "source_units": units, "source_reference_period": metadata["reference_period"],
                "source_table": metadata["source_table"], "source_column_or_rule": metadata["source_column_or_rule"],
                "value_origin": metadata["value_origin"], "sqlite_type": metadata["sqlite_type"],
                "source_version": table["source_version"], "lineage_path": lineage_path,
                "lineage_sha256": lineage_hash, "temporal_warning": warning,
                "dataset_status": "organizer synthetic; not representative grower evidence",
            }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[2] / "EU-Agri-Hackathon-2026" / "all-datasets.zip")
    parser.add_argument("--output", type=Path, help="New UTF-8 CSV file; omit to write CSV to stdout. Existing files are never replaced.")
    parser.add_argument("--countries", nargs="+", default=list(COUNTRIES))
    parser.add_argument("--years", nargs="+", default=["2026"])
    parser.add_argument("--per-country", type=int, default=1)
    parser.add_argument("--max-area", type=area_argument, default=Decimal("5"), help="Strict upper UAA bound in hectares, default 5.")
    parser.add_argument("--columns", nargs="+", default=list(DEFAULT_COLUMNS), help="Source columns, or the single word all.")
    args = parser.parse_args(argv)
    if not 1 <= args.per_country <= 100 or not args.max_area.is_finite() or args.max_area <= 0:
        parser.error("--per-country must be 1..100 and --max-area must be finite and positive.")
    countries = list(dict.fromkeys(c.upper() for c in args.countries))
    years = list(dict.fromkeys(args.years))
    if not countries or any(c not in COUNTRIES for c in countries):
        parser.error("Organizer synthetic countries are DE ES FR IT NL PL.")
    if any(not re.fullmatch(r"[0-9]{4}", y) for y in years):
        parser.error("Years must be four-digit source campaign years.")
    source = None
    try:
        source = OrganizerSource(args.source)
        member = source.member(DATA_MEMBER)
        lineage, table, lineage_path, lineage_hash = load_metadata(source)
        columns = list(lineage) if args.columns == ["all"] else list(dict.fromkeys(args.columns))
        if any(column not in lineage for column in columns):
            raise SourceError("Unknown or undocumented columns: " + ", ".join(c for c in columns if c not in lineage))
        rows = select_rows(source, member, countries, years, args.per_country, args.max_area)
        if len(rows) * len(columns) > 50000:
            raise SourceError("Selection exceeds the 50,000-row import limit; select fewer holdings, years or columns.")
        digest = source.digest(member)
        # Validate every selected cell before creating any output file.
        for _, row in rows:
            for column in columns:
                value_json(row[column], lineage[column], column)
        output = args.output.open("x", encoding="utf-8", newline="") if args.output else sys.stdout
        try:
            writer = csv.DictWriter(output, fieldnames=HEADERS, lineterminator="\n")
            writer.writeheader()
            writer.writerows(proposals(rows, columns, lineage, table, source.location(member), digest, lineage_path, lineage_hash))
        finally:
            if args.output:
                output.close()
        print(json.dumps({"source_sha256": digest, "source_rows": len(rows), "proposal_rows": len(rows) * len(columns), "countries": countries, "years": years, "source_grain": "holding_id,year", "import_grain": "holding_id,year,key", "review_required": True}), file=sys.stderr)
        return 0
    except (OSError, SourceError, csv.Error, zipfile.BadZipFile, KeyError) as exc:
        print(f"Organizer import refused: {exc}", file=sys.stderr)
        return 2
    finally:
        if source is not None:
            source.close()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", newline="")
    raise SystemExit(main())
