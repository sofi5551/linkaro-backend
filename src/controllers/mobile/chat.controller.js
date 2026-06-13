const { ObjectId } = require("mongodb");
const { getDb } = require("../../config/db");
const { isUserOnline } = require("../../sockets");

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const VALID_TYPES = ["text", "image", "location", "voice"];

function sortedParticipants(a, b) {
  return [a, b].sort((x, y) => x.toString().localeCompare(y.toString()));
}

async function touchLastSeen(db, userId) {
  await db
    .collection("users")
    .updateOne({ _id: new ObjectId(userId) }, { $set: { lastSeenAt: new Date() } });
}

async function buildConversationSummary(db, conversation, forUserId) {
  const otherId = conversation.participants
    .find((p) => p.toString() !== forUserId)
    .toString();

  const other = await db
    .collection("users")
    .findOne(
      { _id: new ObjectId(otherId) },
      { projection: { name: 1, profileImage: 1, lastSeenAt: 1 } }
    );

  const lastSeenAt = other?.lastSeenAt ? new Date(other.lastSeenAt).getTime() : 0;

  return {
    conversationId: conversation._id,
    otherUserId: otherId,
    otherUserName: other?.name ?? null,
    otherUserProfileImage: other?.profileImage ?? null,
    isOnline: isUserOnline(otherId) || Date.now() - lastSeenAt <= ONLINE_WINDOW_MS,
    lastMessage: conversation.lastMessage,
    unreadCount: conversation.unreadCount?.[forUserId] ?? 0,
    updatedAt: conversation.updatedAt,
  };
}

async function startConversation(req, res) {
  const { otherUserId, jobId } = req.body;

  if (!otherUserId || !ObjectId.isValid(otherUserId)) {
    return res.status(400).json({ message: "Valid otherUserId is required" });
  }
  if (otherUserId === req.decoded.id) {
    return res.status(400).json({ message: "Cannot start a conversation with yourself" });
  }

  try {
    const db = await getDb();
    const participants = sortedParticipants(
      new ObjectId(req.decoded.id),
      new ObjectId(otherUserId)
    );

    const existing = await db.collection("conversations").findOne({
      participants,
    });

    if (existing) {
      return res.status(200).json({ success: true, conversationId: existing._id });
    }

    const now = new Date();
    const doc = {
      participants,
      jobId: jobId && ObjectId.isValid(jobId) ? new ObjectId(jobId) : null,
      lastMessage: null,
      unreadCount: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("conversations").insertOne(doc);

    return res.status(201).json({ success: true, conversationId: result.insertedId });
  } catch (error) {
    console.error("Start conversation error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function getConversations(req, res) {
  try {
    const db = await getDb();
    const myId = req.decoded.id;

    await touchLastSeen(db, myId);

    const conversations = await db
      .collection("conversations")
      .find({ participants: new ObjectId(myId) })
      .sort({ updatedAt: -1 })
      .toArray();

    const otherIds = [
      ...new Set(
        conversations.map((c) =>
          c.participants.find((p) => p.toString() !== myId).toString()
        )
      ),
    ].map((id) => new ObjectId(id));

    const users = await db
      .collection("users")
      .find({ _id: { $in: otherIds } })
      .project({ name: 1, profileImage: 1, lastSeenAt: 1 })
      .toArray();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const now = Date.now();

    const result = conversations.map((c) => {
      const otherId = c.participants
        .find((p) => p.toString() !== myId)
        .toString();
      const other = userMap.get(otherId);
      const lastSeenAt = other?.lastSeenAt ? new Date(other.lastSeenAt).getTime() : 0;

      return {
        conversationId: c._id,
        otherUserId: otherId,
        otherUserName: other?.name ?? null,
        otherUserProfileImage: other?.profileImage ?? null,
        isOnline: isUserOnline(otherId) || now - lastSeenAt <= ONLINE_WINDOW_MS,
        lastMessage: c.lastMessage,
        unreadCount: c.unreadCount?.[myId] ?? 0,
        updatedAt: c.updatedAt,
      };
    });

    return res.status(200).json({ success: true, conversations: result });
  } catch (error) {
    console.error("Get conversations error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function getMessages(req, res) {
  const { conversationId } = req.params;
  const { before } = req.query;
  const myId = req.decoded.id;

  if (!ObjectId.isValid(conversationId)) {
    return res.status(400).json({ message: "Invalid conversation id" });
  }

  try {
    const db = await getDb();

    const conversation = await db
      .collection("conversations")
      .findOne({ _id: new ObjectId(conversationId) });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    if (!conversation.participants.some((p) => p.toString() === myId)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const limit = Math.min(
      Number(req.query.limit) || DEFAULT_LIMIT,
      MAX_LIMIT
    );

    const query = { conversationId: new ObjectId(conversationId) };
    if (before) {
      const beforeDate = new Date(before);
      if (!isNaN(beforeDate.getTime())) {
        query.createdAt = { $lt: beforeDate };
      }
    }

    const docs = await db
      .collection("messages")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const page = docs.slice(0, limit).reverse();

    await db.collection("conversations").updateOne(
      { _id: new ObjectId(conversationId) },
      { $set: { [`unreadCount.${myId}`]: 0 } }
    );
    await touchLastSeen(db, myId);

    return res.status(200).json({ success: true, messages: page, hasMore });
  } catch (error) {
    console.error("Get messages error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function sendMessage(req, res) {
  const {
    conversationId,
    type,
    text,
    attachmentUrl,
    duration,
    latitude,
    longitude,
    address,
  } = req.body;
  const myId = req.decoded.id;

  if (!conversationId || !ObjectId.isValid(conversationId)) {
    return res.status(400).json({ message: "Valid conversationId is required" });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ message: "Invalid message type" });
  }

  try {
    const db = await getDb();

    const conversation = await db
      .collection("conversations")
      .findOne({ _id: new ObjectId(conversationId) });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    if (!conversation.participants.some((p) => p.toString() === myId)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const now = new Date();

    const messageDoc = {
      conversationId: new ObjectId(conversationId),
      senderId: new ObjectId(myId),
      type,
      text: text ?? null,
      attachmentUrl: attachmentUrl ?? null,
      duration: Number.isFinite(Number(duration)) ? Number(duration) : null,
      latitude: Number.isFinite(Number(latitude)) ? Number(latitude) : null,
      longitude: Number.isFinite(Number(longitude)) ? Number(longitude) : null,
      address: address ?? null,
      createdAt: now,
    };

    const result = await db.collection("messages").insertOne(messageDoc);

    const otherId = conversation.participants
      .find((p) => p.toString() !== myId)
      .toString();

    let previewText = text ?? null;
    if (type === "image") previewText = "Photo";
    else if (type === "location") previewText = "Location";
    else if (type === "voice") previewText = "Voice message";

    await db.collection("conversations").updateOne(
      { _id: new ObjectId(conversationId) },
      {
        $set: {
          lastMessage: { type, text: previewText, createdAt: now },
          updatedAt: now,
        },
        $inc: { [`unreadCount.${otherId}`]: 1 },
      }
    );

    await touchLastSeen(db, myId);

    const savedMessage = { ...messageDoc, _id: result.insertedId };

    const io = req.app.get("io");
    if (io) {
      io.to(`conv:${conversationId}`).emit("new_message", {
        conversationId,
        message: savedMessage,
      });

      const updatedConversation = await db
        .collection("conversations")
        .findOne({ _id: new ObjectId(conversationId) });

      for (const participantId of [myId, otherId]) {
        const summary = await buildConversationSummary(
          db,
          updatedConversation,
          participantId
        );
        io.to(`user:${participantId}`).emit("conversation_update", summary);
      }
    }

    return res.status(201).json({ success: true, message: savedMessage });
  } catch (error) {
    console.error("Send message error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

module.exports = {
  startConversation,
  getConversations,
  getMessages,
  sendMessage,
};
