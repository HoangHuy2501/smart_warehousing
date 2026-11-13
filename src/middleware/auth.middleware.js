/**
 * Middleware xac thuc / phan quyen (auth thuc):
 *   - requireAuth    : doc header x-auth-token, doi thanh session roi gan
 *                      req.actor = { id, empNo, role, name, email }.
 *                      Token thieu / sai -> 401 unauthorized.
 *   - requireManager : chay SAU requireAuth — role khac MANAGER -> 403
 *                      no_permission.
 */

'use strict';

const { ApiError } = require('../util/api-error');
const AuthService = require('../services/auth.service');

function requireAuth(req, res, next) {
  const token = req.get('x-auth-token');
  const session = AuthService.authenticate(token);
  if (!session) {
    return next(new ApiError('unauthorized', 401, 'unauthorized'));
  }
  req.actor = session;
  return next();
}

function requireManager(req, res, next) {
  if (!req.actor || req.actor.role !== 'MANAGER') {
    return next(new ApiError('no_permission', 403, 'no_permission'));
  }
  return next();
}

module.exports = { requireAuth, requireManager };
