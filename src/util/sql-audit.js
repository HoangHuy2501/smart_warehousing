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

function entries(values) {
    return Object.entries(values).filter(([, value]) => value !== undefined);
}

function predicate(where) {
    return entries(where).map(([column, value]) =>
        value === null ? column + ' IS NULL' : column + ' = ' + literal(value)).join(' AND ');
}

function insert(table, values) {
    const fields = entries(values);
    return `INSERT INTO ${table} (${fields.map(([column]) => column).join(', ')}) VALUES (${fields.map(([, value]) => literal(value)).join(', ')});`;
}

function update(table, values, where) {
    const changed = entries(values).map(([column, value]) => column + ' = ' + literal(value)).join(', ');
    return `UPDATE ${table} SET ${changed} WHERE ${predicate(where)};`;
}

function remove(table, where) {
    return `DELETE FROM ${table} WHERE ${predicate(where)};`;
}

function context(values) {
    return entries(values).map(([key, value]) =>
        '-- ' + key + ' = ' + literal(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n')).join('\n');
}

module.exports = { literal, insert, update, remove, context };
