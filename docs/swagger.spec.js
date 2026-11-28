/**
 * DINH NGHIA SWAGGER (OpenAPI 3.0) cho /api/warehouse/*.
 * Mount tai /api-docs (swagger-ui-express) de team test API truc tiep.
 * Khop contract shared/api.interface.ts — day la quy trinh bat buoc cua team.
 *
 * AUTH THUC (2026-10-20): moi endpoint can header x-auth-token (nhan tu
 * POST /auth/login) tru login. Nhom Accounts (tru change-password) + reset
 * chi MANAGER. actorId trong body DA BO — server lay danh tinh tu token.
 * Token la JWT (HS256, thu vien jsonwebtoken) han 1 NAM (365d) — FE luu
 * vao localStorage va gan header x-auth-token. Logout = revoked token.
 */

'use strict';

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'not_found' },
        message: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  },
};

const OK_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean', example: true } },
};

const ACCOUNT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'EMP001' },
    name: { type: 'string', example: 'Nguyễn Văn An' },
    employeeCode: { type: 'string', example: 'EMP001' },
    email: { type: 'string', example: 'an.nguyen@germton.com' },
    role: { type: 'string', enum: ['KEEPER', 'MANAGER', 'IT'] },
    locked: { type: 'boolean' },
  },
};

const SLOT_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', example: 'GIF3-A1-01-01' },
    warehouse: { type: 'string', example: 'GIF3' },
    row: { type: 'string', example: 'A1' },
    floor: { type: 'string', example: '01' },
    position: { type: 'string', example: '01' },
    keeperId: { type: 'string', nullable: true },
    locked: { type: 'boolean' },
    full: { type: 'boolean' },
    active: { type: 'boolean' },
  },
};

const IQC_HISTORY_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['PASS', 'FAIL_PENDING', 'EXEMPT', 'FAIL_ACCEPT', 'FAIL_RETURN', 'RETURN'] },
      time: { type: 'string', format: 'date-time' },
    },
  },
};

const LOT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'L1' },
    poNumber: { type: 'string', example: 'PO-25001' },
    poLine: { type: 'string', example: '10', description: 'pur_order2.id dùng làm poId khi gán kệ.' },
    itemCode: { type: 'string', example: 'ITEM-SPCC' },
    material: { type: 'string', example: 'Thép tấm SPCC' },
    lotCode: {
      type: 'string',
      example: 'LOT-25001',
      description:
        'null / rong = chua match pur_notice2 (PO_ASSIGNED); co sau khi match notice (lot_no = sheet_lot)',
    },
    supplier: { type: 'string' },
    qty: { type: 'number' },
    unit: { type: 'string', example: 'KG' },
    receivedAt: { type: 'string', format: 'date-time' },
    shelfCode: { type: 'string', nullable: true },
    assignedBy: { type: 'string', nullable: true },
    assignedAt: { type: 'string', format: 'date-time', nullable: true },
    status: {
      type: 'string',
      enum: ['PO_RECEIVED', 'WAITING_IQC', 'WAITING_STOCK', 'IN_STOCK', 'RETURNED'],
    },
    iqcDecision: {
      type: 'string',
      nullable: true,
      enum: ['PASS', 'FAIL_PENDING', 'EXEMPT', 'FAIL_ACCEPT', 'FAIL_RETURN', 'RETURN', null],
    },
    hasWarning: { type: 'boolean', nullable: true },
    qtyInStock: { type: 'number', nullable: true },
    remainingStockQty: { type: 'number', description: 'Current shelf stock after confirmed picks' },
    reservedStockQty: { type: 'number', description: 'Stock reserved by unconfirmed outbound picks' },
    qtyReturn: { type: 'number', nullable: true },
    iqcUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
    statusRecordedAt: { type: 'string', format: 'date-time', nullable: true },
    waitingStockSince: { type: 'string', format: 'date-time', nullable: true },
    iqcHistory: IQC_HISTORY_SCHEMA,
    source: { type: 'string', example: 'mock' },
  },
};

const PO_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      example: '18',
      description: 'ID hiển thị của dòng PO hoặc dòng tạm nhập.',
    },
    poNumber: { type: 'string', example: 'PO-25011' },
    poLine: { type: 'string', example: '10' },
    itemCode: { type: 'string' },
    material: { type: 'string' },
    supplier: { type: 'string' },
    qty: { type: 'number' },
    unit: { type: 'string' },
    unitPrice: { type: 'number' },
    confirmed: { type: 'boolean', nullable: true },
    eta: { type: 'string', format: 'date-time' },
    arrived: { type: 'boolean' },
    grnRef: { type: 'string', nullable: true },
    lotNo: { type: 'string', nullable: true },
    assignedQty: {
      type: 'number',
      nullable: true,
      description:
        'Tổng số lượng đã phân bổ theo dòng PO.',
    },
    close_sw: { type: 'string', nullable: true },
    rem: { type: 'string', nullable: true },
    sheet_no: { type: 'string', nullable: true },
    adj_result: { type: 'string', nullable: true },
    po_no: { type: 'string', nullable: true },
    mat_no: { type: 'string', nullable: true },
    mat_name: { type: 'string', nullable: true },
    mat_type: { type: 'string', nullable: true },
    mat_type_desc: { type: 'string', nullable: true },
    sheetQty: { type: 'number', nullable: true },
    po_qty: { type: 'number', nullable: true },
    temp_rcv_qty: { type: 'number', nullable: true },
    temp_foc_qty: { type: 'number', nullable: true },
    fail_qty: { type: 'number', nullable: true },
    fail_foc_qty: { type: 'number', nullable: true },
    total_fail_qty: { type: 'number', nullable: true },
    r_fail_qty: { type: 'number', nullable: true },
    r_fail_foc_qty: { type: 'number', nullable: true },
    r_total_fail_qty: { type: 'number', nullable: true },
    po_id: { type: 'integer', nullable: true },
    gap_pmc_day: { type: 'integer', nullable: true },
    late_date: { type: 'integer', nullable: true },
    po_date: { type: 'string', format: 'date-time', nullable: true },
    pmc_date: { type: 'string', format: 'date-time', nullable: true },
    temp_rcv_date: { type: 'string', format: 'date-time', nullable: true },
    su_reply_date: { type: 'string', format: 'date-time', nullable: true },
    status_po: {
      type: 'string',
      enum: ['IN_STOCK', 'SEND_STOCK', 'WAITING_STOCK', 'WAITING_IQC', 'OVERDUE', 'DUE_SOON', 'DUE_TODAY', 'NOT_YET_DUE'],
    },
    source: { type: 'string', example: 'mock' },
  },
};

const ACTIVITY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    time: { type: 'string', format: 'date-time' },
    userId: { type: 'string' },
    actionKey: { type: 'string', example: 'actAssign' },
    poNumber: { type: 'string', nullable: true },
    slotCode: { type: 'string', nullable: true },
    qty: { type: 'number', nullable: true },
    unit: { type: 'string', nullable: true },
    detail: {
      type: 'string', nullable: true,
      description: 'Log mới chứa mô tả SQL và thông tin đối chiếu dạng văn bản. FE hiển thị như text; log lịch sử có thể là JSON hoặc văn bản cũ. Giá trị mật khẩu được che.',
    },
  },
};

/** POST /auth/login — response { token, account }. */
const LOGIN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    token: {
      type: 'string',
      description: 'JWT (HS256, han 365 ngay) — FE luu vao localStorage, gan vao header x-auth-token cho moi request sau',
    },
    account: { $ref: '#/components/schemas/Account' },
  },
};

/** GET /auth/me — response { account }. */
const ME_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { account: { $ref: '#/components/schemas/Account' } },
};

/** GET /pos — response phan trang PO mo + bucket counts. */
// Query phan trang dung chung cho GET /accounts, /slots, /lots.
// Khong truyen -> mang full (backward compat); truen bat ky -> IPaged.
const PAGE_PARAMS = [
  {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', default: 1, minimum: 1 },
  },
  {
    name: 'pageSize',
    in: 'query',
    schema: { type: 'integer', default: 100, minimum: 1, maximum: 200 },
  },
];

// Response khi truyen page/pageSize: { items, total, page, pageSize }.
const PAGED_SCHEMA = (itemRef) => ({
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: itemRef } },
    total: { type: 'integer', example: 42 },
    page: { type: 'integer', example: 1 },
    pageSize: { type: 'integer', example: 100 },
  },
});

const PO_LINE_PAGE_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: '#/components/schemas/Po' } },
    total: { type: 'integer', example: 42 },
    page: { type: 'integer', example: 1 },
    pageSize: { type: 'integer', example: 15 },
    poTotal: { type: 'integer', description: 'Số mã PO duy nhất theo bộ lọc hiện tại, không phân trang.' },
    bucketCounts: {
      type: 'object',
      description:
        'Số mã PO duy nhất theo nhóm ngày dự kiến. Chỉ trả khi counts khác 0.',
      properties: {
        overdue: { type: 'integer', description: 'PO quá dự kiến, đếm một lần trên cả ba nhóm.' },
        od1: { type: 'integer' },
        od2: { type: 'integer' },
        od3p: { type: 'integer' },
        next3: { type: 'integer' },
        next7: { type: 'integer' },
      },
    },
  },
};

/** GET /slots?keyword= — response danh sach ma ke. */
const SLOT_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    codes: {
      type: 'array',
      items: { type: 'string' },
      example: ['GIF3-A1-01-01', 'GIF3-A1-02-03'],
    },
  },
};

/** GET /activity — response phan trang nhat ky. */
const ACTIVITY_PAGE_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: '#/components/schemas/Activity' } },
    total: { type: 'integer', example: 120 },
    page: { type: 'integer', example: 1 },
    pageSize: { type: 'integer', example: 20 },
  },
};

/** IMaterialItem — dong GET /materials (goods + assignment active). */
const MATERIAL_SCHEMA = {
  type: 'object',
  properties: {
    goodsNo: { type: 'string', example: 'ITEM-SPCC' },
    goodsName: { type: 'string', example: 'Thép tấm SPCC' },
    keeperEmpNo: { type: 'string', nullable: true, example: 'TEST-KPR' },
    keeperName: { type: 'string', nullable: true, example: 'Thủ kho Test' },
    assignedAt: { type: 'string', format: 'date-time', nullable: true },
    isAssigned: { type: 'boolean' },
  },
};

/** IMaterialHistoryEntry — dong lich su phan cong. */
const MATERIAL_HISTORY_SCHEMA = {
  type: 'object',
  properties: {
    keeperEmpNo: { type: 'string', example: 'EMP001' },
    keeperName: { type: 'string', nullable: true, example: 'Nguyễn Văn An' },
    assignedByEmpNo: { type: 'string', example: 'TEST-MGR' },
    assignedByName: { type: 'string', nullable: true, example: 'Chủ quản Test' },
    assignedAt: { type: 'string', format: 'date-time' },
    endedAt: { type: 'string', format: 'date-time', nullable: true },
    note: { type: 'string', nullable: true },
  },
};

/** GET /materials — response phan trang (luon tra IPaged). */
const MATERIAL_PAGE_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: '#/components/schemas/Material' } },
    total: { type: 'integer', example: 12 },
    page: { type: 'integer', example: 1 },
    pageSize: { type: 'integer', example: 10 },
  },
};

const BOOTSTRAP_SCHEMA = {
  type: 'object',
  properties: {
    accounts: { type: 'array', items: { $ref: '#/components/schemas/Account' } },
    slots: { type: 'array', items: { $ref: '#/components/schemas/Slot' } },
    lots: { type: 'array', items: { $ref: '#/components/schemas/Lot' } },
    incomingPos: { type: 'array', items: { $ref: '#/components/schemas/Po' } },
    activity: { type: 'array', items: { $ref: '#/components/schemas/Activity' } },
  },
};

// Response loi dung chung cho tat ca endpoint.
const ERROR_RESPONSE = {
  description: 'Business error',
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/Error' } },
  },
};

const JSON_BODY = (schemaRef) => ({
  required: true,
  content: { 'application/json': { schema: { $ref: schemaRef } } },
});

function buildSwaggerSpec() {
  return {
    openapi: '3.0.0',
    info: {
      title: 'Smart Warehouse v3 API',
      version: '1.0.0',
      description:
        'Warehouse receiving & IQC status API (Germton Group). ' +
        'AUTH THUC: moi endpoint can header x-auth-token (token nhan tu ' +
        'POST /api/warehouse/auth/login; TEST-MGR = MANAGER / TEST-KPR = ' +
        'KEEPER, mat khau 123456). Nhom Accounts (tru change-password) + ' +
        'reset chi MANAGER. Truong actorId trong body DA BO. ' +
        'Loi business tra ve { error: { code, message, timestamp } }.',
    },
    servers: [{ url: '/', description: 'Current server' }],
    // Bao mat toan cuc: moi endpoint ke ca dau requireAuth; login ghi
    // de security: [] (public).
    security: [{ AuthToken: [] }],
    tags: [
      { name: 'Auth', description: 'Dang nhap / dang xuat / thong tin phien (token x-auth-token)' },
      { name: 'Bootstrap', description: 'Lay du lieu / reset demo' },
      { name: 'Pos', description: 'Tim kiem PO mo (phan trang + bucket ETA)' },
      { name: 'Lots', description: 'Lo hang: gan ke, IQC, chuyen ke' },
      { name: 'Slots', description: 'Ke hang' },
      { name: 'Accounts', description: 'Tai khoan — chi MANAGER (tru change-password: tu doi mat khau)' },
      { name: 'Activity', description: 'Nhat ky hoat dong' },
      { name: 'Materials', description: 'Phân công thủ kho NPL — chỉ MANAGER' },
      {
        name: 'Reconcile',
        description:
          'Cảnh báo reconcile (EXCESS/SHORTAGE/AMBIGUOUS/T8_CHANGED) — ' +
          'issue OPEN kèm context số lượng + candidates structured',
      },
    ],
    paths: {
      '/api/warehouse/it/workers': {
        get: {
          tags: ['IT'],
          summary: 'Tín hiệu worker và thống kê job (IT)',
          responses: { 200: { description: 'Trạng thái Redis và từng queue' }, 403: ERROR_RESPONSE },
        },
      },
      '/api/warehouse/it/audit': {
        get: {
          tags: ['IT'],
          summary: 'Nhật ký tạo tài khoản và đặt lại mật khẩu (IT)',
          parameters: [
            { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1 } },
            { in: 'query', name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 200 } },
            { in: 'query', name: 'keyword', schema: { type: 'string', maxLength: 90 } },
          ],
          responses: { 200: { description: 'Nhật ký phân trang' }, 403: ERROR_RESPONSE },
        },
      },
      '/api/warehouse/push-devices/config': {
        get: {
          summary: 'Lấy khóa công khai VAPID cho thiết bị',
          responses: {
            200: { description: 'vapidPublicKey' },
            403: ERROR_RESPONSE,
            503: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/push-devices': {
        post: {
          summary: 'Đăng ký Web Push cho tài khoản đã xác thực',
          responses: { 200: { description: 'Đã đăng ký' }, 400: ERROR_RESPONSE, 403: ERROR_RESPONSE },
        },
        delete: {
          summary: 'Hủy Web Push theo endpoint của tài khoản đã xác thực',
          responses: { 200: { description: 'Đã hủy đăng ký' }, 400: ERROR_RESPONSE, 403: ERROR_RESPONSE },
        },
      },
      '/api/warehouse/outbound-notifications/revision': {
        get: {
          summary: 'Phiên bản dữ liệu thông báo xuất kho',
          responses: {
            200: {
              description: 'Tín hiệu cập nhật. Khi Redis không đọc được, available là false.',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  available: { type: 'boolean' },
                  revision: { type: 'string', nullable: true },
                },
              } } },
            },
          },
        },
      },
      '/api/warehouse/outbound-notifications': {
        get: {
          summary: 'Thông báo xuất kho theo phân công NPL hoặc kệ',
          responses: { 200: { description: 'Chủ quản thấy mọi dòng đang xử lý. Thủ kho thấy dòng có NPL được phân công hoặc kệ do mình quản lý. Mỗi dòng và lượt lấy có canConfirm. requestedQty và unit giữ lượng và đơn vị xuất T8. stockRequestedQty và stockUnit là lượng đã quy đổi sang tồn kho bằng pur_unit_rate, làm tròn 3 chữ số thập phân khi khác đơn vị. picks[].plannedQty, pickedQty, availableQty dùng picks[].unit (đơn vị tồn kho). shortageQty dùng đơn vị xuất.' } },
        },
      },
      '/api/warehouse/outbound-notifications/{id}/confirm': {
        post: {
          summary: 'Xác nhận lấy đúng lượng đã đề xuất trên các kệ được phân quyền',
          parameters: [{
            in: 'path', name: 'id', required: true, schema: { type: 'integer' },
            description: 'ID dòng chi tiết scm_out2',
          }],
          responses: {
            200: { description: 'Trạng thái dòng xuất sau khi ghi xác nhận' },
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
            409: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Dang nhap bang ma nhan su + mat khau (public)',
          description:
            'Kiem tra emp_no + password tren whs_user_role. Sai thong tin, ' +
            'active = 0 hoac locked = 1 -> 401 invalid_credentials. ' +
            'Dung -> { token, account } — account dung shape GET /accounts item.',
          security: [],
          requestBody: JSON_BODY('#/components/schemas/LoginDto'),
          responses: {
            200: {
              description: 'Token phien + thong tin tai khoan',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LoginResponse' },
                },
              },
            },
            401: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/auth/logout': {
        post: {
          tags: ['Auth'],
          summary: 'Dang xuat — revoked JWT cho den khi het han',
          responses: {
            200: {
              description: 'Thanh cong',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Ok' } },
              },
            },
            401: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/auth/me': {
        get: {
          tags: ['Auth'],
          summary: 'Thong tin tai khoan dang dang nhap',
          responses: {
            200: {
              description: '{ account } — refetch moi nhat theo token',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MeResponse' },
                },
              },
            },
            401: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/lots': {
        get: {
          tags: ['Lots'],
          summary: 'Danh sach lo (tach bootstrap, ho tro phan trang)',
          description:
            'Khong truen page/pageSize -> ILotV2[] full (ORDER BY ' +
            'allocated_at DESC, id DESC). Truen -> { items, total, page, pageSize }.',
          parameters: PAGE_PARAMS,
          responses: {
            200: {
              description: 'ILotV2[] hoac IPaged<ILotV2>',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Lot' },
                      },
                      PAGED_SCHEMA('#/components/schemas/Lot'),
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/api/warehouse/reconcile-issues': {
        get: {
          tags: ['Reconcile'],
          summary: 'Danh sách issue OPEN có structured context cho UI',
          description:
            'Trả IReconcileIssueDto[]: mỗi issue_type kèm assignedQty/t8Qty/' +
            'receivedQty/differenceQty, candidates[] (AMBIGUOUS — đủ ' +
            'noticeDetailId/sheetNo/qty/lotNo) và change (T8_CHANGED — ' +
            'PO_LINE_MISSING | NOTICE_MISSING | LOT_CHANGED | LOT_REMOVED). ' +
            'FE không cần parse note. Query `limit` (1-500, mặc định 200).',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
              description: 'Số issue tối đa mỗi lượt',
            },
          ],
          responses: {
            200: {
              description: 'IReconcileIssueDto[]',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
      },
      '/api/warehouse/count/listPos': {
        get: {
          tags: ['Pos'],
          summary: 'Đếm số đơn PO theo trạng thái',
          description:
            'Đếm số mã PO duy nhất trong từng nhóm trạng thái. Một PO có thể nằm trong nhiều nhóm. ' +
            'Ngày dự kiến nằm trong khoảng lớn hơn -30 và nhỏ hơn 30 ngày so với hôm nay.',
          responses: {
            200: {
              description: 'Mảng chứa một bản ghi tổng hợp.',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        IN_STOCK: { type: 'integer', minimum: 0, description: 'Đã nhập kho chính thức' },
                        SEND_STOCK: { type: 'integer', minimum: 0, description: 'Đã gửi yêu cầu nhập kho' },
                        WAITING_STOCK: { type: 'integer', minimum: 0, description: 'Đã kiểm IQC' },
                        WAITING_IQC: { type: 'integer', minimum: 0, description: 'Chờ kiểm IQC' },
                        NOT_ARRIVED: { type: 'integer', minimum: 0, description: 'Hàng chưa về nhà máy' },
                        OVERDUE: { type: 'integer', minimum: 0, description: 'Lô hàng trễ hẹn' },
                        DUE_SOON: { type: 'integer', minimum: 0, description: 'Dự kiến sắp về' },
                        DUE_TODAY: { type: 'integer', minimum: 0, description: 'Dự kiến về hôm nay' },
                        NOT_YET_DUE: { type: 'integer', minimum: 0, description: 'Chưa đến ngày giao' },
                      },
                    },
                  },
                },
              },
            },
            401: { description: 'Phiên đăng nhập không hợp lệ hoặc thiếu token.' },
            429: { description: 'Vượt giới hạn đọc SQL.' },
            503: { description: 'Hàng đợi SQL đang bận.' },
          },
        },
      },
      '/api/warehouse/pos': {
        get: {
          tags: ['Pos'],
          summary: 'Tìm kiếm và phân trang danh sách PO',
          description: 'Danh sách dùng điều kiện cố định của backend. Từ khóa tìm theo tiền tố mã PO, mã NPL, mã lô hoặc theo nội dung tên NPL và nhà cung cấp.',
          parameters: [
            { name: 'keyword', in: 'query', schema: { type: 'string' } },
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1, minimum: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 15, minimum: 5, maximum: 100 } },
            {
              name: 'counts',
              in: 'query',
              schema: { type: 'string', enum: ['0', '1'], default: '1' },
              description: 'Gửi 0 để bỏ thống kê theo ngày dự kiến. Tổng số dòng và số PO vẫn được trả về.',
            },
          ],
          responses: {
            200: {
              description: 'Trang danh sách PO.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PoLinePage' },
                },
              },
            },
            401: { description: 'Thiếu token hoặc phiên đăng nhập không hợp lệ.' },
            429: { description: 'Vượt giới hạn đọc SQL.' },
            503: { description: 'Hàng đợi SQL đang bận.' },
          },
        },
      },
      '/api/warehouse/pos/supllierLate': {
        get: {
          tags: ['Pos'],
          summary: 'Lấy tối đa 10 PO giao trễ và chưa nhận đủ',
          description: 'Gộp theo mã PO và sắp theo số ngày trễ giảm dần. Truy vấn xét các dòng PO kho 101, trong phạm vi ngày dự kiến của báo cáo.',
          responses: {
            200: {
              description: 'Mảng PO giao trễ. Trả mảng rỗng khi không có PO khớp.',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    maxItems: 10,
                    items: {
                      type: 'object',
                      required: ['po_no', 'supplier_name', 'late_days', 'materials'],
                      properties: {
                        po_no: { type: 'string', example: 'POGI261014001' },
                        supplier_name: { type: 'string', nullable: true },
                        late_days: { type: 'integer', minimum: 1, example: 7 },
                        materials: { type: 'string', nullable: true, description: 'Tên vật tư nối bằng dấu · theo thứ tự mã NPL.' },
                      },
                    },
                  },
                },
              },
            },
            401: { description: 'Thiếu token hoặc phiên đăng nhập không hợp lệ.' },
            429: { description: 'Vượt giới hạn đọc SQL.' },
            503: { description: 'Hàng đợi SQL đang bận.' },
          },
        },
      },
      '/api/warehouse/assign': {
        post: {
          tags: ['Lots'],
          summary:
            'THU KHO gan PO len ke — INSERT allocation tu pur_order2 ngay (PO_ASSIGNED / WAITING_IQC), tu dong match pur_notice2 neu co (TEMP_IN)',
          description:
            'KHONG cho pur_notice2: ban ghi whs_slot_allocation duoc INSERT ngay tu PO (po_id = t8_pur_order2.id, goods_no tu PO, lot_no NULL, notice_confirmed = 0, warehouse_status = PO_ASSIGNED, status = WAITING_IQC). ' +
            'Sau INSERT he thong tu match notice theo pur_id = po_id + cung goods_no: match -> notice_detail_id, lot_no = sheet_lot, notice_confirmed = 1, warehouse_status = TEMP_IN (status van WAITING_IQC cho den IQC). ' +
            'Neu ke da co allocation active cung (po_id, slot_code) thi CONG DON allocated_qty (merge), khong insert duplicate.',
          requestBody: JSON_BODY('#/components/schemas/AssignDto'),
          responses: {
            201: {
              description: 'Lot moi vua tao',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Lot' } },
              },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/lots/{id}/iqc': {
        post: {
          tags: ['Lots'],
          summary:
            'T8 SIMULATOR ONLY — nhan ket qua IQC cho lo hang (gia lap T8 day ket qua)',
          description:
            'Trên SQL Server, endpoint trả 403 iqc_manual_disabled. IQC được cập nhật bởi IQC Auto Sync Worker. ' +
            'Neu allocation chua match notice (PO_ASSIGNED): he thong tu tao t8_pur_notice1 + t8_pur_notice2 (T8 simulator) roi confirm allocation (TEMP_IN) truoc khi ap IQC. ' +
            'State machine (SIMULATOR — KHONG phai business production): PASS/EXEMPT -> IN_STOCK + warehouse IN; FAIL_PENDING -> giu WAITING_IQC + has_warning; RETURN -> RETURNED + warehouse RETURN. Production: IQC Auto Sync Worker (adj_result/pro_result) tao WAITING_STOCK / RETURNED / FAIL_ACCEPT / FAIL_RETURN.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Lot ID',
            },
          ],
          requestBody: JSON_BODY('#/components/schemas/IqcDto'),
          responses: {
            201: {
              description: 'Lot sau khi cap nhat trang thai',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Lot' } },
              },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/lots/{id}/move': {
        post: {
          tags: ['Lots'],
          summary: 'Chuyen lo hang sang ke khac (toan bo hoac mot phan)',
          description: 'Chuyển nguyên lô giữ ID và trạng thái. Chuyển một phần tạo lô cùng trạng thái; cần xác định phần hàng nếu lô trộn nhiều phiếu hoặc có cả lượng nhận và trả.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Lot ID',
            },
          ],
          requestBody: JSON_BODY('#/components/schemas/MoveDto'),
          responses: {
            201: {
              description: 'Thanh cong',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
            409: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/lots/{id}/undo': {
        post: {
          tags: ['Lots'],
          summary:
            'HOAN TAC GAN K Y (Undo Assign 2026-11-07): hard-delete ' +
            'allocation, release receipt mapping, resolve OPEN issue, ' +
            'audit UNDO_ASSIGN — mot transaction. Chan undo khi da co IQC/' +
            'ton kho/tra hang/AOD/movement, hoac khi lot_no da co (2026-11-12: ' +
            'cho CHo IQC chua co lot — allocation_has_lot_no).',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Lot ID (PK whs_slot_allocation)',
            },
          ],
          requestBody: JSON_BODY('#/components/schemas/UndoDto'),
          responses: {
            200: {
              description:
                'Thanh cong: { ok, allocationId, state: UNDONE | ' +
                'ALREADY_UNDONE, releasedReceiptCount, releasedQty }',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean', example: true },
                      allocationId: { type: 'string', example: 'al_abc123' },
                      state: {
                        type: 'string',
                        enum: ['UNDONE', 'ALREADY_UNDONE'],
                      },
                      releasedReceiptCount: { type: 'number', example: 1 },
                      releasedQty: { type: 'number', example: 42.2 },
                    },
                  },
                },
              },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
            409: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/slots': {
        get: {
          tags: ['Slots'],
          summary: 'Danh sach ke day du (tach bootstrap, ho tro phan trang)',
          description:
            'IShelfSlot[] — moi ke mot dong, kem thu kho / trang thai. ' +
            '(2026-10-16: endpoint tim ma ke cuoc doi tu /slots sang ' +
            '/slots/search). Khong truen page/pageSize -> mang full; ' +
            'truen -> phan trang SQL (ORDER BY s.code).',
          parameters: PAGE_PARAMS,
          responses: {
            200: {
              description: 'IShelfSlot[] hoac IPaged<IShelfSlot>',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Slot' },
                      },
                      PAGED_SCHEMA('#/components/schemas/Slot'),
                    ],
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Slots'],
          summary: 'MANAGER tao ke moi',
          description: 'Tạo WHS và bas_st_bit cùng transaction. GIF3 ánh xạ kho T8 101, st_bit_no dùng chung mã kệ và st_bit_name cố định Smart-Warehousing. modify_user là ADM nếu mã nhân viên bắt đầu TEST, còn lại dùng mã nhân viên. Kệ T8 có sẵn cùng kho được dùng lại. Mỗi lần ghi bas_st_bit đều ghi sys_oper_log trong cùng transaction với user_no, nội dung SQL chi tiết, GETDATE(), oper_type, smart-warehousing và w_bas_st_bit.',
          requestBody: JSON_BODY('#/components/schemas/CreateSlotDto'),
          responses: {
            201: {
              description: 'Ke moi',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Slot' } },
              },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
            409: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/slots/search': {
        get: {
          tags: ['Slots'],
          summary: 'Tim ma ke theo tu khoa (PO / NPL / vat tu / lo)',
          description:
            'Tra cac ma ke co allocation khop tu khoa: slot_code, lot_no, ' +
            'so don (t8_pur_order1.sheet_no), ma NPL (t8_pur_order2.goods_no), ' +
            'ten hang (t8_bas_goods.goods_name). Tu khoa rong -> mang rong.',
          parameters: [
            {
              name: 'keyword',
              in: 'query',
              schema: { type: 'string' },
              description: 'Tu khoa tim kiem (trim boi server)',
            },
          ],
          responses: {
            200: {
              description: 'Danh sach ma ke (DISTINCT, sap tang dan)',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SlotSearchResponse' },
                },
              },
            },
          },
        },
      },
      '/api/warehouse/slots/assign-keeper': {
        post: {
          tags: ['Slots'],
          summary: 'MANAGER gan / xoa thu kho cho nhieu ke',
          requestBody: JSON_BODY('#/components/schemas/AssignKeeperDto'),
          responses: {
            201: {
              description: 'Thanh cong',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            403: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/slots/{code}': {
        patch: {
          tags: ['Slots'],
          summary: 'Cap nhat trang thai ke (locked / full / active)',
          description:
            'SHELF PERMISSION (Phase 2 2026-10-20, BE enforce): ' +
            'KEEPER chi duoc thao tac ke cua minh HOAC ke chua co chu so huu ' +
            '(keeper_emp_no NULL) — ke cua keeper khac tra ' +
            '403 { error: { code: "no_permission" } }; locked/active chi MANAGER. ' +
            'MANAGER có thể gửi code để đổi mã kệ chưa được sử dụng; đồng bộ WHS và bas_st_bit trong cùng transaction. ' +
            'Code mới phải cùng kho. Kệ có tham chiếu WHS hoặc T8 trả 409 slot_in_use/t8_slot_in_use; mã đích đã tồn tại bị từ chối. ' +
            'Chỉ thao tác đổi mã mới ghi vào T8 và sys_oper_log cùng transaction. Khóa, đầy, hoạt động và phân công thủ kho chỉ cập nhật WHS.',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Ma ke (VD: GIF3-A1-01-01)',
            },
          ],
          requestBody: JSON_BODY('#/components/schemas/UpdateSlotDto'),
          responses: {
            200: {
              description: 'Thanh cong',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
            409: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/accounts': {
        get: {
          tags: ['Accounts'],
          summary: 'Danh sach tai khoan (tach bootstrap, ho tro phan trang)',
          description:
            'Chi DOC — moi user da dang nhap deu goi duoc (2026-10-22; truoc day chi MANAGER). ' +
            'Khong truen page/pageSize -> IAccount[] full (ORDER BY r.emp_no). ' +
            'Truen -> { items, total, page, pageSize }.',
          parameters: PAGE_PARAMS,
          responses: {
            200: {
              description: 'IAccount[] hoac IPaged<IAccount>',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Account' },
                      },
                      PAGED_SCHEMA('#/components/schemas/Account'),
                    ],
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Accounts'],
          summary: 'Chủ quản tạo Thủ kho, IT tạo tài khoản theo vai trò',
          requestBody: JSON_BODY('#/components/schemas/CreateAccountDto'),
          responses: {
            201: {
              description: 'Tai khoan moi (khong tra ve mat khau)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Account' } },
              },
            },
            403: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/accounts/employee-lookup': {
        get: {
          tags: ['Accounts'],
          summary: 'Tra cứu nhân viên theo mã NV (MANAGER hoặc IT)',
          parameters: [{
            in: 'query', name: 'employeeCode', required: true,
            schema: { type: 'string', maxLength: 20 },
          }],
          responses: {
            200: {
              description: 'Họ tên từ T8 và tình trạng tài khoản',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  employeeCode: { type: 'string' },
                  name: { type: 'string' },
                  email: { type: 'string', nullable: true, example: null },
                  accountExists: { type: 'boolean' },
                },
              } } },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/accounts/{id}': {
        patch: {
          tags: ['Accounts'],
          summary: 'MANAGER cap nhat thong tin tai khoan',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: JSON_BODY('#/components/schemas/UpdateAccountDto'),
          responses: {
            200: {
              description: 'Thanh cong',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            403: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/accounts/change-password': {
        post: {
          tags: ['Accounts'],
          summary: 'Nguoi dung tu doi mat khau cua minh',
          requestBody: JSON_BODY('#/components/schemas/ChangePasswordDto'),
          responses: {
            201: {
              description: 'Thanh cong',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            400: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/accounts/{id}/lock': {
        post: {
          tags: ['Accounts'],
          summary: 'MANAGER khoa / mo khoa tai khoan',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: JSON_BODY('#/components/schemas/ActorOnlyDto'),
          responses: {
            201: {
              description: 'Thanh cong',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/accounts/{id}/reset-password': {
        post: {
          tags: ['Accounts'],
          summary: 'MANAGER dat lai mat khau cho nguoi khac',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: JSON_BODY('#/components/schemas/ResetPasswordDto'),
          responses: {
            201: {
              description: 'Thanh cong',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/activity': {
        get: {
          tags: ['Activity'],
          summary: 'Tim kiem + phan trang nhat ky thao tac',
          description:
            'Tu khoa khop case-insensitive tren po_number / user_name / ' +
            'emp_no / slot_code / detail / action_key. ' +
            'Tham so khong hop le tu ve mac dinh: page < 1 -> 1, ' +
            'pageSize kem 5..100 (mac dinh 20).',
          parameters: [
            {
              name: 'keyword',
              in: 'query',
              schema: { type: 'string' },
              description: 'Tu khoa (so don / nguoi dung / ma ke / chi tiet...)',
            },
            {
              name: 'page',
              in: 'query',
              schema: { type: 'integer', default: 1, minimum: 1 },
            },
            {
              name: 'pageSize',
              in: 'query',
              schema: { type: 'integer', default: 20, minimum: 5, maximum: 100 },
            },
          ],
          responses: {
            200: {
              description: 'Danh sach nhat ky phan trang',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ActivityPage' },
                },
              },
            },
          },
        },
      },
      '/api/warehouse/activity/qr-print': {
        post: {
          tags: ['Activity'],
          summary: 'MANAGER ghi nhat ky in QR cho nhieu ke',
          requestBody: JSON_BODY('#/components/schemas/PrintQrDto'),
          responses: {
            201: {
              description: 'Thanh cong',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            403: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/materials': {
        get: {
          tags: ['Materials'],
          summary: 'Danh sách NPL + thủ kho đang phụ trách (chỉ MANAGER)',
          description:
            'Toàn bộ t8_bas_goods LEFT JOIN assignment active ' +
            '(ended_at IS NULL). Search khớp goods_no / goods_name. ' +
            'ORDER BY goods_no; page 1-indexed, pageSize mặc định 10 (tối đa 50).',
          parameters: [
            {
              name: 'search',
              in: 'query',
              schema: { type: 'string' },
              description: 'Từ khóa lọc goods_no / goods_name (chứa, case-insensitive)',
            },
            {
              name: 'page',
              in: 'query',
              schema: { type: 'integer', default: 1, minimum: 1 },
            },
            {
              name: 'pageSize',
              in: 'query',
              schema: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
            },
          ],
          responses: {
            200: {
              description: '{ items, total, page, pageSize } — IMaterialItem[]',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MaterialPage' },
                },
              },
            },
            403: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/materials/assign-keeper': {
        post: {
          tags: ['Materials'],
          summary: 'Gán / đổi thủ kho phụ trách NPL (chỉ MANAGER)',
          description:
            'Validate goodsNo tồn tại t8_bas_goods (400 goods_not_found); ' +
            'keeperEmpNo là KEEPER còn hoạt động (400 invalid_keeper). ' +
            'Trong 1 transaction: đóng dòng active cũ (ended_at) + INSERT ' +
            'dòng mới — mỗi goods luôn chỉ 1 dòng active. Refetch trả ' +
            '{ material } full shape.',
          requestBody: JSON_BODY('#/components/schemas/AssignMaterialKeeperDto'),
          responses: {
            201: {
              description: '{ material } — IMaterialItem sau khi gán',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      material: { $ref: '#/components/schemas/Material' },
                    },
                  },
                },
              },
            },
            400: ERROR_RESPONSE,
            403: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/materials/{goodsNo}/history': {
        get: {
          tags: ['Materials'],
          summary: 'Lịch sử phân công của 1 NPL (chỉ MANAGER)',
          description:
            'ORDER BY assigned_at DESC; dòng active có endedAt = null. ' +
            'goodsNo không tồn tại t8_bas_goods -> 404 goods_not_found.',
          parameters: [
            {
              name: 'goodsNo',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Mã NPL (t8_bas_goods.goods_no)',
            },
          ],
          responses: {
            200: {
              description: '{ items } — IMaterialHistoryEntry[]',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items: {
                        type: 'array',
                        items: {
                          $ref: '#/components/schemas/MaterialHistoryEntry',
                        },
                      },
                    },
                  },
                },
              },
            },
            403: ERROR_RESPONSE,
            404: ERROR_RESPONSE,
          },
        },
      },
      '/api/warehouse/reset': {
        post: {
          tags: ['Bootstrap'],
          summary: 'Reset du lieu ve seed ban dau (demo)',
          requestBody: JSON_BODY('#/components/schemas/ActorOnlyDto'),
          responses: {
            201: {
              description: 'Du lieu sau khi reset (bootstrap)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Bootstrap' } },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        AuthToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-auth-token',
          description: 'JWT (HS256, han 365 ngay) nhan tu POST /api/warehouse/auth/login',
        },
      },
      schemas: {
        Error: ERROR_SCHEMA,
        LoginResponse: LOGIN_RESPONSE_SCHEMA,
        MeResponse: ME_RESPONSE_SCHEMA,
        LoginDto: {
          type: 'object',
          required: ['empNo', 'password'],
          properties: {
            empNo: {
              type: 'string',
              example: 'TEST-MGR',
              description: 'Ma nhan su (whs_user_role.emp_no) — TEST-MGR = MANAGER, TEST-KPR = KEEPER',
            },
            password: { type: 'string', example: '123456' },
          },
        },
        Ok: OK_SCHEMA,
        Account: ACCOUNT_SCHEMA,
        Slot: SLOT_SCHEMA,
        Lot: LOT_SCHEMA,
        Po: PO_SCHEMA,
        Activity: ACTIVITY_SCHEMA,
        Bootstrap: BOOTSTRAP_SCHEMA,
        PoLinePage: PO_LINE_PAGE_SCHEMA,
        SlotSearchResponse: SLOT_SEARCH_SCHEMA,
        ActivityPage: ACTIVITY_PAGE_SCHEMA,
        Material: MATERIAL_SCHEMA,
        MaterialHistoryEntry: MATERIAL_HISTORY_SCHEMA,
        MaterialPage: MATERIAL_PAGE_SCHEMA,
        AssignMaterialKeeperDto: {
          type: 'object',
          required: ['goodsNo', 'keeperEmpNo'],
          properties: {
            goodsNo: {
              type: 'string',
              example: 'ITEM-SPCC',
              description: 'Mã NPL (t8_bas_goods.goods_no) — phải tồn tại',
            },
            keeperEmpNo: {
              type: 'string',
              example: 'TEST-KPR',
              description: 'Mã nhân sự thủ kho (whs_user_role: KEEPER, active, không khóa)',
            },
          },
        },
        // ActorOnlyDto da bo — actorId lay tu token (2026-10-20).
        ActorOnlyDto: { type: 'object', properties: {} },
        AssignDto: {
          type: 'object',
          required: ['poId', 'slotCode', 'qty'],
          properties: {
            poId: {
              type: 'string',
              example: '18',
              description:
                'ID dòng PO t8_pur_order2.id (so). po_id + goods_no lay tu PO, KHONG phai tu notice.',
            },
            slotCode: { type: 'string', example: 'GIF3-A1-02-02' },
            qty: { type: 'number', example: 100 },
            lotCode: {
              type: 'string',
              deprecated: true,
              example: 'LOT-261012',
              description:
                'DEPRECATED (2026-10-29) — backend IGNORE truong nay. Business lot chi den tu pur_notice2.made_lot sau khi Receipt Worker sync; FE legacy van gui thi khong ghi, khong log.',
            },
            note: { type: 'string', description: 'Ghi chu (optional)' },
          },
        },
        IqcDto: {
          type: 'object',
          required: ['decision'],
          description:
            'T8 SIMULATOR ONLY — production (DB_MODE=sqlserver) tra loi 403 iqc_manual_disabled; IQC that den tu T8 qua IQC Auto Sync Worker theo adj_result/pro_result (PASS / EXEMPT / FAIL_ACCEPT / FAIL_RETURN). Enum FAIL_PENDING la simulator-only, khong co trong business production.',
          properties: {
            decision: {
              type: 'string',
              enum: ['PASS', 'FAIL_PENDING', 'EXEMPT', 'RETURN'],
              description: 'SIMULATOR enum — khong ap dung cho production T8.',
            },
          },
        },
        MoveDto: {
          type: 'object',
          required: ['targetSlotCode', 'qty'],
          properties: {
            targetSlotCode: { type: 'string', example: 'GIF3-A1-02-02' },
            qty: { type: 'number', example: 50 },
          },
        },
        UndoDto: {
          type: 'object',
          required: ['reason'],
          description:
            'HOAN TAC GAN K Y (2026-11-07) — reason bat buoc, toi da 200 ky tu',
          properties: {
            reason: {
              type: 'string',
              example: 'Gan nham k y, can gan lai',
              maxLength: 200,
            },
          },
        },
        CreateSlotDto: {
          type: 'object',
          required: ['warehouse', 'row', 'floor', 'position'],
          properties: {
            warehouse: { type: 'string', example: 'GIF3' },
            row: { type: 'string', example: 'A1' },
            floor: { type: 'string', example: '02' },
            position: { type: 'string', example: '03' },
          },
        },
        AssignKeeperDto: {
          type: 'object',
          required: ['codes'],
          properties: {
            codes: {
              type: 'array',
              items: { type: 'string' },
              example: ['GIF3-A1-01-01', 'GIF3-A1-01-02'],
            },
            keeperId: {
              type: 'string',
              nullable: true,
              example: 'k2',
              description: 'Bo trong / null = xoa thu kho khoi ke',
            },
          },
        },
        UpdateSlotDto: {
          type: 'object',
          properties: {
            code: {
              type: 'string', maxLength: 20, example: 'GIF3-A1-01-07',
              description: 'MANAGER đổi mã kệ chưa có dữ liệu tham chiếu; phải cùng kho, định dạng kho-dãy-tầng-vị trí.',
            },
            locked: { type: 'boolean', description: 'Khoa ke (chi ke trong)' },
            full: { type: 'boolean', description: 'Danh dau ke day' },
            active: { type: 'boolean', description: 'Vo hieu hoa / kich hoat ke' },
          },
        },
        CreateAccountDto: {
          type: 'object',
          required: ['employeeCode'],
          properties: {
            employeeCode: { type: 'string', minLength: 1, maxLength: 20, example: 'TK003' },
            role: { type: 'string', enum: ['KEEPER', 'MANAGER', 'IT'], description: 'Bắt buộc với IT' },
            password: { type: 'string', format: 'password', minLength: 6, maxLength: 60, writeOnly: true,
              description: 'Mật khẩu ban đầu bắt buộc với IT' },
          },
        },
        UpdateAccountDto: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            employeeCode: { type: 'string' },
            email: { type: 'string' },
          },
        },
        ChangePasswordDto: {
          type: 'object',
          required: ['newPassword', 'confirm'],
          properties: {
            newPassword: { type: 'string', minLength: 6 },
            confirm: { type: 'string' },
          },
        },
        ResetPasswordDto: {
          type: 'object',
          required: ['newPassword'],
          properties: {
            newPassword: { type: 'string', minLength: 6 },
          },
        },
        PrintQrDto: {
          type: 'object',
          required: ['codes'],
          properties: {
            codes: {
              type: 'array',
              items: { type: 'string' },
              example: ['GIF3-A1-01-01'],
            },
          },
        },
      },
    },
  };
}

module.exports = { buildSwaggerSpec };
