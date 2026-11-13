# Docker Compose cho môi trường development

Compose chạy đúng bốn service: `app`, `redis`, `receipt-worker` và `ngrok`. Entrypoint API là `src/server.js`; worker là `src/worker/receipt-sync.worker.js`. API và worker đọc `.env`, dùng cùng SQL Server và Redis. Ngrok chuyển tiếp HTTPS công khai vào `app:3000` trên mạng Docker.

Trước khi chạy, mở Docker Desktop và điền `.env` theo `.env.example`: `MSSQL_HOST`, `MSSQL_PORT`, `MSSQL_DATABASE`, `MSSQL_USER`, `MSSQL_PASSWORD`, `JWT_SECRET`, `REDIS_PASSWORD` và `NGROK_AUTHTOKEN`. Nếu SQL Server nằm trên máy chạy Docker Desktop, dùng `MSSQL_HOST=host.docker.internal`; `localhost` trong container không trỏ về máy Windows. Compose không tạo hoặc sửa schema SQL Server.

```powershell
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app receipt-worker ngrok redis
docker compose down                                                  
```

API trên máy: `http://localhost:3000/healthz` và `http://localhost:3000/api-docs` (đổi cổng máy bằng `APP_PORT`). URL HTTPS cho frontend xem trong `docker compose logs ngrok` hoặc `http://localhost:4040`. Có thể gọi `/healthz` qua URL HTTPS đó để kiểm tra tunnel. CORS hiện tại của Express được giữ nguyên.

Source được bind mount vào `/app`; API và worker dùng `nodemon --legacy-watch` để theo dõi bằng polling vì `node --watch` không nhận sự kiện thay đổi từ bind mount Windows trong môi trường này. Khi sửa JavaScript, nodemon gửi `SIGTERM` và chờ tiến trình cũ dừng trước khi chạy lại; worker dùng graceful shutdown hiện có. Image chứa dependencies Linux trong volume riêng `/app/node_modules`; không cần build lại sau mỗi lần sửa source. Khi `package.json` hoặc lockfile thay đổi, chạy `docker compose up -d --build --renew-anon-volumes` để cập nhật dependencies trong volume.

Redis chỉ có hostname nội bộ `redis:6379`, không mở cổng ra host. Redis giữ mật khẩu từ `.env` và lưu queue trong volume `redis_data`. Worker vẫn dùng `RECEIPT_SYNC_BATCH_SIZE`, `WORKER_RECEIPT_CONCURRENCY`, `RECEIPT_SWEEP_CRON` và `REDIS_PREFIX` từ `.env` hoặc giá trị mặc định trong source. Chỉ có một service worker; không chạy thêm `npm run worker:receipt` bên ngoài nếu không chủ ý tăng số consumer.

`depends_on` chỉ sắp thứ tự khởi động, không chờ SQL Server/Redis sẵn sàng. Redis client của worker có cơ chế reconnect; nếu worker lỗi lúc khởi động, Docker tự khởi động lại service. API vẫn có thể listen dù DB lỗi, nên hãy xem log `[db]` và `worker_started` trước khi test chức năng.

```powershell
docker compose logs -f app receipt-worker
docker compose down
```

`docker compose down` giữ volume Redis. Chỉ dùng `docker compose down -v` nếu chủ ý xóa toàn bộ queue/job đã lưu.
