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
  count = true, countQuery, countParams = params, withSql = '', execute = db.query,
}) {
  const currentPage = positiveInt(page, 1);
  const limit = positiveInt(pageSize, 20, 500);
  const offset = (currentPage - 1) * limit;
  if (!Number.isSafeInteger(offset)) throw new Error('Pagination offset is too large');
  if (typeof query !== 'string' || !query.trim()) throw new Error('SQL query is required');
  if (typeof orderBy !== 'string' || !orderBy.trim()) throw new Error('ORDER BY is required');

  const base = query.trim().replace(/;+\s*$/, '');
  let totals;
  let totalItems = null;
  if (count) {
    const { rows } = await execute(countQuery ??
      `${withSql} SELECT COUNT_BIG(*) AS [totalItems] FROM (${base}) AS pg_source`, countParams);
    totals = rows[0];
    totalItems = Number(totals?.totalItems ?? totals?.total ?? 0);
    if (!Number.isSafeInteger(totalItems)) throw new Error('Total count exceeds safe JS integer range');
  }

  const { rows: data } = totalItems !== null && offset >= totalItems
    ? { rows: [] }
    : await execute(`${withSql}
        SELECT *
        FROM (${base}) AS pg_source
        ORDER BY ${orderBy}
        OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
      `, [...params, offset, limit]);

  return {
    data,
    totals,
    pagination: {
      page: currentPage,
      pageSize: limit,
      totalItems,
      totalPages: totalItems === null ? null : Math.ceil(totalItems / limit),
      hasNextPage: totalItems === null ? data.length === limit : offset + limit < totalItems,
      hasPreviousPage: currentPage > 1,
    },
  };
}

module.exports = pagination;
