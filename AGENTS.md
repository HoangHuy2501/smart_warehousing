# Quy ước kiến trúc Node.js Express cho AI Agent

Tài liệu này là quy tắc làm việc cho AI (Codex, Cursor, Copilot và các coding agent khác) khi đọc, viết hoặc sửa source code trong repository này. Đọc file này trước khi thay đổi code. Nếu kiến trúc hiện có khác tài liệu, hãy kiểm tra code thực tế và hỏi trước khi thực hiện refactor lớn.

## Mục tiêu

- Tuân thủ kiến trúc phân tầng hiện tại; ưu tiên thay đổi nhỏ và tương thích ngược.
- Giữ controller mỏng, service chứa nghiệp vụ, repository xử lý dữ liệu.
- Tái sử dụng code hiện có trước khi thêm module mới.
- Không tự ý đổi tên/move folder, thay đổi database schema, API contract hay cơ chế xác thực.

## Cấu trúc thư mục

```text
project/
├── public/                # Ảnh và static assets công khai
├── src/
│   ├── config/            # DB, Redis, Axios, Swagger, third-party clients
│   ├── controller/        # HTTP request/response handlers
│   ├── middleware/        # Authentication, authorization, validation, errors
│   ├── repository/        # Database queries và data access
│   ├── routes/            # HTTP method, path, middleware, controller binding
│   ├── services/          # Business logic và phối hợp repository/API
│   ├── util/              # Helpers dùng chung, độc lập nghiệp vụ
│   ├── worker/            # Cron jobs, background jobs, queue consumers
│   ├── app.js             # Cấu hình Express application
│   └── server.js          # Bootstrap và app.listen
├── .env.example           # Tên biến cấu hình, không chứa secrets
└── package.json
```

Đây là cấu trúc định hướng. Dự án có thể đang dùng `routes` (số nhiều), `controller` (số ít), hoặc tên khác. **Giữ đúng tên thư mục đang tồn tại**, không tạo folder đồng nghĩa nếu không cần thiết.

## Trách nhiệm từng tầng

| Vị trí | Được làm | Không được làm |
| --- | --- | --- |
| `public/` | Lưu hình ảnh, favicon và file tĩnh được phép truy cập công khai | Lưu secrets hoặc file người dùng cần bảo vệ |
| `config/` | Khởi tạo connection pool DB, Redis, Axios instances, Swagger và cấu hình tích hợp | Xử lý nghiệp vụ của một endpoint |
| `controller/` | Nhận `req`, đọc `params/query/body`, gọi service, trả `res`, chuyển lỗi đến error handler | Viết SQL, thao tác ORM trực tiếp hoặc xử lý nghiệp vụ phức tạp |
| `middleware/` | Kiểm tra token, authentication, authorization, validation, rate-limit, CORS, error handling | Chứa nghiệp vụ chính hoặc truy vấn không cần thiết |
| `repository/` | Truy vấn, thêm, sửa, xóa dữ liệu qua SQL/ORM/data source | Truy cập `req/res`, trả HTTP status hoặc quyết định nghiệp vụ |
| `services/` | Xử lý business rules, transaction orchestration, phối hợp repositories và API bên thứ ba | Gắn chặt với Express `req/res` hoặc tự `listen` |
| `util/` | `formatDate`, `retry`, `slugify`, parse/transform dùng chung | Chứa quy tắc nghiệp vụ riêng của một tính năng |
| `worker/` | Chạy cron, background tasks, queue consumer, sync dữ liệu định kỳ | Dùng như nơi cấu hình CORS hoặc route HTTP |
| `routes/` | Khai báo method/path và ghép middleware/controller | Viết nghiệp vụ, SQL hoặc gọi database trực tiếp |
| `app.js` | Tạo Express app, gắn middleware, static assets, routes và error handler; export app | Gọi `listen()` nếu đã có `server.js` |
| `server.js` | Nạp env, khởi tạo phụ thuộc cần thiết, chạy server, graceful shutdown | Chứa nghiệp vụ hoặc định nghĩa routes hàng loạt |

Authentication (xác thực) trả lời “người dùng là ai”; authorization (phân quyền) trả lời “người dùng được làm gì”. CORS là middleware, không phải cron/job.

## Luồng xử lý chuẩn

```text
HTTP Client
  -> routes
  -> middleware (auth / permission / validate)
  -> controller
  -> services
  -> repository -> database
  -> services
  -> controller -> HTTP response
```

- `services` có thể gọi HTTP client từ `config/` để tích hợp API bên thứ ba.
- `worker` gọi service trực tiếp, không mô phỏng request HTTP nội bộ trừ khi có lý do cụ thể.
- Với CRUD đơn giản, vẫn giữ phân tầng đang áp dụng trong codebase; không tạo abstraction mới nếu không mang lại giá trị.

## Quy trình AI phải làm khi thêm API hoặc tính năng

1. Đọc route, controller, service, repository, middleware liên quan và quy ước đặt tên đã có.
2. Xác định API contract: URL, method, request, response, status code và quyền truy cập.
3. Khai báo hoặc sửa route trong `routes/`; nối middleware phù hợp.
4. Xác thực/validate input trước khi vào logic nghiệp vụ.
5. Controller chỉ chuyển input phù hợp vào service và tạo HTTP response.
6. Service kiểm tra quy tắc nghiệp vụ và gọi repository/third-party client khi cần.
7. Repository xử lý truy vấn an toàn, dùng parameterized query/ORM, không nối chuỗi SQL từ input người dùng.
8. Dùng error handler chung; không để lộ stack trace, credentials hoặc lỗi SQL nhạy cảm ra client.
9. Thêm/chỉnh test tương ứng; chạy test/lint hiện có nếu môi trường cho phép.
10. Báo cáo file đã thay đổi, cách kiểm tra và các điểm chưa xác minh.

## Quy tắc thiết kế và an toàn

- Dùng async/await và cơ chế chuyển lỗi tương thích với phiên bản Express hiện tại.
- Đặt tên rõ nghĩa: `user.routes.js`, `user.controller.js`, `user.service.js`, `user.repository.js` nếu dự án đang theo convention này.
- Không sao chép logic nghiệp vụ vào controller, router hoặc worker.
- Không commit `.env`, token, password, API key hoặc connection string chứa mật khẩu.
- Không thêm package hoặc thay database driver chỉ vì tiện; kiểm tra dependencies trước.
- Tôn trọng transaction boundary khi một nghiệp vụ cập nhật nhiều bảng.
- Chỉ dùng `public/` cho nội dung thực sự public. File upload riêng tư cần storage và kiểm soát truy cập phù hợp.
- Không chạy migration hoặc tác vụ xóa/sửa dữ liệu hàng loạt khi chưa được yêu cầu rõ ràng.
- Không tự thay đổi response schema của endpoint đang được client sử dụng.

## Cách quyết định code đặt ở đâu

- Có `req`, `res`, `next`? → `controller/` hoặc `middleware/`.
- Có URL và HTTP method? → `routes/`.
- Có query SQL/ORM? → `repository/`.
- Có quy tắc nghiệp vụ? → `services/`.
- Có cấu hình kết nối? → `config/`.
- Có helper tổng quát và tái sử dụng? → `util/`.
- Có cron hoặc queue consumer? → `worker/`.
- Có thiết lập `express()` và `app.use()`? → `app.js`.
- Có `app.listen()`? → `server.js`.

## Khi yêu cầu chưa rõ

Hỏi người dùng khi phải quyết định giữa các phương án làm thay đổi API contract, database schema, quyền truy cập, job schedule hoặc cấu trúc dự án ở quy mô lớn. Với thay đổi nhỏ và rõ ràng, thực hiện theo pattern đang có rồi giải thích ngắn gọn.
