# funkyfarm

Check fields, import records and prepare paperwork one step at a time. Keep the originals, review changes and download the paperwork.

[Open funkyfarm](https://funkyfarm.elfeel.me/)

## Start with your farm

Create an account, add your farm and open **Easy form** on Home. Check saved details, type any crop and save changes for review. Use **Check my fields** or **Fix a filed mistake** when needed. You choose whether to give an adviser access.

Open the [Hackathon demo](https://funkyfarm.elfeel.me/demo) for the seven-field Spain case: check the map, import a record through the actual reader, then review checks before and after filing. Deadline references include their sources and conditions. Seven sample situations contain 39 editable records in a separate workspace. **Start again** keeps your previous work. Official sending stays with you.

The web app uses a private PostgreSQL API. Connected assistants can suggest changes; people approve them.

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

Software licensed under [AGPL-3.0-or-later](LICENSE).

The current logo was supplied by the project owner and is used unchanged. Notices for earlier third-party artwork remain with those assets.
