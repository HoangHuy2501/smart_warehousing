/**
 * Khai bao route warehouse — giong het contract FE dang goi (/api/warehouse/*).
 * Thu tu: route tinh truoc, route dong (:id / :code) sau.
 *
 * AUTH THUC (2026-10-20): moi endpoint deu can header x-auth-token
 * (requireAuth) tru POST /auth/login. Nhom accounts + reset chi MANAGER
 * (requireManager). actorId trong body khong con duoc tin nua — controller
 * override bang req.actor.id.
 */

'use strict';

const express = require('express');
const controller = require('../controller/warehouse.controller');
const { requireBodyFields } = require('../middleware/validate.middleware');
const { requireAuth, requireManager } = require('../middleware/auth.middleware');
const { asyncHandler } = require('../util/async-handler');

const router = express.Router();

// ---- AUTH (public login; logout / me can token) ----

router.post(
  '/auth/login',
  requireBodyFields(['empNo', 'password']),
  asyncHandler(controller.login)
);

router.post('/auth/logout', requireAuth, asyncHandler(controller.logout));

router.get('/auth/me', requireAuth, asyncHandler(controller.me));

// ---- GET THEO DOMAIN (tach bootstrap — du lieu lon, FE tai moi domain rieng) ----

router.get('/', requireAuth, asyncHandler(controller.bootstrap));

router.get('/accounts', requireAuth, asyncHandler(controller.listAccounts));

router.get('/slots', requireAuth, asyncHandler(controller.listSlots));

router.get('/lots', requireAuth, asyncHandler(controller.listLots));

router.get('/incoming-pos', requireAuth, asyncHandler(controller.listIncomingPos));

// ---- GET tim kiem (read-only; tham so khong hop le tu ve mac dinh) ----

router.get('/pos', requireAuth, asyncHandler(controller.searchPos));

// Tim ma ke theo tu khoa — DOI TU /slots SANG /slots/search (2026-10-16:
// /slots gio la GET danh sach ke day du; route tinh /slots/search truoc
// route dong PATCH /slots/:code nen khong dung do).

router.get('/slots/search', requireAuth, asyncHandler(controller.searchSlots));

router.get('/activity', requireAuth, asyncHandler(controller.searchActivity));

// Reconcile issue OPEN (EXCESS/SHORTAGE/AMBIGUOUS/T8_CHANGED) — structured
// DTO có context số lượng + candidates, cho UI cảnh báo (BỔ SUNG #7).
router.get(
  '/reconcile-issues',
  requireAuth,
  asyncHandler(controller.listReconcileIssues)
);
// ---- LO HANG (whs_slot_allocation) — actor tu token ----

router.post(
  '/assign',
  requireAuth,
  requireBodyFields(['poId', 'slotCode', 'qty']),
  asyncHandler(controller.assignShelf)
);

router.post(
  '/lots/:id/iqc',
  requireAuth,
  requireBodyFields(['decision']),
  asyncHandler(controller.injectDecision)
);

router.post(
  '/lots/:id/move',
  requireAuth,
  requireBodyFields(['targetSlotCode', 'qty']),
  asyncHandler(controller.moveLot)
);


// HOÀN TÁC GÁN KỸ (2026-11-07): hard-delete allocation + release receipt
// mapping + resolve OPEN issue + audit UNDO_ASSIGN. Reason bắt buộc (#9).
router.post(
  '/lots/:id/undo',
  requireAuth,
  requireBodyFields(['reason']),
  asyncHandler(controller.undoLot)
);
// ---- KE HANG (whs_slots) — actor tu token ----

router.post(
  '/slots',
  requireAuth,
  requireBodyFields(['warehouse', 'row', 'floor', 'position']),
  asyncHandler(controller.createSlot)
);

router.post(
  '/slots/assign-keeper',
  requireAuth,
  requireBodyFields(['codes']),
  asyncHandler(controller.assignKeeper)
);

router.patch(
  '/slots/:code',
  requireAuth,
  asyncHandler(controller.updateSlot)
);

router.post(
  '/activity/qr-print',
  requireAuth,
  requireBodyFields(['codes']),
  asyncHandler(controller.logQrPrint)
);

// ---- TAI KHOAN (whs_user_role) — chi MANAGER (change-password = tu doi) ----

router.post(
  '/accounts',
  requireAuth,
  requireManager,
  requireBodyFields(['name', 'employeeCode', 'email', 'role']),
  asyncHandler(controller.createAccount)
);

router.patch(
  '/accounts/:id',
  requireAuth,
  requireManager,
  asyncHandler(controller.updateAccount)
);

// Route tinh dat truoc route dong /accounts/:id/*
router.post(
  '/accounts/change-password',
  requireAuth,
  requireBodyFields(['newPassword', 'confirm']),
  asyncHandler(controller.changePassword)
);

router.post(
  '/accounts/:id/lock',
  requireAuth,
  requireManager,
  asyncHandler(controller.toggleAccountLock)
);

router.post(
  '/accounts/:id/reset-password',
  requireAuth,
  requireManager,
  requireBodyFields(['newPassword']),
  asyncHandler(controller.resetAccountPassword)
);

// ---- PHAN CONG THU KHO NPL (whs_keeper_material_assignment) — chi MANAGER ----
// Route tinh /materials + /materials/assign-keeper truoc route dong
// /materials/:goodsNo/history.

router.get(
  '/materials',
  requireAuth,
  requireManager,
  asyncHandler(controller.listMaterials)
);

router.post(
  '/materials/assign-keeper',
  requireAuth,
  requireManager,
  requireBodyFields(['goodsNo', 'keeperEmpNo']),
  asyncHandler(controller.assignMaterialKeeper)
);

router.post(
  '/materials/end-assignment',
  requireAuth,
  requireManager,
  requireBodyFields(['goodsNo', 'keeperEmpNo']),
  asyncHandler(controller.endMaterialAssignment)
);

router.get(
  '/materials/:goodsNo/history',
  requireAuth,
  requireManager,
  asyncHandler(controller.materialHistory)
);

// ---- MANAGER KEEPER DETAIL (chi MANAGER — 2026-10-21 change request) ----

router.get(
  '/accounts/:id/keeper-detail',
  requireAuth,
  requireManager,
  asyncHandler(controller.keeperDetail)
);

// ---- RESET DEMO (chi MANAGER; dang tat — xem overview.service.js) ----

router.post(
  '/reset',
  requireAuth,
  requireManager,
  asyncHandler(controller.reset)
);

module.exports = router;
