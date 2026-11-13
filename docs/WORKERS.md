# Background Workers — Receipt Sync (BullMQ + Redis)

Developer note cho worker nền. Task gốc: **Temporary Receipt Sync Worker** —
tự động kiểm tra T8 `pur_notice2`, lấy `made_lot`, tạo `whs_allocation_receipt`
và reconcile quantity. Infrastructure viết để **IQC Worker sau này reuse
ngay, không copy-paste**.

## Receipt Worker làm gì

Sau khi user Assign Shelf (tạo `whs_slot_allocation`), worker chạy nền:

```text
kiểm tra T8 pur_notice2 (theo PO + goods + def02 + ngày giao)
→ tìm đúng Temporary Receipt
→ tạo whs_allocation_receipt (made_lot)
→ reconcile quantity (MATCHED / SHORTAGE / EXCESS)
→ update allocation: lot_no cache + warehouse_status TEMP_IN
```

Quy tắc business cốt lõi:

- `allocated_qty` là số user gán kệ — **KHÔNG BAO GIỜ bị ghi đè** bởi T8.
- Business lot = `pur_notice2.made_lot`. **KHÔNG dùng `sheet_lot`.**
- T8 quantity được phép > PO quantity (PO 29 / Receipt 42.2 là hợp lệ).
- SYSTEM chỉ sync allocation đã tồn tại — KHÔNG tự tạo allocation.

## Kiến trúc — job đi đâu

```text
POST /assign (lot.service)
  → queues/receipt-sync.queue.js  (enqueue, native deduplication)
  → Redis (BullMQ queue 'receipt-sync')
  → worker/receipt-sync.worker.js  (process riêng, npm run worker:receipt)
  → services/jobs/receipt-sync.job.js   (orchestration 1 job)
  → services/receipt-sync.service.js    (business state machine)
  → repository/sql/receipt-sync.repository.js (SQL)
  → SQL Server / PG
```

| File | Trách nhiệm |
|---|---|
| `src/config/worker.config.js` | Redis, queue name, technical retry, business retry schedule, sweep cron, concurrency, batch size |
| `src/util/worker/redis.js` | Redis connection factory (worker/producer, cached, event handlers) |
| `src/util/worker/queue.js` | Queue factory + defaultJobOptions (technical retry chung) |
| `src/util/worker/create-app-worker.js` | BullMQ Worker factory + event log + auto-đăng ký shutdown |
| `src/util/worker/graceful-shutdown.js` | SIGTERM/SIGINT handler, chạy các bước ngược thứ tự |
| `src/util/worker/errors.js` | 3 error class + `isRetryableError()` |
| `src/util/worker/logger.js` | Structured JSON logger (`scope` + `event` + context fields) |
| `src/queues/receipt-sync.queue.js` | `enqueueReceiptSync` / `scheduleReceiptSyncRetry` (producer side) |
| `src/worker/receipt-sync.worker.js` | Entrypoint process worker, upsert sweep scheduler |
| `src/services/jobs/receipt-sync.job.js` | Đọc job.data → gọi service → xử lý state → log |
| `src/services/receipt-sync.service.js` | State machine 8 trạng thái, transaction WHS writes |
| `src/repository/sql/receipt-sync.repository.js` | Read WHS/T8 + write receipt (parameterized, tx-aware) |

## Chạy local

```bash
# 1. Redis (local hoặc docker)
redis-server --port 6379        # hoặc REDIS_PORT=... để đổi

# 2. API server
npm start                        # PORT mặc định 3000

# 3. Worker process RIÊNG
npm run worker:receipt           # smart-whs-receipt-worker
```

Env (xem `.env.example`): `REDIS_HOST / REDIS_PORT / REDIS_PASSWORD /
REDIS_DB / REDIS_PREFIX / REDIS_TLS / RECEIPT_SYNC_BATCH_SIZE /
WORKER_RECEIPT_CONCURRENCY`.

Redis chưa sẵn sàng → API **KHÔNG treo, KHÔNG 500**: enqueue timeout 1.5s
trả false, chỉ log (KHÔNG có inline sync fallback) — sweep cron 5 phút
sẽ enqueue lại allocation pending khi Redis hồi, nên KHÔNG mất việc.

## Job payload

```js
/** @typedef {Object} ReceiptSyncJob */
// { allocationId: string, businessAttempt?: number }
```

Worker luôn đọc **fresh data từ DB** theo `allocationId` — không đưa full
allocation/PO/notice vào Redis.

**Dedup (BullMQ 6.4 native):** `deduplication: { id: 'receipt-sync-sync-<allocationId>' }`
— add trùng key khi job đang waiting/delayed/active trả về job cũ
(không nhân bản); key **tự giải phóng khi job completed/failed** →
allocation đã xong vẫn enqueue lại được ngay (bump `allocated_qty`
rồi re-sync là luồng chính quy). Cấm jobId cố định như cũ (chặn
re-enqueue sau completed) và cấm ký tự `:` trong custom jobId.

## Technical retry ≠ Business retry

| | Technical | Business |
|---|---|---|
| Khi nào | SQL timeout / deadlock / network (throw) | T8 chưa có notice / made_lot NULL (return state) |
| Cơ chế | BullMQ `attempts: 5`, exponential backoff 5s | Delayed job theo lịch tiệm tiến |
| Lịch | `defaultJobOptions` trong `util/worker/queue.js` | 30s → 1m → 5m → 15m → 30m (`worker.config.businessRetryDelayMs`), hết lịch thì sweep cron 5 phút lo |

## Business states

| State | Nghĩa |
|---|---|
| `MATCHED` | Receipt đã reconcile đủ số gán |
| `SHORTAGE` | T8 nhiều hơn số đã gán — phần dư hiện ở PO/Notice chờ user Assign thêm |
| `EXCESS` | Đã gán nhiều hơn T8 — `differenceQty` dương, allocated_qty giữ nguyên |
| `AMBIGUOUS` | Nhiều notice候选 không xác định được — KHÔNG ghi DB |
| `WAITING_T8_RECEIPT` | Chưa có pur_notice2 → business retry |
| `WAITING_LOT` | Có notice nhưng made_lot NULL → business retry |
| `DATA_ERROR` | Allocation/PO không tồn tại — không retry |
| `NO_OP` | Closed / đã nhận đủ — bỏ qua |

## SQL matching rule (T8 read-only)

```sql
n2.pur_no   = o2.sheet_no          -- KHÔNG dùng n2.pur_id = o2.id
AND n2.goods_no = o2.goods_no
AND (n2.def02 = o2.def02 OR (cả hai NULL))
AND n2.def23 >= CONVERT(date, o2.del_date)
AND n2.def23 <  DATEADD(DAY, 1, CONVERT(date, o2.del_date))
```

Reference thật: `pur_order2.id 341179` → `pur_notice2.id 340417`
→ lot `0221007-Z-1-A`. Đủ cả trong fixture `tmp/worker-fixtures.js`.

## Idempotency & concurrency

- `UNIQUE(allocation_id, notice_detail_id)` trên `whs_allocation_receipt`:
  INSERT đụng UQ (job chạy lại sau crash) → retryable, lần sau chuyển nhánh
  GROW (đã có sẵn hàng → UPDATE tăng received_qty, không nhân bản dòng).
- **Re-sync khi bump `allocated_qty` là luồng chính quy**: receipt có sẵn
  sẽ GROW lên số mới (1 dòng duy nhất), re-sync không đổi gì → NO_OP
  (`already_received`) — không bao giờ nhân đôi số.
- **Notice-level lock chống over-consume**: trong transaction, trước khi
  tính remaining của notice → `acquireNoticeLock(noticeId)`
  (pg: `pg_advisory_xact_lock(9201, noticeId)`; mssql:
  `sp_getapplock @LockOwner='Transaction', @LockTimeout=15s`). 2 worker
  reconcile cùng notice bị tuần tự hóa; thằng sau **tính lại remaining
  fresh sau khi có khóa** → tổng receipt của 1 notice không bao giờ vượt
  `t8_pur_notice2.sheet_qty`. Khóa theo notice (scope nhỏ) + tự release
  khi tx kết thúc.
- Mọi WHS write của 1 reconciliation nằm trong **1 transaction ngắn**
  (`db.withTransaction`): lock notice → recheck remaining → insert/grow
  receipt → update allocation (lot cache + TEMP_IN) → COMMIT. Không giữ
  transaction khi chờ T8.
- Sweep (cron 5 phút) là **batch set-based**: 1 câu candidates WHS +
  tối đa 2 câu T8 (theo tập poIds) + 1 câu WHS tổng hợp — KHÔNG N+1 theo
  allocation; chỉ enqueue allocation actionable (còn dư notice).
  Sweep cũng là cơ chế **recovery**: allocation bị bỏ sót (enqueue lỗi
  Redis, job thất bại hết lịch) đều được quét lại.

## Debug failed/delayed job

- Log là JSON 1 dòng: lọc `scope:"receipt-sync-job"`, `event:"sync_result"`
  xem state mỗi job (jobId, allocationId, poId, noticeDetailId, state,
  differenceQty, durationMs).
- `npm run worker:receipt` foreground để xem trực tiếp.
- Redis CLI: `redis-cli` → `KEYS bull:receipt-sync:*`, delayed jobs nằm
  trong zset `bull:receipt-sync:delayed`.
- Sweep cron `*/5 * * * *` tự enqueue lại các allocation pending
  (batch `RECEIPT_SYNC_BATCH_SIZE`, default 200) — không cần can thiệp tay.

## Thêm IQC Worker sau này

Giữ nguyên luồng và chỉ viết phần business:

```text
workers/iqc-sync.worker.js          (entrypoint — ~60 dòng, copy receipt rồi đổi tên/queue/processor)
services/jobs/iqc-sync.job.js       (orchestration IQC job)
services/iqc-sync.service.js       (business IQC — viết hoàn toàn mới)
repositories/iqc-sync.repository.js (SQL IQC — viết mới)
queues/iqc-sync.queue.js            (enqueue IQC — tham khảo receipt)
```

REUSE TRỰC TIẾP (không copy): `config/worker.config.js` (thêm queue name +
retry policy riêng nếu cần), `util/worker/redis.js`, `util/worker/queue.js`
(truyền queueName), `util/worker/create-app-worker.js` (truyền
queueName + processor), `util/worker/errors.js`,
`util/worker/graceful-shutdown.js`, `util/worker/logger.js`.

Cú pháp chuẩn BullMQ 6: cron dùng `queue.upsertJobScheduler(id, {pattern}, {name, data})`
— KHÔNG dùng `queue.add(..., {repeat})` (đã bỏ từ BullMQ 6, bỏ qua im lặng).
