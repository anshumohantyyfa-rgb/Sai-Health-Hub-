# Sai-Health-Hub-
## Phase 1 — Persistence (durable storage)

Records are stored server-side and keyed to the browser that created them. Where they
live depends on configuration, and the app reports the real state on screen
(the status line in Backup, export & privacy, and `GET /api/storage`).

| Configuration | Driver | Survives reload | Survives redeploy |
|---|---|---|---|
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set and reachable | `supabase` | yes | **yes** |
| Not set (current default) | `sqlite` (or `json` on older Node) | yes | no — container storage is wiped |
| Remote configured but unreachable | local fallback | yes | no (reported as a warning) |

### Enabling the free durable database (Supabase)

1. Create a free project at supabase.com.
2. Open **SQL Editor**, paste `scripts/supabase-schema.sql`, run it. It creates
   `checkins` and `app_state` with Row Level Security enabled and **no** policies,
   so the public anon key cannot read anything.
3. In **Project Settings → API**, copy the Project URL and the `service_role` key.
4. Add them in AppJet **Settings → Environment variables** as `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`, then redeploy.

The service-role key is read only by the Node server and used only in server-to-database
requests. No key is ever sent to, or bundled with, frontend code.

### Backup and recovery

* **Per browser:** Backup panel → full JSON export, encrypted export, restore, delete.
* **Across browsers / after a lost device:** signed-in owner console →
  `GET /api/owner/export` returns every check-in and stored collection as one JSON file.

### Tests

`npm test` includes `test/supabase-store.js`, which runs the driver against a local
PostgREST-compatible fake and proves activation, header-only key handling,
write-through, survival across a simulated restart, export coverage and honest fallback.
