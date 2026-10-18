"""SIGPAC public reads: bounded, signed-in, whitelisted, and never the declared-crop layer."""

import httpx

DEMO = "10:50:0:0:13:29:1"


def test_sigpac_recintos_facts_and_elements_stay_bounded_and_whitelisted(farmers, authored_stac, service_url):
    reader = farmers("SIGPAC map reader")
    before = len(authored_stac["public_calls"])

    collection = reader.get("/sigpac/recintos?bbox=-6.4900,39.4880,-6.4450,39.5120").json()
    references = [feature["properties"]["reference"] for feature in collection["features"]]
    assert DEMO in references and len(references) == len(set(references)) == 5
    main = next(feature for feature in collection["features"] if feature["properties"]["reference"] == DEMO)
    assert main["properties"]["uso_sigpac"] == "PR"
    assert 62 < main["properties"]["approximate_area_ha"] < 64
    assert set(main["properties"]) == {"provincia", "municipio", "agregado", "zona", "poligono", "parcela", "recinto", "uso_sigpac",
                                       "pendiente_media", "altitud", "coef_regadio", "incidencias", "region", "reference", "approximate_area_ha"}
    lon, lat = main["geometry"]["coordinates"][0][0]
    assert -6.5 < lon < -6.4 and 39.4 < lat < 39.6
    areas = [feature["properties"]["approximate_area_ha"] for feature in collection["features"]]
    assert areas == sorted(areas, reverse=True)  # Largest first: drawn behind the smaller ones.
    assert "CC BY 4.0" in collection["source"]["attribution"]

    facts = reader.get("/sigpac/parcelas/10/50/0/0/13/29").json()
    row = next(item for item in facts["items"] if item["reference"] == DEMO)
    assert row["superficie"] == 63.0449 and row["admisibilidad"] == 90 and row["uso_sigpac"] == "PR" and row["recinto"] == 1
    assert "secret_field" not in row

    elements = reader.get("/sigpac/elementos?bbox=-6.4900,39.4880,-6.4450,39.5120").json()
    assert [(item["properties"]["kind"], item["properties"]["code"]) for item in elements["features"]] == [("area", "CH")]

    paths = [call["path"] for call in authored_stac["public_calls"][before:]]
    assert paths and all(path.startswith(("/sigpac/mvt/recinto@3857@geojson/15/", "/sigpac/servicioconsultassigpac/query/recinfoparc/",
                                          "/sigpac/ogcapi/collections/elementos_paisaje_")) for path in paths)
    assert not any("cultivo_declarado" in path for path in paths)

    # Outside Spain, too large, or signed out: refused before any official read.
    calls = len(authored_stac["public_calls"])
    reader.get("/sigpac/recintos?bbox=4.0,52.0,4.01,52.01", expected=422)
    reader.get("/sigpac/recintos?bbox=-7.0,39.0,-6.0,40.0", expected=422)
    reader.get("/sigpac/elementos?bbox=-7.0,39.0,-6.0,40.0", expected=422)
    assert len(authored_stac["public_calls"]) == calls
    anonymous = httpx.get(service_url + "/sigpac/recintos?bbox=-6.4900,39.4880,-6.4450,39.5120", timeout=10)
    assert anonymous.status_code == 401


def test_brp_parcels_for_the_netherlands_stay_bounded_and_whitelisted(farmers, authored_stac):
    reader = farmers("BRP map reader")
    collection = reader.get("/brp/percelen?bbox=4.9990,51.9990,5.0030,52.0020").json()
    assert sorted(feature["properties"]["category"] for feature in collection["features"]) == ["Gewasperceel", "Sloot"]
    crop = next(feature for feature in collection["features"] if feature["properties"]["category"] == "Gewasperceel")
    assert set(crop["properties"]) == {"category", "gewas", "gewascode", "jaar", "status", "reference", "approximate_area_ha"}
    assert crop["properties"]["gewas"] == "Wintertarwe" and crop["properties"]["approximate_area_ha"] > 0
    assert "public domain" in collection["source"]["attribution"]
    calls = len(authored_stac["public_calls"])
    reader.get("/brp/percelen?bbox=-6.49,39.48,-6.44,39.51", expected=422)
    reader.get("/brp/percelen?bbox=4.0,51.0,6.0,53.0", expected=422)
    assert len(authored_stac["public_calls"]) == calls
