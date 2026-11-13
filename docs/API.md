# smart_whs_v3 — API Reference (FE integration & testing)

Independent Express backend, contract identical to the NestJS mirror (`shared/api.interface.ts` of the main repo).

- **Base URL**: `http://<host>:3000/api/warehouse` (port via `PORT`)
- **Swagger UI**: `http://<host>:3000/api-docs` — spec JSON at `/api-docs.json`
- **Auth model (demo)**: no login. Every write request carries `actorId` (= `whs_user_role.id`, e.g. `EMP003`) in body; the service validates role + slot ownership and returns 403 `no_permission` on violation.
- **Error shape** (all non-2xx):

```json
{ "error": { "code": "BUSINESS_ERROR", "message": "no_permission", "timestamp": 1792141732604 } }
```

| HTTP | code | `message` values (TApiErrorCode) |
|---|---|---|
| 400 | VALIDATION_ERROR | `missing_fields: <field,...>` |
| 403 | BUSINESS_ERROR | `no_permission`, `slot_locked`, `wrong_password` (change-password) |
| 404 | BUSINESS_ERROR | `not_found`, `code_exists` (create slot), `account_exists`, `not_incoming_po`, `qty_exceed` … |
| 409 | BUSINESS_ERROR | `reset_disabled` (POST /reset) |
| 500 | INTERNAL_ERROR | unexpected |

> **T8 write policy** (user decision 2026-10-16): all writes to `t8_*` tables are disabled — SELECTs still run. `updateAccount` rejects changes to `name` / `email` / `employeeCode` (403 `no_permission`), only `username` is writable. `POST /reset` returns 409 `reset_disabled` and only reseeds `whs_*` in the app-internal seed; it never touches your real data.
>
> **Test accounts** (2026-10-16, while real `t8_bas_emp` data is not yet available): 2 raw test accounts are hardcoded in `src/config/test-accounts.js` and **inserted into `whs_user_role` on server startup** (idempotent — INSERT only if the `emp_no` doesn't exist, never deletes/modifies any other row). Name/email come from the raw code data when the account has no T8 profile. Remove this file + its 2 usage points when real employee data is integrated.

| actorId | role | name | username | password |
|---|---|---|---|---|
| `TEST-MGR` | MANAGER (CHỦ QUẢN) | Chủ quản Test | test.manager | 123456 |
| `TEST-KPR` | KEEPER (THỦ KHO) | Thủ kho Test | test.keeper | 123456 |

Response field names follow `shared/api.interface.ts` (`ILotV2`, `IAccount`, `IShelfSlot`, `IIncomingPo`, `IActivity`) — see that file for full TypeScript definitions.

---

## Read endpoints

### GET `/` — bootstrap (legacy)
Returns `{ accounts, slots, lots, incomingPos, activity }`. `actorId` is not required. **FE no longer calls this** — it was split (2026-10-16) into the per-domain GETs below so each domain can be loaded/refreshed independently when data grows. Kept for compatibility.

### GET `/accounts` — account list (split from bootstrap, paged)
Returns `IAccount[]`, sorted by id (`ORDER BY r.emp_no`).

### GET `/slots` — full slot list (split from bootstrap, paged)
Returns `IShelfSlot[]` (every slot, one row each, with keeper/status).

### GET `/lots` — lot list (split from bootstrap, paged)
Returns `ILotV2[]` (one row per allocation, same order as bootstrap: `assignedAt` desc). SQL paging order: `ORDER BY a.allocated_at DESC, a.id DESC`.

### GET `/incoming-pos` — incoming POs (split from bootstrap, paged)
Returns `IIncomingPo[]` (open + history POs, sorted by id numeric). SQL paging order: `ORDER BY o1.close_sw, o2.del_date, o2.id`.

#### Pagination for `/accounts`, `/slots`, `/lots`, `/incoming-pos` (added 2026-10-17)

| param | type | default | notes |
|---|---|---|---|
| `page` | int ≥ 1 | 1 | 1-indexed |
| `pageSize` | int 1–200 | 100 | |

- **No `page`/`pageSize` → full array** (backward compatible, FE bootstrap path unchanged).
- **Any of them passed → `{ items, total, page, pageSize }`** (SQL-side `LIMIT/OFFSET` on pg, `OFFSET/FETCH` on SQL Server — same dialect handling as `/pos`).
- `total` = COUNT over the same WHERE (for `/slots` it wraps the GROUP BY subselect; for `/lots` counts `whs_slot_allocation` directly).

### GET `/pos` — search incoming POs (paged)
Query params (invalid values fall back to defaults):

| param | type | default | notes |
|---|---|---|---|
| `keyword` | string | `''` | matches PO number / material / supplier / item code |
| `bucket` | `today` \| `upcoming` \| `od12` \| `od23` \| `od3p` | none (all) | ETA buckets: today, next 10 days, overdue 1–2 days, 2–3 days, 3+ days |
| `page` | int ≥ 1 | 1 | |
| `pageSize` | int 1–100 | 15 | |

Response: `{ items: IIncomingPo[], total, page, pageSize, buckets: { today, upcoming, od12, od23, od3p } }` — `buckets` counts distinct PO numbers per ETA bucket for the current keyword (badge counters in FE).

**Row model (rewritten 2026-10-17)** — each result row is one of two kinds (split per `po + goods_no + lot_no`):

1. **PO gap row** (`id = <order2.id>`): portion of the PO line that has no notice yet — `qty = sheet_qty − SUM(noticed qty of un-GRN'd notices)`, `assignedQty` = unmatched (unconfirmed) active allocations of the PO line. Shown when `qty − assignedQty > 0`.
2. **Notice lot row** (`id = "<order2.id>-N<notice2.id>"`, `lotNo` = notice `made_lot`): one row per T8 notice lot — `qty = notice2.sheet_qty`, `assignedQty` = active allocations matched to that notice. Shown when `qty − assignedQty > 0`.

Exclusion: notice lines already in `t8_pur_in2` are dropped **per line** (`notice_id` + `goods_no`), so a fully received notice lot disappears from the inbox. `poLine` stays `order2.id` in both kinds, so `POST /assign` is unaffected.

> Memory-mode note: the in-memory T8 simulator (`ensureNoticeForPo`) can create a notice covering the **full** PO qty for an unmatched allocation; in that edge the gap row collapses to 0 and only the notice row remains (`qty = full PO qty`). SQL modes never auto-create notices (t8 writes disabled).

### GET `/slots/search?keyword=` — slot code search
Returns `{ codes: string[] }` (max ~20, prefix/substring match on slot code). Used by the shelf-picker autocomplete. **Moved from `/slots?keyword=`** on 2026-10-16 because `GET /slots` is now the full slot list.

### GET `/activity` — operation log (paged)
Query: `keyword` (PO / slot / user), `page` (default 1), `pageSize` (default 20).
Response: `{ items: IActivity[], total, page, pageSize }`, newest first.

---

## Write endpoints

### POST `/assign` — assign arrived PO to shelf (THỦ KHO)
Body: `{ actorId, poId, slotCode, qty, note? }`
- 404 `not_incoming_po` if the PO line isn't an arrived, confirmed incoming PO; `qty_exceed` if `qty` > remaining.
- If the PO already has an unconfirmed T8 notice for the same material, the notice is matched + confirmed; otherwise the lot is created unconfirmed (`noticeDetailId: null`).

Response **201** — created/updated `ILotV2` (status `WAITING_IQC`).

### POST `/lots/:id/iqc` — inject IQC decision (simulated T8 push)
Body: `{ actorId, decision: 'PASS'|'FAIL_PENDING'|'EXEMPT'|'RETURN' }`
- Applies the decision down to each active allocation of the lot; `FAIL_PENDING` keeps `WAITING_IQC` + `hasWarning: true`.
- Production path: IQC Auto Sync Worker (T8 `adj_result`/`pro_result` → `PASS` / `EXEMPT` / `FAIL_ACCEPT` / `FAIL_RETURN`, status `WAITING_STOCK` / `RETURNED`).

Response **201** — updated `ILotV2` (with `iqcHistory`).

### POST `/lots/:id/move` — move qty to another shelf (THỦ KHO, slot owner)
Body: `{ actorId, targetSlotCode, qty }` — partial moves into a slot that already holds the same notice merge `allocatedQty` (no duplicate allocation row).
Response **201** `{ ok: true }`.

### POST `/slots` — create shelf slot (CHỦ QUẢN)
Body: `{ actorId, warehouse, row, floor, position }` → code `WAREHOUSE-ROW-FLOOR-POSITION` (uppercase). 404 `code_exists` on duplicate.
Response **201** — created `IShelfSlot` (keeper unassigned, active).

### POST `/slots/assign-keeper` — bulk assign keeper (CHỦ QUẢN)
Body: `{ actorId, codes: string[], keeperId }` — unknown codes are skipped.
Response **201** `{ ok: true }`.

### PATCH `/slots/:code` — toggle slot flags
Body: `{ actorId, locked?, full?, active? }`
- `locked` / `full` / `active`: MANAGER only (keeper gets 403). `full` cannot be set on a slot that still holds stock (`qty_exceed`-style 404 `slot_has_stock`).
Response `{ ok: true }`.

### POST `/accounts` — create account (CHỦ QUẢN)
Body: `{ actorId, name, employeeCode, email, username, role: 'KEEPER'|'MANAGER' }`
- Account id duplicates → 404 `account_exists`.
- T8 requirement (employee must exist in `t8_bas_emp` → 404 `not_found`) is **temporarily commented out** in code (real T8 data not yet available; the guard code is kept, not deleted — re-enable when real employee profiles exist). `name`/`email` in the request are accepted but the API shows name fallback = employeeCode until a T8 profile exists.
Response **201** — created `IAccount`.

### PATCH `/accounts/:id` — update account (CHỦ QUẢN)
Body: `{ actorId, name?, email?, employeeCode?, username? }`
- Only `username` is really writable; `name`/`email`/`employeeCode` must equal current values (send back what the API returned) or → 403 `no_permission` (T8 read-only).
Response `{ ok: true }`.

### POST `/accounts/change-password`
Body: `{ actorId, newPassword, confirm }` — `confirm` must equal `newPassword` (else 400).
Response **201** `{ ok: true }`.

### POST `/accounts/:id/lock` — toggle lock (CHỦ QUẢN)
Body: `{ actorId }` (in path + body). Locked accounts cannot act as `actorId`.
Response **201** `{ ok: true }`.

### POST `/accounts/:id/reset-password` (CHỦ QUẢN)
Body: `{ actorId, newPassword }`. Response **201** `{ ok: true }`.

### POST `/activity/qr-print` — log QR label printing (CHỦ QUẢN)
Body: `{ actorId, codes: string[] }`. Response **201** `{ ok: true }`.

### POST `/reset` — reseed demo data (DISABLED)
Returns **409** `{ error: { code: "BUSINESS_ERROR", message: "reset_disabled" } }`. Requires code change + your approval to re-enable.

---

## Test checklist (clone → real SQL Server)

1. `cp .env.example .env`, set `DB_MODE=sqlserver` + server/user/password/db.
2. Run `db/sqlserver-schema.sql` once (creates `whs_*` + `t8_*` mock + view).
3. `npm install && npm start`, open `/api-docs` and try the flow:
   - `GET /` → note account ids (seeded EMP001–EMP003 or your own `whs_user_role` rows)
   - `GET /pos?bucket=today` → pick an arrived PO
   - `POST /assign` (actor = KEEPER) → `POST /lots/:id/iqc` (decision PASS / EXEMPT…)
   - `POST /lots/:id/move`, `PATCH /slots/:code`, account endpoints as above
4. Expected error paths worth testing: assign to locked slot (403 `slot_locked`), non-keeper creating slot (403 `no_permission`), `POST /reset` (409).
