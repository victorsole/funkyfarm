# FunkyFarmers

Private farm records and guided paperwork for farmers and advisers. Start with a letter, field correction, support application or inspection. Five main pages keep records, sources and next steps together. Web, native Android and native iOS share a PostgreSQL API with account and farm-level access controls.

Draw, edit, split and merge private field outlines; check paperwork before review; prepare source-backed checklists; follow official-source updates; and ask a named adviser or post a general community question. Connect your own Claude/ChatGPT to selected farms, or choose the bounded Hetzner-hosted helper. AI can propose changes, never approve or file them.

## Run locally

Use Python 3.13, Node 24 and Docker. From this folder:

```powershell
./scripts/Local.ps1 setup
./scripts/Local.ps1 api
```

In another terminal, run `npm ci` then `npm run dev` inside `apps/web`. Open `http://127.0.0.1:5189`.

Local secrets are generated under ignored `runtime/`, protected with Windows DPAPI. Never commit that directory or real farm records. The API uses a separate nonowner database identity with forced row-level security.

## Verify

Load `scripts/Environment.ps1`, then run `.venv/Scripts/python -m pytest tests -q --tb=short --basetemp=runtime/verification`. The integration suite includes the browser journeys; install their dependencies with `npm ci` in `tests/browser` and Playwright Chromium before running it. `npm run build` in `apps/web` checks TypeScript and builds the site.

Android uses the Gradle project in `apps/android`. iOS uses `apps/ios/project.yml`: generate with XcodeGen, then build the `FunkyFarmers` scheme with Xcode. Device and simulator results are separate from source completion.

## Deployment and limits

Target: `https://funkyfarmers.elfeel.me`, through the owner's private GitHub repository, immutable Hetzner release system and Cloudflare DNS. Application CI and the release manifest live in `.github`; host policy, private state, health gates and rollback belong to the separate deployment controller. Publication is not established until the live release is verified.

The EU27 directory separates common record exports, partial national mappings and documented connection routes. The legal catalogue covers selected duties, not every national rule. Unknown deadlines and applicability remain unknown. A changed source page is not automatically a changed law; an exported draft is not a filing or acceptance. Agency approval, current national-rule review, fluent-language review, actual assistant-account acceptance and consented grower validation remain separate gates. Satellite observations are context, not evidence of quantities, tenancy or exact operations. Detailed field editing and own-assistant setup open the website from native apps; iOS build/device verification needs the owner's Mac.

The locked product scope is `shared/scope.json`; API seams are in `shared/contract.json`. Verification artifacts and operational secrets stay outside version control.
