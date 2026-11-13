'use strict';

const db = require('../../config/db');
const { getMemoryRepository } = require('../memory.repository');

/**
 * Repository reset — ResetModel (class singleton, module.exports = new).
 *
 * Vai trò trong kiến trúc: tầng truy cập DB cho thao tác reset toàn bộ dữ
 * liệu whs_* về seed — KHÔNG có SQL riêng (điều phối các repository khác
 * chạy trên cùng 1 transaction). DB_MODE=memory thì module.exports swap
 * sang chính memory repository (xem cuối file).
 *
 * Reset toàn bộ dữ liệu whs_* về seed — chạy trong 1 transaction:
 * xóa theo thứ tự con -> cha (FK: movement -> allocation -> slots;
 * receipt -> allocation), chèn lại theo thứ tự cha -> con. TẮT GHI
 * t8_* (2026-10-16): reset chỉ dùng cho các bảng whs_* — KHÔNG xóa dữ
 * liệu t8_* trên DB thật nữa (các lệnh tương ứng được comment lại bên
 * dưới để dễ mở lại khi được phép).
 *
 * Các method repository nhận tham số `query` tùy chọn (mặc định db.query):
 * reset truyền txQuery của withTransaction vào để mọi lệnh (kể cả
 * refetch trong insertRaw/insertAllocation) chạy trong cùng 1
 * transaction trên cùng 1 connection. Endpoint reset hiện ĐANG TẮT
 * (service trả reset_disabled).
 */
class ResetModel {
  /**
   * Reset toàn bộ dữ liệu whs_* về seed trong 1 transaction (xóa
   * con -> cha, chèn lại cha -> con; lazy require tránh vòng tải
   * module khi ở chế độ memory).
   * @param {{ userRoles: Record<string, unknown>[],
   *   slots: Record<string, unknown>[],
   *   allocations: Record<string, unknown>[],
   *   receipts: Record<string, unknown>[],
   *   activity: Record<string, unknown>[] }} seed dữ liệu seed whs_*
   * @returns {Promise<void>}
   */
  async resetAll(seed) {
    await db.withTransaction(async (txQuery) => {
      // Lazy require để tránh vòng tải module khi ở chế độ memory
      // (memory.repository không có các SQL model này).
      const AccountsRepository = require('./account.repository');
      const SlotsRepository = require('./slot.repository');
      const LotsRepository = require('./lot.repository');
      const ActivityRepository = require('./activity.repository');
      const ReceiptsRepository = require('./receipt.repository');

      // Xóa (con -> cha) — receipt trước allocation (FK receipt -> allocation),
      // movement trước slots (FK movement -> slots/allocation)
      await SlotsRepository.deleteAllMovements(txQuery);
      await ActivityRepository.deleteAll(txQuery);
      await ReceiptsRepository.deleteAll(txQuery);
      await LotsRepository.deleteAll(txQuery);
      await SlotsRepository.deleteAll(txQuery);
      await AccountsRepository.deleteAll(txQuery);
      // TẮT GHI t8_* (2026-10-16, yêu cầu user): reset chỉ dùng cho
      // các bảng whs_* — KHÔNG xóa dữ liệu t8_* trên DB thật nữa.
      // (Khối lệnh xóa t8 bên dưới giữ nguyên dạng comment cho dễ mở lại.)
      // await T8Repository.deleteAllIn2(txQuery);
      // await T8Repository.deleteAllIn1(txQuery);
      // await T8Repository.deleteAllNotice2(txQuery);
      // await T8Repository.deleteAllNotice1(txQuery);
      // await T8Repository.deleteAllOrder2(txQuery);
      // await T8Repository.deleteAllOrder1(txQuery);
      // await T8Repository.deleteAllGoods(txQuery);
      // await T8Repository.deleteAllEmps(txQuery);
      // Chèn lại (cha -> con) — chỉ whs_*; t8_* đã tắt (2026-10-16).
      // (Khối chèn t8 bên dưới giữ nguyên dạng comment cho dễ mở lại.)
      // for (const emp of seed.emps) await T8Repository.insertEmp(emp, txQuery);
      // for (const goods of seed.goods) await T8Repository.insertGoods(goods, txQuery);
      // for (const order1 of seed.order1) await T8Repository.insertOrder1(order1, txQuery);
      // for (const order2 of seed.order2) await T8Repository.insertOrder2(order2, txQuery);
      // for (const notice1 of seed.notice1) await T8Repository.insertNotice1(notice1, txQuery);
      // for (const notice2 of seed.notice2) await T8Repository.insertNotice2(notice2, txQuery);
      // for (const in1 of seed.in1) await T8Repository.insertIn1(in1, txQuery);
      // for (const in2 of seed.in2) await T8Repository.insertIn2(in2, txQuery);
      // Chen lai (cha -> con) — chi whs_*; t8_* da tat (2026-10-16).
      for (const role of seed.userRoles) {
        await AccountsRepository.insertRaw(role, txQuery);
      }
      for (const slot of seed.slots) {
        await SlotsRepository.insertRaw(slot, txQuery);
      }
      for (const alloc of seed.allocations) {
        await LotsRepository.insertAllocation(alloc, txQuery);
      }
      // Receipt (allocation x notice) — chèn sau allocation vì FK
      // allocation_id; idempotent nhờ UQ (allocation_id, notice_detail_id).
      for (const rc of seed.receipts) {
        await ReceiptsRepository.insertReceipt(rc, txQuery);
      }
      for (const act of seed.activity) {
        await ActivityRepository.insertRaw(act, txQuery);
      }
    });
  }
}

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository();
} else {
  module.exports = new ResetModel();
  module.exports.ResetModel = ResetModel;
}
