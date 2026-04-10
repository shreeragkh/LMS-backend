const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
  const authHeader = req.header("Authorization");
  const bearerToken = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;
  const token = req.cookies?.token || bearerToken;

  if (!token) {
    return res.status(401).json("No token");
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    return res.status(401).json("Token expired or invalid");
  }
};