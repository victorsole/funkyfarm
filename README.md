# funkyfarm

Check fields, import records and prepare paperwork one step at a time. Keep the originals, review changes and download the paperwork.

[Open funkyfarm](https://funkyfarm.elfeel.me/)

## Start with your farm

Create an account, add your farm and open **Easy form** on Home. Check saved details, type any crop and save changes for review. Use **Check my fields** or **Fix a filed mistake** when needed. You choose whether to give an adviser access.

Open the [Hackathon demo](https://funkyfarm.elfeel.me/demo) to compare a staged claim mistake with five real SIGPAC parcels and an official PNOA aerial photo near Cáceres. Save and review a private correction, import a record, then check the paperwork and sourced date conditions. The public parcels do not establish farm ownership or payment eligibility. Seven sample situations contain 39 editable records in a separate workspace. **Start again** keeps your previous work. Official sending stays with you.

The other map examples use 2025 Dutch public parcel boundaries and attributed Czech and Slovak OpenStreetMap outlines. OpenStreetMap outlines are not official LPIS boundaries. Claims, notices and work records are practice examples, separate from the source maps.

The web app uses a private PostgreSQL API. Connected assistants can suggest changes; people approve them.

**Farm tools** also includes a community feed and private adviser inbox, searchable adviser farms, task documents, editable spreadsheet suggestions, satellite field images and saved official-site handoffs. Rule and funding pages show recorded source changes and the last successful check; you decide whether to create a follow-up. Connected assistants can read these tools within the farms you allow. Government sign-in and final submission stay on the official service.

The core release is tagged [1.0](https://github.com/mahmoudelfeelig/funkyfarm/tree/1.0).

## Run

Local setup uses PowerShell, Python 3.11 or later, Node 24 and Docker.

```powershell
./scripts/Local.ps1 setup
./scripts/Local.ps1 api
```

In another terminal:

```powershell
cd apps/web
npm ci
npm run dev
```

Open `http://127.0.0.1:5189`. The API runs on port `8139`.

For a populated local jury account, run `.venv/Scripts/python.exe scripts/seed_jury.py --create-local-jury` while the API is running. It creates or resumes seven sample farms and private adviser conversations. Sign-in details and the demo link stay in `runtime/jury/local-credentials.json`; do not publish that file.

Software licensed under [AGPL-3.0-or-later](LICENSE).

The current logo was supplied by the project owner and is used unchanged. Notices for earlier third-party artwork remain with those assets.
