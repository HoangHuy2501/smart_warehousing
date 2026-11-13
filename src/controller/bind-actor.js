/**
 * Helper dung chung cho cac controller domain: bindActor.
 *
 * Chống spoofing actorId — danh tính lấy từ req.actor (gán bởi requireAuth
 * từ JWT), KHÔNG tin actorId client gửi, override trước khi gọi service.
 */

'use strict';

/**
 * Ghi đè req.body.actorId bằng danh tính đã xác thực từ JWT (req.actor.id).
 * Bắt buộc gọi trước khi truyền req.body xuống service đối với các
 * write endpoint.
 *
 * @param {import('express').Request} req - Request có req.actor do
 *   middleware requireAuth gán.
 * @returns {void}
 */
function bindActor(req) {
  req.body.actorId = req.actor.id;
}

module.exports = { bindActor };
