# funkyfarm

Keep farm work, field details and paperwork together. Add a letter, notebook photo or invoice, check the saved details, and reuse them when preparing a response.

[Open funkyfarm](https://funkyfarm.elfeel.me/)

## Start with your farm

Create an account, add your farm, then choose what you need on Home: record work, read a letter, check fields, correct a mistake or prepare for inspection. Each task guides you through the missing details, review and download. You choose whether to give an adviser access.

To try it first, choose **Open the sample farm** on Home. The fictional CAP example covers a field difference, missing records, a correction and a downloadable folder. Nothing is sent to an authority.

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

The logo uses [Barn](https://game-icons.net/1x1/delapouite/barn.html) by [Delapouite](https://delapouite.com/), licensed separately under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The SVG and PNG artwork are unchanged; the iOS interface may tint it for light or dark appearance. See the [artwork attribution](apps/web/public/assets/barn-LICENSE.txt).
