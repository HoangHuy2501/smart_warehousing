'use strict';

const db = require('../config/db');

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('Invalid pagination number');
  }
  return Math.min(number, max);
}

async function pagination({
  query, params = [], page, pageSize, orderBy = '(SELECT NULL)',
  count = true, distinctBy, withSql = '',
}) {
  const currentPage = positiveInt(page, 1);
  const limit = positiveInt(pageSize, 20, 500);
  const offset = (currentPage - 1) * limit;
  if (!Number.isSafeInteger(offset)) throw new Error('Pagination offset is too large');
  if (typeof query !== 'string' || !query.trim()) throw new Error('SQL query is required');
  if (typeof orderBy !== 'string' || !orderBy.trim()) throw new Error('ORDER BY is required');

  const base = query.trim().replace(/;+\s*$/, '');
  const from = `FROM (${base}) AS pg_source`;
  const pg = db.getDialect() === 'pg';
  const countFunction = pg ? 'COUNT' : 'COUNT_BIG';
  const totalAlias = pg ? '"totalItems"' : '[totalItems]';
  if (distinctBy !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(distinctBy)) {
    throw new Error('Invalid distinct count column');
  }
  const distinctCount = distinctBy
    ? `, COUNT(DISTINCT pg_source.${pg ? '"' + distinctBy + '"' : '[' + distinctBy + ']'}) AS ${pg ? '"totalDistinct"' : '[totalDistinct]'}`
    : '';
  let totalDistinct = null;
  let totalItems = null;
  if (count) {
    const { rows } = await db.query(`
      ${withSql}
      SELECT ${countFunction}(*) AS ${totalAlias}${distinctCount}
      ${from};
    `, params);
    totalItems = Number(rows[0].totalItems);
    if (distinctBy) totalDistinct = Number(rows[0].totalDistinct);
    if (!Number.isSafeInteger(totalItems) || (distinctBy && !Number.isSafeInteger(totalDistinct))) throw new Error('Total count exceeds safe JS integer range');
  }

  const { rows: data } = totalItems !== null && offset >= totalItems
    ? { rows: [] }
    : await db.query(`${withSql}
        SELECT *
        ${from}
        ORDER BY ${orderBy}
        OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
      `, [...params, offset, limit]);

  return {
    data,
    pagination: {
      page: currentPage,
      pageSize: limit,
      totalItems,
      totalDistinct,
      totalPages: totalItems === null ? null : Math.ceil(totalItems / limit),
      hasNextPage: totalItems === null ? data.length === limit : offset + limit < totalItems,
      hasPreviousPage: currentPage > 1,
    },
  };
}

module.exports = pagination;
