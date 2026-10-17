# funkyfarm

Check field outlines before filing and prepare corrections when something is wrong. Keep the original records, review the changes and download the paperwork.

[Open funkyfarm](https://funkyfarm.elfeel.me/)

## Start with your farm

Create an account, add your farm, then choose **Check my fields** or **Fix a filed mistake** on Home. Check one issue at a time, edit the map and review each reused answer. You choose whether to give an adviser access.

Open the [Hackathon demo](https://funkyfarm.elfeel.me/demo) for the Spain pasture case: check the map, compare the claim and reference figures, review the correction and prepare its folder. **Try a sample farm** offers seven fictional scenarios with 39 editable records in a separate workspace. **Start again** keeps your previous work. Nothing is sent to an authority.

Web, Android and iOS share a private PostgreSQL API. Connected assistants can suggest changes; people approve them.

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
