const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e8, // 100MB for large file uploads
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // This serves your HTML file!
app.use("/uploads", express.static("uploads"));

// Create uploads directory if it doesn't exist
const uploadsDir = "./uploads";
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes =
      /jpeg|jpg|png|gif|mp4|mov|avi|mp3|wav|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  },
});

// Store connected users and rooms
let users = new Map();
let rooms = new Map();

// Basic route - serves index.html from public folder
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// File upload endpoint
app.post("/upload", upload.single("media"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileInfo = {
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      url: `/uploads/${req.file.filename}`,
    };

    res.json({
      success: true,
      file: fileInfo,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("join", (userData) => {
    users.set(socket.id, {
      id: socket.id,
      username: userData.username,
      room: userData.room || "general",
    });

    const user = users.get(socket.id);
    socket.join(user.room);

    if (!rooms.has(user.room)) {
      rooms.set(user.room, new Set());
    }
    rooms.get(user.room).add(socket.id);

    socket.to(user.room).emit("user-joined", {
      username: user.username,
      message: `${user.username} joined the chat`,
      timestamp: new Date().toISOString(),
    });

    const roomUsers = Array.from(rooms.get(user.room))
      .map((id) => users.get(id))
      .filter(Boolean);

    socket.emit("room-users", roomUsers);
    console.log(`${user.username} joined room: ${user.room}`);
  });

  socket.on("send-message", (messageData) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message = {
      id: Date.now() + Math.random(),
      username: user.username,
      text: messageData.text,
      type: "text",
      timestamp: new Date().toISOString(),
      room: user.room,
    };

    io.to(user.room).emit("new-message", message);
    console.log(`Message in ${user.room}:`, message.text);
  });

  socket.on("send-media", (mediaData) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message = {
      id: Date.now() + Math.random(),
      username: user.username,
      type: "media",
      media: {
        url: mediaData.url,
        filename: mediaData.filename,
        originalname: mediaData.originalname,
        mimetype: mediaData.mimetype,
        size: mediaData.size,
      },
      caption: mediaData.caption || "",
      timestamp: new Date().toISOString(),
      room: user.room,
    };

    io.to(user.room).emit("new-message", message);
    console.log(`Media shared in ${user.room}:`, message.media.originalname);
  });

  socket.on("typing", () => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.room).emit("user-typing", {
        username: user.username,
      });
    }
  });

  socket.on("stop-typing", () => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.room).emit("user-stopped-typing", {
        username: user.username,
      });
    }
  });

  socket.on("switch-room", (newRoom) => {
    const user = users.get(socket.id);
    if (!user) return;

    const oldRoom = user.room;

    socket.leave(oldRoom);
    rooms.get(oldRoom)?.delete(socket.id);

    user.room = newRoom;
    socket.join(newRoom);

    if (!rooms.has(newRoom)) {
      rooms.set(newRoom, new Set());
    }
    rooms.get(newRoom).add(socket.id);

    socket.to(oldRoom).emit("user-left", {
      username: user.username,
      message: `${user.username} left the chat`,
    });

    socket.to(newRoom).emit("user-joined", {
      username: user.username,
      message: `${user.username} joined the chat`,
    });

    const roomUsers = Array.from(rooms.get(newRoom))
      .map((id) => users.get(id))
      .filter(Boolean);

    socket.emit("room-users", roomUsers);
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (user) {
      rooms.get(user.room)?.delete(socket.id);

      socket.to(user.room).emit("user-left", {
        username: user.username,
        message: `${user.username} left the chat`,
        timestamp: new Date().toISOString(),
      });

      users.delete(socket.id);
      console.log(`${user.username} disconnected`);
    }
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Upload directory: ${path.resolve(uploadsDir)}`);
  console.log(`🌐 Open your browser to http://localhost:${PORT}`);
});
