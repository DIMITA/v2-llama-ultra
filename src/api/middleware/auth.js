'use strict';

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';

function signToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

function authMiddleware(opts = {}) {
  const { optional = false } = opts;

  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      if (optional) { req.user = null; return next(); }
      return res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
    }

    try {
      req.user = verifyToken(token);
      next();
    } catch (err) {
      return res.status(401).json({ error: 'token_invalid', message: err.message });
    }
  };
}

module.exports = { signToken, verifyToken, authMiddleware };
