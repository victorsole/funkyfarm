"""Run the ordinary worker entry point against one generated publisher fixture."""

import json

from provider_app import configure_regulatory_provider


if __name__ == "__main__":
    from funkyfarm.regulatory import poll_due

    source = configure_regulatory_provider()
    print(json.dumps(poll_due(limit=1, sources=[source])))
