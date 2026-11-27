'use strict';

// These strings describe committed changes for audit display; they are never executed.
function literal(value) {
    if (value == null) return 'NULL';
    if (value instanceof Date) return literal(value.toISOString());
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number' || typeof value === 'bigint') {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid_audit_number');
        return String(value);
    }
    return `N'${String(value).replace(/'/g, "''")}'`;
}

// Lấy các cột có giá trị để ghi nhật ký SQL.
function entries(values) {
    return Object.entries(values).filter(([, value]) => value !== undefined);
}

// Định dạng điều kiện lọc cho câu SQL trong nhật ký.
function predicate(where) {
    return entries(where).map(([column, value]) =>
        value === null ? column + ' IS NULL' : column + ' = ' + literal(value)).join(' AND ');
}

// Định dạng câu INSERT để ghi nhật ký.
function insert(table, values) {
    const fields = entries(values);
    return `INSERT INTO ${table} (${fields.map(([column]) => column).join(', ')}) VALUES (${fields.map(([, value]) => literal(value)).join(', ')});`;
}

// Định dạng câu UPDATE để ghi nhật ký.
function update(table, values, where) {
    const changed = entries(values).map(([column, value]) => column + ' = ' + literal(value)).join(', ');
    return `UPDATE ${table} SET ${changed} WHERE ${predicate(where)};`;
}

// Định dạng câu DELETE để ghi nhật ký.
function remove(table, where) {
    return `DELETE FROM ${table} WHERE ${predicate(where)};`;
}

// Định dạng thông tin bổ sung cho nhật ký.
function context(values) {
    return entries(values).map(([key, value]) =>
        '-- ' + key + ' = ' + literal(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n')).join('\n');
}

module.exports = { literal, insert, update, remove, context };
