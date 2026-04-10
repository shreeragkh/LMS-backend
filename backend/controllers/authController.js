const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// REGISTER
exports.register = async (req, res) => {
  const { name, email, password, role } = req.body;

  try {
    const exist = await User.findOne({ email });
    if (exist) return res.status(400).json("User already exists");

    const hash = await bcrypt.hash(password, 10);

    const normalizedRole = (role || "student").toLowerCase();
    if (!["student", "faculty", "admin"].includes(normalizedRole)) {
      return res.status(400).json("Invalid role");
    }
    const user = new User({ name, email, password: hash, role: normalizedRole });
    await user.save();

    res.json({
      msg: "Registered successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json(err);
  }
};

// LOGIN
exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json("User not found");

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json("Wrong password");

    const userRole = user.role || "student";
    if (!user.role) {
      user.role = userRole;
      await user.save();
    }

    const token = jwt.sign(
      { id: user._id, name: user.name, role: userRole },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 🍪 Set HTTP-only cookie
    res.cookie("token", token, {
      httpOnly: true,
      secure: false, // true in production
      sameSite: "lax",
      maxAge: 60 * 60 * 1000
    });

    res.json({
      msg: "Login success",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: userRole
      }
    });

  } catch (err) {
    res.status(500).json(err);
  }
};

// LOGOUT
exports.logout = (req, res) => {
  res.clearCookie("token");
  res.json("Logged out");
};