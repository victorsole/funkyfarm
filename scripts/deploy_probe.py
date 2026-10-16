"""Read-only public smoke checks for the assigned FunkyFarmers production host."""

import json
import urllib.error
import urllib.request


ORIGIN = "https://funkyfarmers.elfeel.me"


def main():
    checks = (("/", 200), ("/app/reports", 200), ("/health", 200),
              ("/api/v1/auth/session", 401), ("/private-documents/", 404),
              ("/runtime/", 404))
    results = []
    for path, expected in checks:
        request = urllib.request.Request(ORIGIN + path, headers={"Cache-Control": "no-cache"})
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.status
            if response.geturl().split("/", 3)[:3] != ORIGIN.split("/"):
                raise SystemExit("A public check unexpectedly left the assigned host.")
            results.append({"path": path, "status": status, "expected": expected,
                            "passed": status == expected})
    print(json.dumps({"origin": ORIGIN, "checks": results}, indent=2))
    if not all(result["passed"] for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
