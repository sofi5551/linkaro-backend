const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const env = require("../config/env");
const { getDb } = require("../config/db");

// userId -> Set of socket ids (tracks online users for this server instance)
const onlineUsers = new Map();

function isUserOnline(userId) {
  return onlineUsers.has(userId.toString());
}

async function broadcastPresence(io, db, userId, isOnline) {
  const conversations = await db
    .collection("conversations")
    .find({ participants: new ObjectId(userId) })
    .project({ participants: 1 })
    .toArray();

  const otherIds = new Set();
  conversations.forEach((c) => {
    c.participants.forEach((p) => {
      if (p.toString() !== userId) otherIds.add(p.toString());
    });
  });

  otherIds.forEach((id) => {
    io.to(`user:${id}`).emit("presence", { userId, isOnline });
  });
}

function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error("Authentication required"));
    try {
      const decoded = jwt.verify(token, env.secretKey);
      socket.userId = decoded.id;
      return next();
    } catch {
      return next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.userId;
    socket.join(`user:${userId}`);

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    const sockets = onlineUsers.get(userId);
    const wasOffline = sockets.size === 0;
    sockets.add(socket.id);

    const db = await getDb();
    await db
      .collection("users")
      .updateOne({ _id: new ObjectId(userId) }, { $set: { lastSeenAt: new Date() } });

    if (wasOffline) {
      await broadcastPresence(io, db, userId, true);
    }

    socket.on("join_conversation", async ({ conversationId } = {}) => {
      if (!conversationId || !ObjectId.isValid(conversationId)) return;
      const conversation = await db
        .collection("conversations")
        .findOne({ _id: new ObjectId(conversationId) });
      if (!conversation) return;
      if (!conversation.participants.some((p) => p.toString() === userId)) return;
      socket.join(`conv:${conversationId}`);
    });

    socket.on("leave_conversation", ({ conversationId } = {}) => {
      if (!conversationId) return;
      socket.leave(`conv:${conversationId}`);
    });

    socket.on("typing", ({ conversationId, isTyping } = {}) => {
      if (!conversationId || !ObjectId.isValid(conversationId)) return;
      socket.to(`conv:${conversationId}`).emit("typing", {
        conversationId,
        userId,
        isTyping: !!isTyping,
      });
    });

    socket.on("mark_read", async ({ conversationId } = {}) => {
      if (!conversationId || !ObjectId.isValid(conversationId)) return;
      await db.collection("conversations").updateOne(
        { _id: new ObjectId(conversationId) },
        { $set: { [`unreadCount.${userId}`]: 0 } }
      );
    });

    socket.on("disconnect", async () => {
      const set = onlineUsers.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(userId);
        await db
          .collection("users")
          .updateOne({ _id: new ObjectId(userId) }, { $set: { lastSeenAt: new Date() } });
        await broadcastPresence(io, db, userId, false);
      }
    });
  });

  return io;
}

module.exports = { initSocket, isUserOnline };
