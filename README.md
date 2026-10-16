# funkyfarm

Farm records and guided paperwork for farmers and advisers. Keep documents, record work, check missing details, review field corrections and prepare forms without entering the same information repeatedly.

Web, Android and iOS use a private PostgreSQL API. Connected assistants can suggest changes; people approve them.

## Run

Requires Python 3.13, Node 24 and Docker.

```powershell
./scripts/Local.ps1 setup
./scripts/Local.ps1 api
```

In `apps/web`, run `npm ci` and `npm run dev`. Open `http://127.0.0.1:5189`.

## Limits

Prepared forms are not government submissions. Legal and country coverage is partial and needs qualified review. iOS and physical-device checks remain pending. Never commit real farm data or `runtime/`.
