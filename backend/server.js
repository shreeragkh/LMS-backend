const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();
const cookieParser = require("cookie-parser");
const auth = require("./middleware/auth");
const app = express();

const devOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175"
];

const envOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...devOrigins, ...envOrigins])];

app.use(cookieParser());
app.use(cors({
  origin(origin, callback) {
    // Allow same-origin, server-to-server, and configured browser origins.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("CORS origin not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log("MongoDB Connected"));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/materials", require("./routes/materials"));
app.use("/api/quizzes", require("./routes/quizzes"));
app.use("/api/chat", require("./routes/chat"));
app.get("/api/protected", auth, (req, res) => {
  res.json({ msg: "Protected data", user: req.user });
});

app.listen(5000, () => console.log("Server running on 5000"));