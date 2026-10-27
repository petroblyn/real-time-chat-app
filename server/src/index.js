require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const { pool, initDb } = require("./db");
const { signToken, authRequired } = require("./auth");

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  console.error("Missing DATABASE_URL or JWT_SECRET. Copy server/.env.example to server/.env.");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const origin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const io = new Server(server, { cors: { origin, methods: ["GET", "POST"] } });
app.use(cors({ origin }));
app.use(express.json({ limit: "1mb" }));

const uploadDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
app.use("/uploads", express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  }
});
const maxUpload = (Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024;
const upload = multer({
  storage,
  limits: { fileSize: maxUpload },
  fileFilter: (_req, file, cb) => {
    // Block obvious executable/script uploads. Production apps should scan uploads too.
    const blocked = /\.(exe|bat|cmd|com|msi|sh|ps1|js|vbs)$/i.test(file.originalname);
    cb(blocked ? new Error("This file type is not allowed.") : null, !blocked);
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3–30 characters (letters, numbers, underscores)." });
    }
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, hash]
    );
    const user = result.rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That username is already taken." });
    console.error(err);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT id, username, password_hash FROM users WHERE username = $1", [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    res.json({ token: signToken(user), user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.get("/api/users", authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username,
        (SELECT content FROM messages m
         WHERE (m.sender_id = u.id AND m.recipient_id = $1)
            OR (m.sender_id = $1 AND m.recipient_id = u.id)
         ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m
         WHERE (m.sender_id = u.id AND m.recipient_id = $1)
            OR (m.sender_id = $1 AND m.recipient_id = u.id)
         ORDER BY m.created_at DESC LIMIT 1) AS last_message_at
       FROM users u WHERE u.id <> $1 ORDER BY u.username`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load contacts." });
  }
});

app.get("/api/messages/:userId", authRequired, async (req, res) => {
  const otherId = Number(req.params.userId);
  if (!Number.isInteger(otherId) || otherId <= 0) return res.status(400).json({ error: "Invalid user." });
  try {
    const result = await pool.query(
      `SELECT m.id, m.sender_id, m.recipient_id, m.content, m.file_url, m.file_name, m.created_at, m.read_at,
              s.username AS sender_username
       FROM messages m JOIN users s ON s.id = m.sender_id
       WHERE (m.sender_id = $1 AND m.recipient_id = $2)
          OR (m.sender_id = $2 AND m.recipient_id = $1)
       ORDER BY m.created_at ASC LIMIT 500`,
      [req.user.id, otherId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load message history." });
  }
});

app.post("/api/upload", authRequired, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "Choose a file first." });
    res.status(201).json({
      file_url: `/uploads/${encodeURIComponent(req.file.filename)}`,
      file_name: req.file.originalname,
      size: req.file.size
    });
  });
});

const onlineUsers = new Map(); // user id -> Set of socket IDs

function userSockets(id) { return onlineUsers.get(Number(id)) || new Set(); }
function emitPresence() {
  const online = [...onlineUsers.keys()].map(Number);
  io.emit("presence", online);
}
function socketAuth(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) throw new Error("Missing token");
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error("Authentication failed"));
  }
}
io.use(socketAuth);

io.on("connection", (socket) => {
  const userId = Number(socket.user.id);
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);
  emitPresence();

  socket.on("private_message", async (payload, ack) => {
    try {
      const recipientId = Number(payload?.recipient_id);
      const content = String(payload?.content || "").trim();
      const fileUrl = payload?.file_url ? String(payload.file_url) : null;
      const fileName = payload?.file_name ? String(payload.file_name).slice(0, 255) : null;
      if (!Number.isInteger(recipientId) || recipientId <= 0 || recipientId === userId) {
        return ack?.({ error: "Choose a valid recipient." });
      }
      if (!content && !fileUrl) return ack?.({ error: "Message cannot be empty." });
      if (content.length > 5000) return ack?.({ error: "Message is too long (maximum 5000 characters)." });
      if (fileUrl && !fileUrl.startsWith("/uploads/")) return ack?.({ error: "Invalid attachment." });

      const exists = await pool.query("SELECT id FROM users WHERE id = $1", [recipientId]);
      if (!exists.rowCount) return ack?.({ error: "Recipient does not exist." });
      const result = await pool.query(
        `INSERT INTO messages (sender_id, recipient_id, content, file_url, file_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, sender_id, recipient_id, content, file_url, file_name, created_at, read_at`,
        [userId, recipientId, content, fileUrl, fileName]
      );
      const row = result.rows[0];
      const message = { ...row, sender_username: socket.user.username };
      for (const sid of userSockets(recipientId)) io.to(sid).emit("new_message", message);
      for (const sid of userSockets(userId)) io.to(sid).emit("new_message", message);
      ack?.({ message });
    } catch (err) {
      console.error(err);
      ack?.({ error: "Message could not be sent." });
    }
  });

  socket.on("typing", ({ recipient_id } = {}) => {
    for (const sid of userSockets(Number(recipient_id))) io.to(sid).emit("typing", { user_id: userId, username: socket.user.username });
  });
  socket.on("stop_typing", ({ recipient_id } = {}) => {
    for (const sid of userSockets(Number(recipient_id))) io.to(sid).emit("stop_typing", { user_id: userId });
  });

  socket.on("mark_read", async ({ sender_id } = {}) => {
    const senderId = Number(sender_id);
    if (!Number.isInteger(senderId) || senderId <= 0) return;
    try {
      const result = await pool.query(
        `UPDATE messages SET read_at = NOW()
         WHERE sender_id = $1 AND recipient_id = $2 AND read_at IS NULL
         RETURNING id, read_at`,
        [senderId, userId]
      );
      const ids = result.rows.map((r) => Number(r.id));
      for (const sid of userSockets(senderId)) io.to(sid).emit("message_read", { reader_id: userId, message_ids: ids, read_at: new Date().toISOString() });
    } catch (err) { console.error(err); }
  });

  socket.on("disconnect", () => {
    const set = onlineUsers.get(userId);
    if (set) {
      set.delete(socket.id);
      if (!set.size) onlineUsers.delete(userId);
    }
    emitPresence();
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

const port = Number(process.env.PORT) || 4000;
initDb().then(() => {
  server.listen(port, () => console.log(`Chat server listening on http://localhost:${port}`));
}).catch((err) => {
  console.error("Database initialization failed:", err.message);
  process.exit(1);
});
