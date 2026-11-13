/**
 * Du lieu mau demo cho schema moi (whs_* + t8_* mock) — port 1:1 tu
 * server/modules/warehouse/warehouse.seed.ts cua backend NestJS goc.
 *
 * Quan he: order1 -> order2 -> notice1/notice2 (notice_detail) -> pur_in1/in2 (GRN)
 *          order2.id = whs_slot_allocation.po_id (gan ke truc tiep tu PO)
 *          allocation x notice: whs_allocation_receipt (N-N, receipt.repository)
 * Luong moi: PO-25018 den hang CHUA co notice (in2.notice_id = NULL) —
 *          FE assign PO nay se tao allocation PO_ASSIGNED, chua co receipt.
 * Key cua moi object trung ten cot DB (snake_case) de repository insert truc tiep.
 */

'use strict';

/** Nhan vien (t8_bas_emp) */
const SEED_EMPS = [
  { id: 1, emp_no: 'EMP001', emp_name: 'Nguyễn Văn An', email: 'an.nguyen@germton.com', dept_no: 'GI-IT', org_no: 'GI', duty_no: 'NV', act_sw: 'Y' },
  { id: 2, emp_no: 'EMP002', emp_name: 'Trần Thị Bình', email: 'binh.tran@germton.com', dept_no: 'GI-IT', org_no: 'GI', duty_no: 'NV', act_sw: 'Y' },
  { id: 3, emp_no: 'EMP003', emp_name: 'Lê Văn Cường', email: 'cuong.le@germton.com', dept_no: 'GI-IT', org_no: 'GI', duty_no: 'QL', act_sw: 'Y' },
  { id: 4, emp_no: 'EMP-ADM', emp_name: 'ADM', email: 'adm@germton.com', dept_no: 'GI-IT', org_no: 'GI', duty_no: 'NV', act_sw: 'Y' },
];

/** Vai tro demo (whs_user_role): KEEPER / MANAGER */
const SEED_USER_ROLES = [
  { emp_no: 'EMP001', role: 'KEEPER', password: '123456', locked: false, active: true },
  { emp_no: 'EMP002', role: 'KEEPER', password: '123456', locked: false, active: true },
  { emp_no: 'EMP003', role: 'MANAGER', password: '123456', locked: false, active: true },
];

/** Hang hoa (t8_bas_goods) */
const SEED_GOODS = [
  { id: 1, goods_no: 'ITEM-SPCC', goods_name: 'Thép tấm SPCC', goods_spec: null, goods_type: 'RAW', unit_no: 'KG', pur_unit_no: 'KG', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 2, goods_no: 'ITEM-PIPE', goods_name: 'Ống thép mạ kẽm', goods_spec: null, goods_type: 'RAW', unit_no: 'SET', pur_unit_no: 'SET', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 3, goods_no: 'ITEM-CR', goods_name: 'Tôn lạnh 0.4mm', goods_spec: null, goods_type: 'RAW', unit_no: 'M', pur_unit_no: 'M', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 4, goods_no: 'ITEM-PVC', goods_name: 'Ống nhựa PVC', goods_spec: null, goods_type: 'RAW', unit_no: 'KG', pur_unit_no: 'KG', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 5, goods_no: 'ITEM-COLOR', goods_name: 'Tôn mạ màu', goods_spec: null, goods_type: 'RAW', unit_no: 'SET', pur_unit_no: 'SET', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 6, goods_no: 'ITEM-COIL', goods_name: 'Thép cuộn CR', goods_spec: null, goods_type: 'RAW', unit_no: 'KG', pur_unit_no: 'KG', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 7, goods_no: 'ITEM-V100', goods_name: 'Thép hình V100', goods_spec: null, goods_type: 'RAW', unit_no: 'M', pur_unit_no: 'M', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 8, goods_no: 'ITEM-BOLT', goods_name: 'Bulong M10 inox', goods_spec: null, goods_type: 'RAW', unit_no: 'KG', pur_unit_no: 'KG', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 9, goods_no: 'ITEM-BL80', goods_name: 'Bulong M12 inox', goods_spec: null, goods_type: 'RAW', unit_no: 'SET', pur_unit_no: 'SET', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 10, goods_no: 'ITEM-ANGLE', goods_name: 'Thép góc L50', goods_spec: null, goods_type: 'RAW', unit_no: 'M', pur_unit_no: 'M', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 11, goods_no: 'ITEM-SPHC', goods_name: 'Thép cuộn SPHC', goods_spec: null, goods_type: 'RAW', unit_no: 'KG', pur_unit_no: 'KG', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 12, goods_no: 'ITEM-PP', goods_name: 'Nhựa hạt PP', goods_spec: null, goods_type: 'RAW', unit_no: 'KG', pur_unit_no: 'KG', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 13, goods_no: 'ITEM-FLAT', goods_name: 'Thép dẹt 50mm', goods_spec: null, goods_type: 'RAW', unit_no: 'M', pur_unit_no: 'M', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 14, goods_no: 'ITEM-NUT', goods_name: 'Đai ốc M10', goods_spec: null, goods_type: 'RAW', unit_no: 'SET', pur_unit_no: 'SET', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  // NPL M1-M6 (Phase 2 2026-10-20): các PO mới chỉ dùng NPL này để lọt filter M1-M6;
  // các goods ITEM-* (VD ITEM-SPCC) sẽ BỊ LOẠI khỏi GET /pos.
  { id: 15, goods_no: 'M1001', goods_name: 'Thép tấm SPCC 1.2mm', goods_spec: null, goods_type: 'RAW', unit_no: 'KG', pur_unit_no: 'KG', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 16, goods_no: 'M2002', goods_name: 'Ống thép mạ kẽm 2 inch', goods_spec: null, goods_type: 'RAW', unit_no: 'SET', pur_unit_no: 'SET', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 17, goods_no: 'M3003', goods_name: 'Tôn lạnh mạ kẽm 0.5mm', goods_spec: null, goods_type: 'RAW', unit_no: 'M', pur_unit_no: 'M', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 18, goods_no: 'M4004', goods_name: 'Nhựa hạt PP chính hãng', goods_spec: null, goods_type: 'RAW', unit_no: 'KG', pur_unit_no: 'KG', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 19, goods_no: 'M5005', goods_name: 'Bulong M16 inox 304', goods_spec: null, goods_type: 'RAW', unit_no: 'SET', pur_unit_no: 'SET', st_no: '01', st_bit_no: null, act_sw: 'Y' },
  { id: 20, goods_no: 'M6006', goods_name: 'Thép góc L75 x 75', goods_spec: null, goods_type: 'RAW', unit_no: 'M', pur_unit_no: 'M', st_no: '01', st_bit_no: null, act_sw: 'Y' },
];

/** 33 PO (t8_pur_order1): 10 PO dong (L1..L10) + 5 PO mo + PO-25018 demo chua co notice + 10 PO test them (17..26) + 7 PO test filter moi (27..33, Phase 2 2026-10-20) */
const SEED_ORDER1 = [
  { id: 1, sheet_no: 'PO-25001', sheet_date: '2026-10-01T08:00:00+07:00', su_no: 'SU001', su_name11: 'Germton VN', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-08T08:30:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 2, sheet_no: 'PO-25002', sheet_date: '2026-10-01T08:00:00+07:00', su_no: 'SU002', su_name11: 'Hòa Phát', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-08T10:15:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 3, sheet_no: 'PO-25003', sheet_date: '2026-09-30T08:00:00+07:00', su_no: 'SU003', su_name11: 'Nam Kim Steel', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-07T07:45:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 4, sheet_no: 'PO-25004', sheet_date: '2026-09-29T08:00:00+07:00', su_no: 'SU004', su_name11: 'Đồng Tâm', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-06T10:20:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 5, sheet_no: 'PO-25005', sheet_date: '2026-09-28T08:00:00+07:00', su_no: 'SU005', su_name11: 'Vina GI', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-05T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 6, sheet_no: 'PO-25006', sheet_date: '2026-09-28T08:00:00+07:00', su_no: 'SU006', su_name11: 'Pomina', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-05T14:10:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 7, sheet_no: 'PO-25007', sheet_date: '2026-09-27T08:00:00+07:00', su_no: 'SU002', su_name11: 'Hòa Phát', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-04T09:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 8, sheet_no: 'PO-25008', sheet_date: '2026-10-02T08:00:00+07:00', su_no: 'SU007', su_name11: 'Đông Á Industrial', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-09T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 9, sheet_no: 'PO-25009', sheet_date: '2026-09-26T08:00:00+07:00', su_no: 'SU007', su_name11: 'Đông Á Industrial', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-03T13:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 10, sheet_no: 'PO-25010', sheet_date: '2026-10-02T08:00:00+07:00', su_no: 'SU008', su_name11: 'Thành Phát Co.', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-09T14:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'Y' },
  { id: 11, sheet_no: 'PO-25011', sheet_date: '2026-10-05T08:00:00+07:00', su_no: 'SU006', su_name11: 'Pomina', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-12T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 12, sheet_no: 'PO-25012', sheet_date: '2026-10-05T08:00:00+07:00', su_no: 'SU009', su_name11: 'Vina Plastic', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-12T10:30:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 13, sheet_no: 'PO-25013', sheet_date: '2026-10-06T08:00:00+07:00', su_no: 'SU010', su_name11: 'Hòa An Trading', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-15T09:00:00+07:00', sheet_sta: 'Y', check_sta: 'P', close_sw: 'N' },
  { id: 14, sheet_no: 'PO-25014', sheet_date: '2026-10-06T08:00:00+07:00', su_no: 'SU007', su_name11: 'Đông Á Industrial', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-16T14:00:00+07:00', sheet_sta: 'Y', check_sta: 'P', close_sw: 'N' },
  { id: 15, sheet_no: 'PO-25015', sheet_date: '2026-10-07T08:00:00+07:00', su_no: 'SU006', su_name11: 'Pomina', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-13T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  // PO demo: den hang CHUA co notice (GRN notice_id = NULL) — danh cho assign tu PO
  { id: 16, sheet_no: 'PO-25018', sheet_date: '2026-10-13T08:00:00+07:00', su_no: 'SU-011', su_name11: 'Thái Bình Fastener', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-16T09:00:00+07:00', sheet_sta: 'Y', check_sta: 'N', close_sw: 'N' },
  // Du lieu test them (17..26): PO mo du cac bucket ETA — qua han 3 muc / quanh hom nay / sap toi
  { id: 17, sheet_no: 'PO-25019', sheet_date: '2026-10-08T08:00:00+07:00', su_no: 'SU001', su_name11: 'Germton VN', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-14T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 18, sheet_no: 'PO-25020', sheet_date: '2026-10-09T08:00:00+07:00', su_no: 'SU002', su_name11: 'Hòa Phát', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-16T09:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 19, sheet_no: 'PO-25021', sheet_date: '2026-10-10T08:00:00+07:00', su_no: 'SU003', su_name11: 'Nam Kim Steel', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-20T09:30:00+07:00', sheet_sta: 'Y', check_sta: 'P', close_sw: 'N' },
  { id: 20, sheet_no: 'PO-25022', sheet_date: '2026-10-11T08:00:00+07:00', su_no: 'SU004', su_name11: 'Đồng Tâm', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-24T10:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 21, sheet_no: 'PO-25023', sheet_date: '2026-10-12T08:00:00+07:00', su_no: 'SU005', su_name11: 'Vina GI', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-30T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 22, sheet_no: 'PO-25024', sheet_date: '2026-10-13T08:00:00+07:00', su_no: 'SU008', su_name11: 'Thành Phát Co.', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-11-12T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'N', close_sw: 'N' },
  { id: 23, sheet_no: 'PO-25025', sheet_date: '2026-09-20T08:00:00+07:00', su_no: 'SU006', su_name11: 'Pomina', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-09-28T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 24, sheet_no: 'PO-25026', sheet_date: '2026-08-04T08:00:00+07:00', su_no: 'SU009', su_name11: 'Vina Plastic', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-08-10T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 25, sheet_no: 'PO-25027', sheet_date: '2026-06-15T08:00:00+07:00', su_no: 'SU007', su_name11: 'Đông Á Industrial', create_user: 'EMP-ADM', emp_no: 'EMP003', ship_date: '2026-06-20T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  { id: 26, sheet_no: 'PO-25028', sheet_date: '2026-10-06T08:00:00+07:00', su_no: 'SU010', su_name11: 'Hòa An Trading', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-12T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y', close_sw: 'N' },
  // PO test filter moi (27..33, Phase 2 2026-10-20) — mốc bucket tính theo
  // ngày chạy (today = 2026-10-20): 27 od1 / 28 od2 / 29 od3p / 30 next3 /
  // 31 next7 / 32 NULL del_date (od3p) / 33 sheet_sta='0' (chưa duyệt → BỊ LOẠI).
  { id: 27, sheet_no: 'PO-25029', sheet_date: '2026-10-14T08:00:00+07:00', su_no: 'SU001', su_name11: 'Germton VN', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-05T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'N', close_sw: 'N' },
  { id: 28, sheet_no: 'PO-25030', sheet_date: '2026-08-20T08:00:00+07:00', su_no: 'SU002', su_name11: 'Hòa Phát', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-09-10T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'N', close_sw: 'N' },
  { id: 29, sheet_no: 'PO-25031', sheet_date: '2026-05-06T08:00:00+07:00', su_no: 'SU003', su_name11: 'Nam Kim Steel', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-05-20T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'N', close_sw: 'N' },
  { id: 30, sheet_no: 'PO-25032', sheet_date: '2026-10-20T08:00:00+07:00', su_no: 'SU004', su_name11: 'Đồng Tâm', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-21T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'N', close_sw: 'N' },
  { id: 31, sheet_no: 'PO-25033', sheet_date: '2026-10-20T08:00:00+07:00', su_no: 'SU005', su_name11: 'Vina GI', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-26T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'N', close_sw: 'N' },
  { id: 32, sheet_no: 'PO-25034', sheet_date: '2026-10-20T08:00:00+07:00', su_no: 'SU006', su_name11: 'Pomina', create_user: 'EMP003', emp_no: 'EMP003', ship_date: null, sheet_sta: 'Y', check_sta: 'N', close_sw: 'N' },
  { id: 33, sheet_no: 'PO-25035', sheet_date: '2026-10-18T08:00:00+07:00', su_no: 'SU007', su_name11: 'Đông Á Industrial', create_user: 'EMP003', emp_no: 'EMP003', ship_date: '2026-10-22T08:00:00+07:00', sheet_sta: '0', check_sta: 'N', close_sw: 'N' },
];

/** 39 dong PO (t8_pur_order2): id = whs_slot_allocation.po_id (33..39 = NPL M1-M6 test filter moi) */
const SEED_ORDER2 = [
  { id: 1, sheet_id: 1, sheet_no: 'PO-25001', goods_no: 'ITEM-SPCC', unit_no: 'KG', sheet_qty: 500, sheet_pri: 20, del_date: '2026-10-08T08:30:00+07:00', su_del_date: null, made_lot: 'LOT-25001', sheet_lot: 'PO-25001_1', def02: 'STD', close_sw: 'Y' },
  { id: 2, sheet_id: 2, sheet_no: 'PO-25002', goods_no: 'ITEM-PIPE', unit_no: 'SET', sheet_qty: 320, sheet_pri: 25, del_date: '2026-10-08T10:15:00+07:00', su_del_date: null, made_lot: 'LOT-25002', sheet_lot: 'PO-25002_2', def02: 'STD', close_sw: 'Y' },
  { id: 3, sheet_id: 3, sheet_no: 'PO-25003', goods_no: 'ITEM-CR', unit_no: 'M', sheet_qty: 180, sheet_pri: 16, del_date: '2026-10-07T07:45:00+07:00', su_del_date: null, made_lot: 'LOT-25003', sheet_lot: 'PO-25003_3', def02: 'STD', close_sw: 'Y' },
  { id: 4, sheet_id: 4, sheet_no: 'PO-25004', goods_no: 'ITEM-PVC', unit_no: 'KG', sheet_qty: 400, sheet_pri: 12, del_date: '2026-10-06T10:20:00+07:00', su_del_date: null, made_lot: 'LOT-25004', sheet_lot: 'PO-25004_4', def02: 'STD', close_sw: 'Y' },
  { id: 5, sheet_id: 5, sheet_no: 'PO-25005', goods_no: 'ITEM-COLOR', unit_no: 'SET', sheet_qty: 150, sheet_pri: 30, del_date: '2026-10-05T08:00:00+07:00', su_del_date: null, made_lot: 'LOT-25005', sheet_lot: 'PO-25005_5', def02: 'STD', close_sw: 'Y' },
  { id: 6, sheet_id: 6, sheet_no: 'PO-25006', goods_no: 'ITEM-COIL', unit_no: 'KG', sheet_qty: 220, sheet_pri: 18, del_date: '2026-10-05T14:10:00+07:00', su_del_date: null, made_lot: 'LOT-25006', sheet_lot: 'PO-25006_6', def02: 'STD', close_sw: 'Y' },
  { id: 7, sheet_id: 7, sheet_no: 'PO-25007', goods_no: 'ITEM-V100', unit_no: 'M', sheet_qty: 60, sheet_pri: 22, del_date: '2026-10-04T09:00:00+07:00', su_del_date: null, made_lot: 'LOT-25007', sheet_lot: 'PO-25007_7', def02: 'STD', close_sw: 'Y' },
  { id: 8, sheet_id: 8, sheet_no: 'PO-25008', goods_no: 'ITEM-BOLT', unit_no: 'KG', sheet_qty: 45, sheet_pri: 40, del_date: '2026-10-09T08:00:00+07:00', su_del_date: null, made_lot: 'LOT-25008', sheet_lot: 'PO-25008_8', def02: 'STD', close_sw: 'Y' },
  { id: 9, sheet_id: 9, sheet_no: 'PO-25009', goods_no: 'ITEM-BL80', unit_no: 'SET', sheet_qty: 8000, sheet_pri: 5, del_date: '2026-10-03T13:00:00+07:00', su_del_date: null, made_lot: 'LOT-25009', sheet_lot: 'PO-25009_9', def02: 'STD', close_sw: 'Y' },
  { id: 10, sheet_id: 10, sheet_no: 'PO-25010', goods_no: 'ITEM-ANGLE', unit_no: 'M', sheet_qty: 260, sheet_pri: 14, del_date: '2026-10-09T14:00:00+07:00', su_del_date: null, made_lot: 'LOT-25010', sheet_lot: 'PO-25010_10', def02: 'STD', close_sw: 'Y' },
  { id: 11, sheet_id: 11, sheet_no: 'PO-25011', goods_no: 'ITEM-SPHC', unit_no: 'KG', sheet_qty: 600, sheet_pri: 18, del_date: '2026-10-12T08:00:00+07:00', su_del_date: null, made_lot: 'LOT-261012', sheet_lot: 'PO-25011_11', def02: 'STD', close_sw: 'N' },
  { id: 12, sheet_id: 12, sheet_no: 'PO-25012', goods_no: 'ITEM-PP', unit_no: 'KG', sheet_qty: 1200, sheet_pri: 22, del_date: '2026-10-12T10:30:00+07:00', su_del_date: null, made_lot: 'LOT-261012', sheet_lot: 'PO-25012_12', def02: 'STD', close_sw: 'N' },
  { id: 13, sheet_id: 13, sheet_no: 'PO-25013', goods_no: 'ITEM-FLAT', unit_no: 'M', sheet_qty: 350, sheet_pri: 15, del_date: '2026-10-15T09:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 14, sheet_id: 14, sheet_no: 'PO-25014', goods_no: 'ITEM-NUT', unit_no: 'SET', sheet_qty: 5000, sheet_pri: 5, del_date: '2026-10-16T14:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: 'PO-25014_14', def02: 'STD', close_sw: 'N' },
  { id: 15, sheet_id: 15, sheet_no: 'PO-25015', goods_no: 'ITEM-SPHC', unit_no: 'KG', sheet_qty: 450, sheet_pri: 18, del_date: '2026-10-13T08:00:00+07:00', su_del_date: null, made_lot: 'LOT-261013', sheet_lot: 'PO-25015_15', def02: 'STD', close_sw: 'N' },
  { id: 16, sheet_id: 15, sheet_no: 'PO-25015', goods_no: 'ITEM-SPHC', unit_no: 'KG', sheet_qty: 150, sheet_pri: 19, del_date: '2026-10-13T08:00:00+07:00', su_del_date: null, made_lot: 'LOT-261013', sheet_lot: 'PO-25015_16', def02: 'STYLE-B', close_sw: 'N' },
  { id: 17, sheet_id: 15, sheet_no: 'PO-25015', goods_no: 'ITEM-SPHC', unit_no: 'KG', sheet_qty: 200, sheet_pri: 18, del_date: '2026-10-14T08:00:00+07:00', su_del_date: null, made_lot: 'LOT-261014', sheet_lot: 'PO-25015_17', def02: 'STYLE-C', close_sw: 'N' },
  // Line moi cho PO-25018 (demo den hang chua co notice)
  { id: 18, sheet_id: 16, sheet_no: 'PO-25018', goods_no: 'ITEM-BOLT', unit_no: 'KG', sheet_qty: 400, sheet_pri: 35, del_date: '2026-10-16T09:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  // Du lieu test them (19..32): dong PO mo trai deu cac bucket ETA de test phan trang + gan ke
  { id: 19, sheet_id: 17, sheet_no: 'PO-25019', goods_no: 'ITEM-COIL', unit_no: 'KG', sheet_qty: 300, sheet_pri: 19, del_date: '2026-10-14T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 20, sheet_id: 17, sheet_no: 'PO-25019', goods_no: 'ITEM-PVC', unit_no: 'KG', sheet_qty: 250, sheet_pri: 13, del_date: '2026-10-14T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 21, sheet_id: 18, sheet_no: 'PO-25020', goods_no: 'ITEM-COLOR', unit_no: 'SET', sheet_qty: 180, sheet_pri: 28, del_date: '2026-10-16T09:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 22, sheet_id: 19, sheet_no: 'PO-25021', goods_no: 'ITEM-ANGLE', unit_no: 'M', sheet_qty: 400, sheet_pri: 15, del_date: '2026-10-20T09:30:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 23, sheet_id: 19, sheet_no: 'PO-25021', goods_no: 'ITEM-BOLT', unit_no: 'KG', sheet_qty: 60, sheet_pri: 38, del_date: '2026-10-20T09:30:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 24, sheet_id: 20, sheet_no: 'PO-25022', goods_no: 'ITEM-NUT', unit_no: 'SET', sheet_qty: 900, sheet_pri: 6, del_date: '2026-10-24T10:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 25, sheet_id: 21, sheet_no: 'PO-25023', goods_no: 'ITEM-PP', unit_no: 'KG', sheet_qty: 500, sheet_pri: 21, del_date: '2026-10-30T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 26, sheet_id: 22, sheet_no: 'PO-25024', goods_no: 'ITEM-SPCC', unit_no: 'KG', sheet_qty: 700, sheet_pri: 20, del_date: '2026-11-12T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 27, sheet_id: 22, sheet_no: 'PO-25024', goods_no: 'ITEM-CR', unit_no: 'M', sheet_qty: 240, sheet_pri: 17, del_date: '2026-11-12T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 28, sheet_id: 23, sheet_no: 'PO-25025', goods_no: 'ITEM-V100', unit_no: 'M', sheet_qty: 320, sheet_pri: 23, del_date: '2026-09-28T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 29, sheet_id: 24, sheet_no: 'PO-25026', goods_no: 'ITEM-FLAT', unit_no: 'M', sheet_qty: 150, sheet_pri: 16, del_date: '2026-08-10T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 30, sheet_id: 25, sheet_no: 'PO-25027', goods_no: 'ITEM-SPHC', unit_no: 'KG', sheet_qty: 260, sheet_pri: 18, del_date: '2026-06-20T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 31, sheet_id: 26, sheet_no: 'PO-25028', goods_no: 'ITEM-BL80', unit_no: 'SET', sheet_qty: 3000, sheet_pri: 5, del_date: '2026-10-12T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 32, sheet_id: 26, sheet_no: 'PO-25028', goods_no: 'ITEM-PIPE', unit_no: 'SET', sheet_qty: 90, sheet_pri: 26, del_date: '2026-10-12T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  // Dong PO test filter moi (33..39): chi NPL M1-M6 (33-37/39) + NULL del_date
  // (38 → od3p). Các dòng ITEM-* của PO cũ tự động BỊ LOẠI khỏi GET /pos.
  { id: 33, sheet_id: 27, sheet_no: 'PO-25029', goods_no: 'M1001', unit_no: 'KG', sheet_qty: 120, sheet_pri: 24, del_date: '2026-10-05T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 34, sheet_id: 28, sheet_no: 'PO-25030', goods_no: 'M2002', unit_no: 'SET', sheet_qty: 90, sheet_pri: 27, del_date: '2026-09-10T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 35, sheet_id: 29, sheet_no: 'PO-25031', goods_no: 'M3003', unit_no: 'M', sheet_qty: 60, sheet_pri: 19, del_date: '2026-05-20T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 36, sheet_id: 30, sheet_no: 'PO-25032', goods_no: 'M4004', unit_no: 'KG', sheet_qty: 200, sheet_pri: 16, del_date: '2026-10-21T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 37, sheet_id: 31, sheet_no: 'PO-25033', goods_no: 'M5005', unit_no: 'SET', sheet_qty: 150, sheet_pri: 35, del_date: '2026-10-26T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  { id: 38, sheet_id: 32, sheet_no: 'PO-25034', goods_no: 'M6006', unit_no: 'M', sheet_qty: 80, sheet_pri: 22, del_date: null, su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
  // Dòng này thuộc PO-25035 (sheet_sta = '0' chưa duyệt) → BỊ LOẠI khỏi GET /pos
  { id: 39, sheet_id: 33, sheet_no: 'PO-25035', goods_no: 'M1001', unit_no: 'KG', sheet_qty: 999, sheet_pri: 24, del_date: '2026-10-22T08:00:00+07:00', su_del_date: null, made_lot: null, sheet_lot: null, def02: 'STD', close_sw: 'N' },
];

/** 14 thong bao den hang (t8_pur_notice1) — KHONG co notice cho PO-25018 */
const SEED_NOTICE1 = [
  { id: 1, sheet_no: 'PN-261001', sheet_date: '2026-10-07T08:00:00+07:00', su_no: 'SU001', emp_no: 'EMP003', eta: '2026-10-08T08:30:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 2, sheet_no: 'PN-261002', sheet_date: '2026-10-07T08:00:00+07:00', su_no: 'SU002', emp_no: 'EMP003', eta: '2026-10-08T10:15:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 3, sheet_no: 'PN-261003', sheet_date: '2026-10-06T08:00:00+07:00', su_no: 'SU003', emp_no: 'EMP003', eta: '2026-10-07T07:45:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 4, sheet_no: 'PN-261004', sheet_date: '2026-10-05T08:00:00+07:00', su_no: 'SU004', emp_no: 'EMP003', eta: '2026-10-06T10:20:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 5, sheet_no: 'PN-261005', sheet_date: '2026-10-04T08:00:00+07:00', su_no: 'SU005', emp_no: 'EMP003', eta: '2026-10-05T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 6, sheet_no: 'PN-261006', sheet_date: '2026-10-04T08:00:00+07:00', su_no: 'SU006', emp_no: 'EMP003', eta: '2026-10-05T14:10:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 7, sheet_no: 'PN-261007', sheet_date: '2026-10-03T08:00:00+07:00', su_no: 'SU002', emp_no: 'EMP003', eta: '2026-10-04T09:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 8, sheet_no: 'PN-261008', sheet_date: '2026-10-08T08:00:00+07:00', su_no: 'SU007', emp_no: 'EMP003', eta: '2026-10-09T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 9, sheet_no: 'PN-261009', sheet_date: '2026-10-02T08:00:00+07:00', su_no: 'SU007', emp_no: 'EMP003', eta: '2026-10-03T13:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 10, sheet_no: 'PN-261010', sheet_date: '2026-10-08T08:00:00+07:00', su_no: 'SU008', emp_no: 'EMP003', eta: '2026-10-09T14:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 11, sheet_no: 'PN-261011', sheet_date: '2026-10-11T08:00:00+07:00', su_no: 'SU006', emp_no: 'EMP003', eta: '2026-10-12T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 12, sheet_no: 'PN-261012', sheet_date: '2026-10-11T08:00:00+07:00', su_no: 'SU009', emp_no: 'EMP003', eta: '2026-10-12T10:30:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 13, sheet_no: 'PN-261013', sheet_date: '2026-10-12T08:00:00+07:00', su_no: 'SU006', emp_no: 'EMP003', eta: '2026-10-13T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 14, sheet_no: 'PN-261014', sheet_date: '2026-10-13T08:00:00+07:00', su_no: 'SU006', emp_no: 'EMP003', eta: '2026-10-14T08:00:00+07:00', sheet_sta: 'Y', check_sta: 'Y' },
];

/**
 * 15 chi tiet thong bao (t8_pur_notice2) — id = notice_detail_id cua allocation.
 * adj_result: '1' PASS, '2' FAIL_PENDING, '3' EXEMPT, '4' PARTIAL_PASS,
 *             '5' RETURN, '6' AOD ('0' = chua co quyet dinh, ma mock).
 * sheet_lot = so lo thuc te (lay cung gia tri made_lot), allocation match
 * notice se copy sheet_lot sang whs_slot_allocation.lot_no.
 */
const SEED_NOTICE2 = [
  { id: 1, sheet_id: 1, sheet_no: 'PN-261001', pur_no: 'PO-25001', pur_id: 1, goods_no: 'ITEM-SPCC', unit_no: 'KG', st_no: '01', sheet_qty: 500, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '0', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25001', sheet_lot: 'LOT-25001', def02: 'STD', def23: '2026-10-08T08:30:00+07:00' },
  { id: 2, sheet_id: 2, sheet_no: 'PN-261002', pur_no: 'PO-25002', pur_id: 2, goods_no: 'ITEM-PIPE', unit_no: 'SET', st_no: '01', sheet_qty: 320, check_qty: 0, bad_qty: 320, return_qty: 0, qc_level: null, adj_result: '2', pro_result: null, qc_date: '2026-10-09T14:00:00+07:00', qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25002', sheet_lot: 'LOT-25002', def02: 'STD', def23: '2026-10-08T10:15:00+07:00' },
  { id: 3, sheet_id: 3, sheet_no: 'PN-261003', pur_no: 'PO-25003', pur_id: 3, goods_no: 'ITEM-CR', unit_no: 'M', st_no: '01', sheet_qty: 180, check_qty: 180, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '1', pro_result: null, qc_date: '2026-10-08T09:15:00+07:00', qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25003', sheet_lot: 'LOT-25003', def02: 'STD', def23: '2026-10-07T07:45:00+07:00' },
  { id: 4, sheet_id: 4, sheet_no: 'PN-261004', pur_no: 'PO-25004', pur_id: 4, goods_no: 'ITEM-PVC', unit_no: 'KG', st_no: '01', sheet_qty: 400, check_qty: 300, bad_qty: 0, return_qty: 100, qc_level: null, adj_result: '4', pro_result: null, qc_date: '2026-10-07T15:40:00+07:00', qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25004', sheet_lot: 'LOT-25004', def02: 'STD', def23: '2026-10-06T10:20:00+07:00' },
  { id: 5, sheet_id: 5, sheet_no: 'PN-261005', pur_no: 'PO-25005', pur_id: 5, goods_no: 'ITEM-COLOR', unit_no: 'SET', st_no: '01', sheet_qty: 150, check_qty: 0, bad_qty: 0, return_qty: 150, qc_level: null, adj_result: '5', pro_result: null, qc_date: '2026-10-06T10:30:00+07:00', qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25005', sheet_lot: 'LOT-25005', def02: 'STD', def23: '2026-10-05T08:00:00+07:00' },
  { id: 6, sheet_id: 6, sheet_no: 'PN-261006', pur_no: 'PO-25006', pur_id: 6, goods_no: 'ITEM-COIL', unit_no: 'KG', st_no: '01', sheet_qty: 220, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '6', pro_result: null, qc_date: '2026-10-07T08:50:00+07:00', qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25006', sheet_lot: 'LOT-25006', def02: 'STD', def23: '2026-10-05T14:10:00+07:00' },
  { id: 7, sheet_id: 7, sheet_no: 'PN-261007', pur_no: 'PO-25007', pur_id: 7, goods_no: 'ITEM-V100', unit_no: 'M', st_no: '01', sheet_qty: 60, check_qty: 60, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '3', pro_result: null, qc_date: '2026-10-05T09:00:00+07:00', qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25007', sheet_lot: 'LOT-25007', def02: 'STD', def23: '2026-10-04T09:00:00+07:00' },
  { id: 8, sheet_id: 8, sheet_no: 'PN-261008', pur_no: 'PO-25008', pur_id: 8, goods_no: 'ITEM-BOLT', unit_no: 'KG', st_no: '01', sheet_qty: 45, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '0', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25008', sheet_lot: 'LOT-25008', def02: 'STD', def23: '2026-10-09T08:00:00+07:00' },
  { id: 9, sheet_id: 9, sheet_no: 'PN-261009', pur_no: 'PO-25009', pur_id: 9, goods_no: 'ITEM-BL80', unit_no: 'SET', st_no: '01', sheet_qty: 8000, check_qty: 8000, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '1', pro_result: null, qc_date: '2026-10-04T09:15:00+07:00', qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25009', sheet_lot: 'LOT-25009', def02: 'STD', def23: '2026-10-03T13:00:00+07:00' },
  { id: 10, sheet_id: 10, sheet_no: 'PN-261010', pur_no: 'PO-25010', pur_id: 10, goods_no: 'ITEM-ANGLE', unit_no: 'M', st_no: '01', sheet_qty: 260, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '0', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25010', sheet_lot: 'LOT-25010', def02: 'STD', def23: '2026-10-09T14:00:00+07:00' },
  { id: 11, sheet_id: 11, sheet_no: 'PN-261011', pur_no: 'PO-25011', pur_id: 11, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', sheet_qty: 600, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '0', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-261012', sheet_lot: 'LOT-261012', def02: 'STD', def23: '2026-10-12T08:00:00+07:00' },
  { id: 12, sheet_id: 12, sheet_no: 'PN-261012', pur_no: 'PO-25012', pur_id: 12, goods_no: 'ITEM-PP', unit_no: 'KG', st_no: '01', sheet_qty: 1200, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '0', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-261012', sheet_lot: 'LOT-261012', def02: 'STD', def23: '2026-10-12T10:30:00+07:00' },
  { id: 13, sheet_id: 13, sheet_no: 'PN-261013', pur_no: 'PO-25015', pur_id: 15, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', sheet_qty: 450, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '0', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-261013', sheet_lot: 'LOT-261013', def02: 'STD', def23: '2026-10-13T08:00:00+07:00' },
  { id: 14, sheet_id: 13, sheet_no: 'PN-261013', pur_no: 'PO-25015', pur_id: 16, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', sheet_qty: 150, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '0', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-261013', sheet_lot: 'LOT-261013', def02: 'STYLE-B', def23: '2026-10-13T08:00:00+07:00' },
  { id: 15, sheet_id: 14, sheet_no: 'PN-261014', pur_no: 'PO-25015', pur_id: 17, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', sheet_qty: 200, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: '0', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-261014', sheet_lot: 'LOT-261014', def02: 'STYLE-C', def23: '2026-10-14T08:00:00+07:00' },
  // Case B (FINAL WHS DB CORRECTION 2026-10-17): 1 PO detail (order2 id 14)
  // co 2 notice — mirror bo du lieu whs3_ de test many-notice.
  { id: 9001, sheet_id: 9001, sheet_no: 'PN-261014A', pur_no: 'PO-25014', pur_id: 14, goods_no: 'ITEM-NUT', unit_no: 'SET', st_no: '01', sheet_qty: 3000, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: 'N', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25014A', sheet_lot: 'LOT-25014A', def02: 'STD', def23: '2026-10-16T14:00:00+07:00' },
  { id: 9002, sheet_id: 9002, sheet_no: 'PN-261014B', pur_no: 'PO-25014', pur_id: 14, goods_no: 'ITEM-NUT', unit_no: 'SET', st_no: '01', sheet_qty: 1500, check_qty: 0, bad_qty: 0, return_qty: 0, qc_level: null, adj_result: 'N', pro_result: null, qc_date: null, qc_user_no: null, qc_emp_no: null, made_lot: 'LOT-25014B', sheet_lot: 'LOT-25014B', def02: 'STD', def23: '2026-10-16T14:00:00+07:00' },
];

/** 22 phieu nhap kho (t8_pur_in1) — co GRN cho PO-25018 (id 15) + 7 GRN du lieu test them (16..22) */
const SEED_IN1 = [
  { id: 1, sheet_no: 'GRN-TMP-0001', sheet_date: '2026-10-08T08:30:00+07:00', su_no: 'SU001', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 2, sheet_no: 'GRN-TMP-0002', sheet_date: '2026-10-08T10:15:00+07:00', su_no: 'SU002', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 3, sheet_no: 'GRN-TMP-0003', sheet_date: '2026-10-07T07:45:00+07:00', su_no: 'SU003', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 4, sheet_no: 'GRN-TMP-0004', sheet_date: '2026-10-06T10:20:00+07:00', su_no: 'SU004', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 5, sheet_no: 'GRN-TMP-0005', sheet_date: '2026-10-05T08:00:00+07:00', su_no: 'SU005', emp_no: 'EMP002', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 6, sheet_no: 'GRN-TMP-0006', sheet_date: '2026-10-05T14:10:00+07:00', su_no: 'SU006', emp_no: 'EMP002', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 7, sheet_no: 'GRN-TMP-0007', sheet_date: '2026-10-04T09:00:00+07:00', su_no: 'SU002', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 8, sheet_no: 'GRN-TMP-0008', sheet_date: '2026-10-09T08:00:00+07:00', su_no: 'SU007', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 9, sheet_no: 'GRN-TMP-0009', sheet_date: '2026-10-03T13:00:00+07:00', su_no: 'SU007', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 10, sheet_no: 'GRN-TMP-0010', sheet_date: '2026-10-09T14:00:00+07:00', su_no: 'SU008', emp_no: 'EMP002', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 11, sheet_no: 'GRN-TMP-0112', sheet_date: '2026-10-12T08:00:00+07:00', su_no: 'SU006', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 12, sheet_no: 'GRN-TMP-0113', sheet_date: '2026-10-12T10:30:00+07:00', su_no: 'SU009', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 13, sheet_no: 'GRN-TMP-0114', sheet_date: '2026-10-13T08:00:00+07:00', su_no: 'SU006', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  { id: 14, sheet_no: 'GRN-TMP-0116', sheet_date: '2026-10-14T08:00:00+07:00', su_no: 'SU006', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  // GRN cho PO-25018: KHONG tham chieu notice (notice_id = NULL)
  { id: 15, sheet_no: 'GRN-TMP-0117', sheet_date: '2026-10-16T09:30:00+07:00', su_no: 'SU011', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'Y' },
  // GRN du lieu test them (16..22) — PO mo da nhap kho, san sang gan ke
  { id: 16, sheet_no: 'GRN-TMP-0119', sheet_date: '2026-10-14T08:30:00+07:00', su_no: 'SU001', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'N' },
  { id: 17, sheet_no: 'GRN-TMP-0120', sheet_date: '2026-10-16T09:10:00+07:00', su_no: 'SU002', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'N' },
  { id: 18, sheet_no: 'GRN-TMP-0121', sheet_date: '2026-10-20T14:00:00+07:00', su_no: 'SU003', emp_no: 'EMP002', st_no: '01', sheet_sta: 'Y', check_sta: 'N' },
  { id: 19, sheet_no: 'GRN-TMP-0125', sheet_date: '2026-09-28T08:30:00+07:00', su_no: 'SU006', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'N' },
  { id: 20, sheet_no: 'GRN-TMP-0126', sheet_date: '2026-08-10T08:30:00+07:00', su_no: 'SU009', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'N' },
  { id: 21, sheet_no: 'GRN-TMP-0127', sheet_date: '2026-06-20T08:30:00+07:00', su_no: 'SU007', emp_no: 'EMP002', st_no: '01', sheet_sta: 'Y', check_sta: 'N' },
  { id: 22, sheet_no: 'GRN-TMP-0128', sheet_date: '2026-10-12T08:30:00+07:00', su_no: 'SU010', emp_no: 'EMP001', st_no: '01', sheet_sta: 'Y', check_sta: 'N' },
];

/** 25 dong nhap kho (t8_pur_in2) — PO-25011 chi nhan 200/600; 17..25 = GRN test them chua co notice */
const SEED_IN2 = [
  { id: 1, sheet_id: 1, sheet_no: 'GRN-TMP-0001', notice_no: 'PN-261001', notice_id: 1, pur_no: 'PO-25001', pur_id: 1, goods_no: 'ITEM-SPCC', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 500, made_lot: 'LOT-25001', su_lot_no: null, sheet_lot: 'LOT-25001' },
  { id: 2, sheet_id: 2, sheet_no: 'GRN-TMP-0002', notice_no: 'PN-261002', notice_id: 2, pur_no: 'PO-25002', pur_id: 2, goods_no: 'ITEM-PIPE', unit_no: 'SET', st_no: '01', st_bit_no: null, sheet_qty: 320, made_lot: 'LOT-25002', su_lot_no: null, sheet_lot: 'LOT-25002' },
  { id: 3, sheet_id: 3, sheet_no: 'GRN-TMP-0003', notice_no: 'PN-261003', notice_id: 3, pur_no: 'PO-25003', pur_id: 3, goods_no: 'ITEM-CR', unit_no: 'M', st_no: '01', st_bit_no: null, sheet_qty: 180, made_lot: 'LOT-25003', su_lot_no: null, sheet_lot: 'LOT-25003' },
  { id: 4, sheet_id: 4, sheet_no: 'GRN-TMP-0004', notice_no: 'PN-261004', notice_id: 4, pur_no: 'PO-25004', pur_id: 4, goods_no: 'ITEM-PVC', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 400, made_lot: 'LOT-25004', su_lot_no: null, sheet_lot: 'LOT-25004' },
  { id: 5, sheet_id: 5, sheet_no: 'GRN-TMP-0005', notice_no: 'PN-261005', notice_id: 5, pur_no: 'PO-25005', pur_id: 5, goods_no: 'ITEM-COLOR', unit_no: 'SET', st_no: '01', st_bit_no: null, sheet_qty: 150, made_lot: 'LOT-25005', su_lot_no: null, sheet_lot: 'LOT-25005' },
  { id: 6, sheet_id: 6, sheet_no: 'GRN-TMP-0006', notice_no: 'PN-261006', notice_id: 6, pur_no: 'PO-25006', pur_id: 6, goods_no: 'ITEM-COIL', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 220, made_lot: 'LOT-25006', su_lot_no: null, sheet_lot: 'LOT-25006' },
  { id: 7, sheet_id: 7, sheet_no: 'GRN-TMP-0007', notice_no: 'PN-261007', notice_id: 7, pur_no: 'PO-25007', pur_id: 7, goods_no: 'ITEM-V100', unit_no: 'M', st_no: '01', st_bit_no: null, sheet_qty: 60, made_lot: 'LOT-25007', su_lot_no: null, sheet_lot: 'LOT-25007' },
  { id: 8, sheet_id: 8, sheet_no: 'GRN-TMP-0008', notice_no: 'PN-261008', notice_id: 8, pur_no: 'PO-25008', pur_id: 8, goods_no: 'ITEM-BOLT', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 45, made_lot: 'LOT-25008', su_lot_no: null, sheet_lot: 'LOT-25008' },
  { id: 9, sheet_id: 9, sheet_no: 'GRN-TMP-0009', notice_no: 'PN-261009', notice_id: 9, pur_no: 'PO-25009', pur_id: 9, goods_no: 'ITEM-BL80', unit_no: 'SET', st_no: '01', st_bit_no: null, sheet_qty: 8000, made_lot: 'LOT-25009', su_lot_no: null, sheet_lot: 'LOT-25009' },
  { id: 10, sheet_id: 10, sheet_no: 'GRN-TMP-0010', notice_no: 'PN-261010', notice_id: 10, pur_no: 'PO-25010', pur_id: 10, goods_no: 'ITEM-ANGLE', unit_no: 'M', st_no: '01', st_bit_no: null, sheet_qty: 260, made_lot: 'LOT-25010', su_lot_no: null, sheet_lot: 'LOT-25010' },
  { id: 11, sheet_id: 11, sheet_no: 'GRN-TMP-0112', notice_no: 'PN-261011', notice_id: 11, pur_no: 'PO-25011', pur_id: 11, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 200, made_lot: 'LOT-261012', su_lot_no: null, sheet_lot: 'LOT-261012' },
  { id: 12, sheet_id: 12, sheet_no: 'GRN-TMP-0113', notice_no: 'PN-261012', notice_id: 12, pur_no: 'PO-25012', pur_id: 12, goods_no: 'ITEM-PP', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 1200, made_lot: 'LOT-261012', su_lot_no: null, sheet_lot: 'LOT-261012' },
  { id: 13, sheet_id: 13, sheet_no: 'GRN-TMP-0114', notice_no: 'PN-261013', notice_id: 13, pur_no: 'PO-25015', pur_id: 15, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 450, made_lot: 'LOT-261013', su_lot_no: null, sheet_lot: 'LOT-261013' },
  { id: 14, sheet_id: 13, sheet_no: 'GRN-TMP-0114', notice_no: 'PN-261013', notice_id: 14, pur_no: 'PO-25015', pur_id: 16, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 150, made_lot: 'LOT-261013', su_lot_no: null, sheet_lot: 'LOT-261013' },
  { id: 15, sheet_id: 14, sheet_no: 'GRN-TMP-0116', notice_no: 'PN-261014', notice_id: 15, pur_no: 'PO-25015', pur_id: 17, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 200, made_lot: 'LOT-261014', su_lot_no: null, sheet_lot: 'LOT-261014' },
  // GRN cho PO-25018: den hang ma CHUA co thong bao notice
  { id: 16, sheet_id: 15, sheet_no: 'GRN-TMP-0117', notice_no: null, notice_id: null, pur_no: 'PO-25018', pur_id: 18, goods_no: 'ITEM-BOLT', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 400, made_lot: null, su_lot_no: null, sheet_lot: null },
  // GRN du lieu test them (17..25): PO mo da nhap, T8 chua push notice (PO_ASSIGNED sau khi gan)
  { id: 17, sheet_id: 16, sheet_no: 'GRN-TMP-0119', notice_no: null, notice_id: null, pur_no: 'PO-25019', pur_id: 19, goods_no: 'ITEM-COIL', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 300, made_lot: null, su_lot_no: null, sheet_lot: null },
  { id: 18, sheet_id: 16, sheet_no: 'GRN-TMP-0119', notice_no: null, notice_id: null, pur_no: 'PO-25019', pur_id: 20, goods_no: 'ITEM-PVC', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 250, made_lot: null, su_lot_no: null, sheet_lot: null },
  { id: 19, sheet_id: 17, sheet_no: 'GRN-TMP-0120', notice_no: null, notice_id: null, pur_no: 'PO-25020', pur_id: 21, goods_no: 'ITEM-COLOR', unit_no: 'SET', st_no: '01', st_bit_no: null, sheet_qty: 180, made_lot: null, su_lot_no: null, sheet_lot: null },
  { id: 20, sheet_id: 18, sheet_no: 'GRN-TMP-0121', notice_no: null, notice_id: null, pur_no: 'PO-25021', pur_id: 22, goods_no: 'ITEM-ANGLE', unit_no: 'M', st_no: '01', st_bit_no: null, sheet_qty: 400, made_lot: null, su_lot_no: null, sheet_lot: null },
  { id: 21, sheet_id: 19, sheet_no: 'GRN-TMP-0125', notice_no: null, notice_id: null, pur_no: 'PO-25025', pur_id: 28, goods_no: 'ITEM-V100', unit_no: 'M', st_no: '01', st_bit_no: null, sheet_qty: 320, made_lot: null, su_lot_no: null, sheet_lot: null },
  { id: 22, sheet_id: 20, sheet_no: 'GRN-TMP-0126', notice_no: null, notice_id: null, pur_no: 'PO-25026', pur_id: 29, goods_no: 'ITEM-FLAT', unit_no: 'M', st_no: '01', st_bit_no: null, sheet_qty: 150, made_lot: null, su_lot_no: null, sheet_lot: null },
  { id: 23, sheet_id: 21, sheet_no: 'GRN-TMP-0127', notice_no: null, notice_id: null, pur_no: 'PO-25027', pur_id: 30, goods_no: 'ITEM-SPHC', unit_no: 'KG', st_no: '01', st_bit_no: null, sheet_qty: 260, made_lot: null, su_lot_no: null, sheet_lot: null },
  { id: 24, sheet_id: 22, sheet_no: 'GRN-TMP-0128', notice_no: null, notice_id: null, pur_no: 'PO-25028', pur_id: 31, goods_no: 'ITEM-BL80', unit_no: 'SET', st_no: '01', st_bit_no: null, sheet_qty: 3000, made_lot: null, su_lot_no: null, sheet_lot: null },
  { id: 25, sheet_id: 22, sheet_no: 'GRN-TMP-0128', notice_no: null, notice_id: null, pur_no: 'PO-25028', pur_id: 32, goods_no: 'ITEM-PIPE', unit_no: 'SET', st_no: '01', st_bit_no: null, sheet_qty: 90, made_lot: null, su_lot_no: null, sheet_lot: null },
];

/** Ke hang GIF3: 4 row x 3 floor x 3 position = 36 slot (A4 Phase 2 2026-10-20) */
function makeSlots() {
  const slots = [];
  for (const row of ['A1', 'A2', 'A3', 'A4']) {
    for (let floor = 1; floor <= 3; floor += 1) {
      for (let position = 1; position <= 3; position += 1) {
        const code = `GIF3-${row}-${String(floor).padStart(2, '0')}-${String(position).padStart(2, '0')}`;
        slots.push({
          code,
          warehouse: 'GIF3',
          slot_row: row,
          floor: String(floor).padStart(2, '0'),
          position: String(position).padStart(2, '0'),
          // A4: tầng 1-2 thuộc TEST-KPR (test shelf permission 403);
          // tầng 3 CHƯA CÓ CHỦ — KEEPER nào cũng thao tác được (§10).
          keeper_emp_no:
            row === 'A4'
              ? (floor < 3 ? 'TEST-KPR' : null)
              : row === 'A3' ? 'EMP002' : 'EMP001',
          locked: code === 'GIF3-A2-03-02',
          is_full: code === 'GIF3-A1-03-01',
          active: true,
        });
      }
    }
  }
  return slots;
}

const SEED_SLOTS = makeSlots();

/**
 * 12 allocation tren ke — closed_at NULL (ke ca RETURNED/AOD con vat ly tren ke; L12 = TEST-KPR tren ke A4).
 * Cot theo luong assign-tu-PO (schema moi 2026-10-17):
 *   po_id = t8_pur_order2.id; KHONG con notice_detail_id/notice_confirmed.
 *   lot_no = mirror hien thi (moi allocation seed co dung 1 receipt/lot).
 *   warehouse_status: 'IN' neu status IN_STOCK, 'RETURN' neu RETURNED,
 *                     con lai 'TEMP_IN'
 *     (FAIL_PENDING van giu 'TEMP_IN' — chua co quyet dinh IQC final)
 */
const SEED_ALLOCATIONS = [
  { id: 'L1', po_id: 1, goods_no: 'ITEM-SPCC', lot_no: 'LOT-25001', warehouse_status: 'TEMP_IN', slot_code: 'GIF3-A1-01-01', allocated_qty: 500, status: 'WAITING_IQC', iqc_decision: null, has_warning: false, qty_in_stock: null, qty_return: null, qty_aod: null, last_iqc_at: null, allocated_by_emp_no: 'EMP001', allocated_at: '2026-10-08T09:00:00+07:00' },
  { id: 'L2', po_id: 2, goods_no: 'ITEM-PIPE', lot_no: 'LOT-25002', warehouse_status: 'TEMP_IN', slot_code: 'GIF3-A1-01-02', allocated_qty: 320, status: 'WAITING_IQC', iqc_decision: 'FAIL_PENDING', has_warning: true, qty_in_stock: null, qty_return: null, qty_aod: null, last_iqc_at: '2026-10-09T14:00:00+07:00', allocated_by_emp_no: 'EMP001', allocated_at: '2026-10-08T11:00:00+07:00' },
  { id: 'L3', po_id: 3, goods_no: 'ITEM-CR', lot_no: 'LOT-25003', warehouse_status: 'IN', slot_code: 'GIF3-A1-02-01', allocated_qty: 180, status: 'IN_STOCK', iqc_decision: 'PASS', has_warning: false, qty_in_stock: 180, qty_return: null, qty_aod: null, last_iqc_at: '2026-10-08T09:15:00+07:00', allocated_by_emp_no: 'EMP001', allocated_at: '2026-10-07T08:20:00+07:00' },
  { id: 'L4', po_id: 4, goods_no: 'ITEM-PVC', lot_no: 'LOT-25004', warehouse_status: 'IN', slot_code: 'GIF3-A2-01-01', allocated_qty: 400, status: 'IN_STOCK', iqc_decision: 'PASS', has_warning: false, qty_in_stock: 400, qty_return: null, qty_aod: null, last_iqc_at: '2026-10-07T15:40:00+07:00', allocated_by_emp_no: 'EMP001', allocated_at: '2026-10-06T11:00:00+07:00' },
  { id: 'L5', po_id: 5, goods_no: 'ITEM-COLOR', lot_no: 'LOT-25005', warehouse_status: 'RETURN', slot_code: 'GIF3-A3-01-01', allocated_qty: 150, status: 'RETURNED', iqc_decision: 'RETURN', has_warning: false, qty_in_stock: null, qty_return: 150, qty_aod: null, last_iqc_at: '2026-10-06T10:30:00+07:00', allocated_by_emp_no: 'EMP002', allocated_at: '2026-10-05T09:00:00+07:00' },
  { id: 'L6', po_id: 6, goods_no: 'ITEM-COIL', lot_no: 'LOT-25006', warehouse_status: 'RETURN', slot_code: 'GIF3-A3-02-01', allocated_qty: 220, status: 'RETURNED', iqc_decision: 'RETURN', has_warning: false, qty_in_stock: null, qty_return: 220, qty_aod: null, last_iqc_at: '2026-10-07T08:50:00+07:00', allocated_by_emp_no: 'EMP002', allocated_at: '2026-10-05T15:00:00+07:00' },
  { id: 'L7', po_id: 7, goods_no: 'ITEM-V100', lot_no: 'LOT-25007', warehouse_status: 'IN', slot_code: 'GIF3-A1-03-01', allocated_qty: 60, status: 'IN_STOCK', iqc_decision: 'EXEMPT', has_warning: false, qty_in_stock: 60, qty_return: null, qty_aod: null, last_iqc_at: '2026-10-05T09:00:00+07:00', allocated_by_emp_no: 'EMP001', allocated_at: '2026-10-04T10:00:00+07:00' },
  { id: 'L8', po_id: 8, goods_no: 'ITEM-BOLT', lot_no: 'LOT-25008', warehouse_status: 'TEMP_IN', slot_code: 'GIF3-A1-03-01', allocated_qty: 45, status: 'WAITING_IQC', iqc_decision: null, has_warning: false, qty_in_stock: null, qty_return: null, qty_aod: null, last_iqc_at: null, allocated_by_emp_no: 'EMP001', allocated_at: '2026-10-09T08:30:00+07:00' },
  { id: 'L9', po_id: 9, goods_no: 'ITEM-BL80', lot_no: 'LOT-25009', warehouse_status: 'IN', slot_code: 'GIF3-A2-02-03', allocated_qty: 8000, status: 'IN_STOCK', iqc_decision: 'PASS', has_warning: false, qty_in_stock: 8000, qty_return: null, qty_aod: null, last_iqc_at: '2026-10-04T09:15:00+07:00', allocated_by_emp_no: 'EMP001', allocated_at: '2026-10-03T14:30:00+07:00' },
  { id: 'L10', po_id: 10, goods_no: 'ITEM-ANGLE', lot_no: 'LOT-25010', warehouse_status: 'TEMP_IN', slot_code: 'GIF3-A3-03-01', allocated_qty: 260, status: 'WAITING_IQC', iqc_decision: null, has_warning: false, qty_in_stock: null, qty_return: null, qty_aod: null, last_iqc_at: null, allocated_by_emp_no: 'EMP002', allocated_at: '2026-10-09T15:00:00+07:00' },
  { id: 'L11', po_id: 11, goods_no: 'ITEM-SPHC', lot_no: 'LOT-261012', warehouse_status: 'TEMP_IN', slot_code: 'GIF3-A1-01-03', allocated_qty: 200, status: 'WAITING_IQC', iqc_decision: null, has_warning: false, qty_in_stock: null, qty_return: null, qty_aod: null, last_iqc_at: null, allocated_by_emp_no: 'EMP001', allocated_at: '2026-10-12T09:30:00+07:00' },
  // Phase 2 2026-10-20: allocation di dong cua TEST-KPR tren ke A4 (PO-25029 / M1001,
  // da gan 50/120 — gap 50 con lai van hien thi tren /pos).
  { id: 'L12', po_id: 33, goods_no: 'M1001', lot_no: null, warehouse_status: 'TEMP_IN', slot_code: 'GIF3-A4-01-01', allocated_qty: 50, status: 'WAITING_IQC', iqc_decision: null, has_warning: false, qty_in_stock: null, qty_return: null, qty_aod: null, last_iqc_at: null, allocated_by_emp_no: 'TEST-KPR', allocated_at: '2026-10-19T09:00:00+07:00' },
];

/**
 * Receipt allocation x notice (whs_allocation_receipt) — seed 1-1: moi
 * allocation L<k> khop notice k. received_qty = allocated_qty seed;
 * iqc_decision/qty_* / qc_date mirror allocation (nguon IQC tren receipt,
 * allocation giu ban sao hien thi theo contract ILotV2).
 */
const SEED_RECEIPTS = [
  { id: 'R1', allocation_id: 'L1', notice_detail_id: 1, received_qty: 500, lot_no: 'LOT-25001', iqc_decision: null, qty_in_stock: null, qty_return: null, qty_aod: null, has_warning: false, qc_date: null, confirmed_at: '2026-10-08T09:00:00+07:00', updated_at: '2026-10-08T09:00:00+07:00' },
  { id: 'R2', allocation_id: 'L2', notice_detail_id: 2, received_qty: 320, lot_no: 'LOT-25002', iqc_decision: 'FAIL_PENDING', qty_in_stock: null, qty_return: null, qty_aod: null, has_warning: true, qc_date: '2026-10-09T14:00:00+07:00', confirmed_at: '2026-10-08T11:00:00+07:00', updated_at: '2026-10-09T14:00:00+07:00' },
  { id: 'R3', allocation_id: 'L3', notice_detail_id: 3, received_qty: 180, lot_no: 'LOT-25003', iqc_decision: 'PASS', qty_in_stock: 180, qty_return: null, qty_aod: null, has_warning: false, qc_date: '2026-10-08T09:15:00+07:00', confirmed_at: '2026-10-07T08:20:00+07:00', updated_at: '2026-10-08T09:15:00+07:00' },
  { id: 'R4', allocation_id: 'L4', notice_detail_id: 4, received_qty: 400, lot_no: 'LOT-25004', iqc_decision: 'PASS', qty_in_stock: 400, qty_return: null, qty_aod: null, has_warning: false, qc_date: '2026-10-07T15:40:00+07:00', confirmed_at: '2026-10-06T11:00:00+07:00', updated_at: '2026-10-07T15:40:00+07:00' },
  { id: 'R5', allocation_id: 'L5', notice_detail_id: 5, received_qty: 150, lot_no: 'LOT-25005', iqc_decision: 'RETURN', qty_in_stock: null, qty_return: 150, qty_aod: null, has_warning: false, qc_date: '2026-10-06T10:30:00+07:00', confirmed_at: '2026-10-05T09:00:00+07:00', updated_at: '2026-10-06T10:30:00+07:00' },
  { id: 'R6', allocation_id: 'L6', notice_detail_id: 6, received_qty: 220, lot_no: 'LOT-25006', iqc_decision: 'RETURN', qty_in_stock: null, qty_return: 220, qty_aod: null, has_warning: false, qc_date: '2026-10-07T08:50:00+07:00', confirmed_at: '2026-10-05T15:00:00+07:00', updated_at: '2026-10-07T08:50:00+07:00' },
  { id: 'R7', allocation_id: 'L7', notice_detail_id: 7, received_qty: 60, lot_no: 'LOT-25007', iqc_decision: 'EXEMPT', qty_in_stock: 60, qty_return: null, qty_aod: null, has_warning: false, qc_date: '2026-10-05T09:00:00+07:00', confirmed_at: '2026-10-04T10:00:00+07:00', updated_at: '2026-10-05T09:00:00+07:00' },
  { id: 'R8', allocation_id: 'L8', notice_detail_id: 8, received_qty: 45, lot_no: 'LOT-25008', iqc_decision: null, qty_in_stock: null, qty_return: null, qty_aod: null, has_warning: false, qc_date: null, confirmed_at: '2026-10-09T08:30:00+07:00', updated_at: '2026-10-09T08:30:00+07:00' },
  { id: 'R9', allocation_id: 'L9', notice_detail_id: 9, received_qty: 8000, lot_no: 'LOT-25009', iqc_decision: 'PASS', qty_in_stock: 8000, qty_return: null, qty_aod: null, has_warning: false, qc_date: '2026-10-04T09:15:00+07:00', confirmed_at: '2026-10-03T14:30:00+07:00', updated_at: '2026-10-04T09:15:00+07:00' },
  { id: 'R10', allocation_id: 'L10', notice_detail_id: 10, received_qty: 260, lot_no: 'LOT-25010', iqc_decision: null, qty_in_stock: null, qty_return: null, qty_aod: null, has_warning: false, qc_date: null, confirmed_at: '2026-10-09T15:00:00+07:00', updated_at: '2026-10-09T15:00:00+07:00' },
  { id: 'R11', allocation_id: 'L11', notice_detail_id: 11, received_qty: 200, lot_no: 'LOT-261012', iqc_decision: null, qty_in_stock: null, qty_return: null, qty_aod: null, has_warning: false, qc_date: null, confirmed_at: '2026-10-12T09:30:00+07:00', updated_at: '2026-10-12T09:30:00+07:00' },
];

/** Seed 1:1 — voi du lieu mau, allocation L<k> khop notice id k. */
const NOTICE_OF_SEED_ALLOCATION = {
  L1: 1, L2: 2, L3: 3, L4: 4, L5: 5, L6: 6, L7: 7, L8: 8, L9: 9, L10: 10, L11: 11,
};

function assignActivity(index, alloc) {
  return {
    id: `seed-act-a${index}`,
    acted_at: alloc.allocated_at,
    emp_no: alloc.allocated_by_emp_no,
    user_name: alloc.allocated_by_emp_no === 'EMP002' ? 'Trần Thị Bình' : 'Nguyễn Văn An',
    action_key: 'actAssign',
    allocation_id: alloc.id,
    po_id: alloc.po_id,
    notice_detail_id: NOTICE_OF_SEED_ALLOCATION[alloc.id] ?? null,
    po_number: PO_OF_PO_ID[alloc.po_id],
    slot_code: alloc.slot_code,
    qty: alloc.allocated_qty,
    unit: null,
    detail: `Lô ${LOT_OF_PO_ID[alloc.po_id]}`,
  };
}

/** po_id -> so PO (seed 1:1) */
const PO_OF_PO_ID = {
  1: 'PO-25001', 2: 'PO-25002', 3: 'PO-25003', 4: 'PO-25004', 5: 'PO-25005',
  6: 'PO-25006', 7: 'PO-25007', 8: 'PO-25008', 9: 'PO-25009', 10: 'PO-25010',
  11: 'PO-25011',
};

/** po_id -> so lot (seed 1:1) */
const LOT_OF_PO_ID = {
  1: 'LOT-25001', 2: 'LOT-25002', 3: 'LOT-25003', 4: 'LOT-25004', 5: 'LOT-25005',
  6: 'LOT-25006', 7: 'LOT-25007', 8: 'LOT-25008', 9: 'LOT-25009', 10: 'LOT-25010',
  11: 'LOT-261012',
};

const SEED_ACTIVITY = [
  ...SEED_ALLOCATIONS.map((alloc, i) => assignActivity(i + 1, alloc)),
  { id: 'seed-act-i1', acted_at: '2026-10-09T14:00:00+07:00', emp_no: 'EMP003', user_name: 'Lê Văn Cường', action_key: 'actIqc', allocation_id: 'L2', po_id: 2, notice_detail_id: 2, po_number: 'PO-25002', slot_code: 'GIF3-A1-01-02', qty: 320, unit: 'SET', detail: 'FAIL_PENDING' },
  { id: 'seed-act-i2', acted_at: '2026-10-08T09:15:00+07:00', emp_no: 'EMP003', user_name: 'Lê Văn Cường', action_key: 'actIqc', allocation_id: 'L3', po_id: 3, notice_detail_id: 3, po_number: 'PO-25003', slot_code: 'GIF3-A1-02-01', qty: 180, unit: 'M', detail: 'PASS' },
  { id: 'seed-act-i3', acted_at: '2026-10-07T15:40:00+07:00', emp_no: 'EMP003', user_name: 'Lê Văn Cường', action_key: 'actIqc', allocation_id: 'L4', po_id: 4, notice_detail_id: 4, po_number: 'PO-25004', slot_code: 'GIF3-A2-01-01', qty: 400, unit: 'KG', detail: 'PASS' },
  { id: 'seed-act-i4', acted_at: '2026-10-06T10:30:00+07:00', emp_no: 'EMP003', user_name: 'Lê Văn Cường', action_key: 'actIqc', allocation_id: 'L5', po_id: 5, notice_detail_id: 5, po_number: 'PO-25005', slot_code: 'GIF3-A3-01-01', qty: 150, unit: 'SET', detail: 'RETURN' },
  { id: 'seed-act-i5', acted_at: '2026-10-07T08:50:00+07:00', emp_no: 'EMP003', user_name: 'Lê Văn Cường', action_key: 'actIqc', allocation_id: 'L6', po_id: 6, notice_detail_id: 6, po_number: 'PO-25006', slot_code: 'GIF3-A3-02-01', qty: 220, unit: 'KG', detail: 'RETURN' },
  { id: 'seed-act-i6', acted_at: '2026-10-05T09:00:00+07:00', emp_no: 'EMP003', user_name: 'Lê Văn Cường', action_key: 'actIqc', allocation_id: 'L7', po_id: 7, notice_detail_id: 7, po_number: 'PO-25007', slot_code: 'GIF3-A1-03-01', qty: 60, unit: 'M', detail: 'EXEMPT' },
  { id: 'seed-act-i7', acted_at: '2026-10-04T09:15:00+07:00', emp_no: 'EMP003', user_name: 'Lê Văn Cường', action_key: 'actIqc', allocation_id: 'L9', po_id: 9, notice_detail_id: 9, po_number: 'PO-25009', slot_code: 'GIF3-A2-02-03', qty: 8000, unit: 'SET', detail: 'PASS' },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Tra ve ban sao (deep clone) toan bo seed — dung khi reset demo */
function buildSeed() {
  return {
    emps: clone(SEED_EMPS),
    userRoles: clone(SEED_USER_ROLES),
    goods: clone(SEED_GOODS),
    order1: clone(SEED_ORDER1),
    order2: clone(SEED_ORDER2),
    notice1: clone(SEED_NOTICE1),
    notice2: clone(SEED_NOTICE2),
    in1: clone(SEED_IN1),
    in2: clone(SEED_IN2),
    slots: clone(SEED_SLOTS),
    allocations: clone(SEED_ALLOCATIONS),
    receipts: clone(SEED_RECEIPTS),
    activity: clone(SEED_ACTIVITY),
  };
}

module.exports = {
  SEED_EMPS,
  SEED_USER_ROLES,
  SEED_GOODS,
  SEED_ORDER1,
  SEED_ORDER2,
  SEED_NOTICE1,
  SEED_NOTICE2,
  SEED_IN1,
  SEED_IN2,
  SEED_SLOTS,
  SEED_ALLOCATIONS,
  SEED_RECEIPTS,
  SEED_ACTIVITY,
  buildSeed,
};
