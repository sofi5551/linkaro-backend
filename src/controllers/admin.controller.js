const { ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const { getDb } = require("../config/db");
const env = require("../config/env");
const {
  sendEmail,
  registrationVerifiedEmail,
  registrationUnverifiedEmail,
  subscriptionStatusEmail,
} = require("../lib/mailer");
const { createNotification } = require("../lib/notifications");
const { uploadToCloudinary } = require("../lib/cloudinary");
const { geocodeAddressPakistan } = require("../lib/geocoding");

const BLOCKED_USER_FIELDS = [
  "password", "role", "subscriptionStatus", "badgeSubscriptionStatus",
  "totalJobs", "_id", "emailVerified", "provider", "providerId", "createdAt",
];

async function checkExpiredSubscriptions(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${env.cronSecret}`) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const db = await getDb();
    const now = new Date();

    // Only each user's latest subscription per type matters — an old,
    // already-superseded subscription's stale expiry date must never flip
    // a current renewal back to inactive.
    const latestSubs = await db
      .collection("subscriptions")
      .aggregate([
        { $sort: { subscriptionDate: -1 } },
        {
          $group: {
            _id: { userId: "$userId", subscriptionType: "$subscriptionType" },
            doc: { $first: "$$ROOT" },
          },
        },
        { $replaceRoot: { newRoot: "$doc" } },
      ])
      .toArray();

    const expired = latestSubs.filter(
      (sub) => sub.subscriptionEndDate && sub.subscriptionEndDate < now
    );

    if (expired.length === 0) {
      return res.status(200).json({ success: true, updated: 0 });
    }

    let updated = 0;

    for (const sub of expired) {
      const isBadge = (sub.subscriptionType || "").toLowerCase().includes("badge");
      const userField = isBadge ? "badgeSubscriptionStatus" : "subscriptionStatus";

      const result = await db.collection("users").updateOne(
        {
          _id: sub.userId,
          [userField]: { $nin: ["inactive", "fraud"] },
        },
        { $set: { [userField]: "inactive" } }
      );

      if (result.modifiedCount > 0) updated++;
    }

    return res.status(200).json({ success: true, updated });
  } catch (error) {
    console.error("Check expired subscriptions error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function deleteUser(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ message: "id is required" });
  }

  try {
    const db = await getDb();

    await db.collection("users").deleteOne({ _id: new ObjectId(id) });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Delete user error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function getJobs(req, res) {
  try {
    const db = await getDb();

    const jobs = await db
      .collection("jobs")
      .aggregate([
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "consumer",
          },
        },
        {
          $unwind: {
            path: "$consumer",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "assignedProviderId",
            foreignField: "_id",
            as: "provider",
          },
        },
        {
          $unwind: {
            path: "$provider",
            preserveNullAndEmptyArrays: true,
          },
        },
        { $sort: { createdAt: -1 } },
      ])
      .toArray();

    return res.status(200).json({ success: true, jobs });
  } catch (error) {
    console.error("Get jobs error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function uploadImage(req, res) {
  const { image, folder } = req.body;

  if (!image) {
    return res.status(400).json({ message: "image is required" });
  }

  try {
    const url = await uploadToCloudinary(image, folder || "tickets");
    return res.status(200).json({ success: true, url });
  } catch (error) {
    console.error("Upload image error:", error);
    return res.status(500).json({ message: "Image upload failed" });
  }
}

const TICKET_STATUSES = ["ongoing", "pending", "completed"];

async function getTickets(req, res) {
  try {
    const db = await getDb();

    const tickets = await db
      .collection("tickets")
      .aggregate([
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "consumer",
          },
        },
        {
          $unwind: {
            path: "$consumer",
            preserveNullAndEmptyArrays: true,
          },
        },
        { $sort: { createdAt: -1 } },
      ])
      .toArray();

    return res.status(200).json({ success: true, tickets });
  } catch (error) {
    console.error("Get tickets error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function updateTicket(req, res) {
  const { id, status, solution, solutionImages } = req.body;

  if (!id || !ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Valid ticket id is required" });
  }
  if (status && !TICKET_STATUSES.includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  try {
    const db = await getDb();

    const update = {};
    if (status) update.status = status;
    if (solution !== undefined) update.solution = solution;
    if (solutionImages !== undefined) update.solutionImages = solutionImages;

    await db.collection("tickets").updateOne({ _id: new ObjectId(id) }, { $set: update });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Update ticket error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

const NOTIFICATION_AUDIENCES = ["all", "consumer", "provider"];

async function sendNotification(req, res) {
  const { message, audience } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ message: "Message is required" });
  }
  if (!NOTIFICATION_AUDIENCES.includes(audience)) {
    return res.status(400).json({ message: "Invalid audience" });
  }

  try {
    const db = await getDb();

    const query = audience === "all" ? { role: { $in: ["consumer", "provider"] } } : { role: audience };
    const recipients = await db.collection("users").find(query).project({ _id: 1 }).toArray();

    if (recipients.length === 0) {
      return res.status(200).json({ success: true, sent: 0 });
    }

    const io = req.app.get("io");
    const trimmedMessage = message.trim();

    await Promise.all(
      recipients.map((u) =>
        createNotification({
          userId: u._id,
          type: "admin_announcement",
          message: trimmedMessage,
          io,
        })
      )
    );

    return res.status(200).json({ success: true, sent: recipients.length });
  } catch (error) {
    console.error("Send notification error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function deleteJob(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ message: "id is required" });
  }

  try {
    const db = await getDb();

    await db.collection("jobs").deleteOne({ _id: new ObjectId(id) });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Delete job error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function getProviders(req, res) {
  try {
    const db = await getDb();

    const providers = await db
      .collection("users")
      .find({
        role: "provider",
        subscriptionStatus: { $ne: "inactive" },
        badgeSubscriptionStatus: { $ne: "inactive" },
      })
      .sort({ subscriptionDate: -1 })
      .project({
        // ── Only remove sensitive fields ──
        password: 0,
        cnicFrontImage: 0,
        cnicBackImage: 0,
      })
      .toArray();

    return res.status(200).json({
      success: true,
      count: providers.length,
      providers,
    });
  } catch (error) {
    console.error("Get providers error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function getSubscription(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ message: "Subscription ID is required" });
  }

  try {
    const db = await getDb();

    const results = await db
      .collection("subscriptions")
      .aggregate([
        { $match: { _id: new ObjectId(id) } },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            subscriptionType: 1,
            subscriptionDate: 1,
            amountPaid: 1,
            paymentOption: 1,
            receiptImage: 1,
            createdAt: 1,
            "user.name": 1,
            "user.email": 1,
            "user.phone": 1,
            "user.category": 1,
            "user.gender": 1,
            "user.address": 1,
            "user.cnic": 1,
            "user.profileImage": 1,
            "user.cnicFrontImage": 1,
            "user.cnicBackImage": 1,
            "user.role": 1,
            "user.totalJobs": 1,
            "user.subscriptionStatus": 1,
            "user.badgeSubscriptionStatus": 1,
          },
        },
      ])
      .toArray();

    if (!results.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    return res.status(200).json({ success: true, subscription: results[0] });
  } catch (error) {
    console.error("Get subscription error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function getSubscriptions(req, res) {
  try {
    const db = await getDb();

    const subscriptions = await db
      .collection("subscriptions")
      .aggregate([
        // Collapse renewals down to each user's latest submission per
        // subscription type — that's the only row whose status still
        // governs the user's live subscriptionStatus/badgeSubscriptionStatus,
        // and the only one admin should be acting on from this table.
        { $sort: { subscriptionDate: -1 } },
        {
          $group: {
            _id: { userId: "$userId", subscriptionType: "$subscriptionType" },
            doc: { $first: "$$ROOT" },
          },
        },
        { $replaceRoot: { newRoot: "$doc" } },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            plan: 1,
            subscriptionType: 1,
            subscriptionDate: 1,
            subscriptionEndDate: 1,
            amountPaid: 1,
            paymentMethod: 1,
            dateSubmitted: 1,
            status: 1,

            priority: 1,
            createdAt: 1,
            "user.name": 1,
            "user.email": 1,
            "user.phone": 1,
            "user.category": 1,
            "user.gender": 1,
            "user.address": 1,
            "user.cnic": 1,
            "user.role": 1,
            "user.totalJobs": 1,
            "user.subscriptionStatus": 1,
            "user.badgeSubscriptionStatus": 1,
          },
        },
        { $sort: { subscriptionDate: -1 } },
      ])
      .toArray();

    return res.status(200).json({
      success: true,
      count: subscriptions.length,
      subscriptions,
    });
  } catch (error) {
    console.error("Get subscriptions error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function getUser(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ message: "id is required" });

  try {
    const db = await getDb();

    const user = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(id) },
        { projection: { password: 0 } }
      );

    if (!user) return res.status(404).json({ message: "User not found" });

    return res.status(200).json({ success: true, user });
  } catch (error) {
    console.error("Get user error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function getUsers(req, res) {
  try {
    const db = await getDb();

    const users = await db
      .collection("users")
      .find({ role: { $in: ["consumer", "provider"] } })
      .project({ password: 0, cnicFrontImage: 0, cnicBackImage: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const revenueAgg = await db
      .collection("subscriptions")
      .aggregate([
        { $match: { createdAt: { $gte: monthStart }, amountPaid: { $type: "number" } } },
        { $group: { _id: null, total: { $sum: "$amountPaid" } } },
      ])
      .toArray();

    const monthlyRevenue = revenueAgg[0]?.total || 0;
    const serviceProviders = users.filter((u) => u.role === "provider").length;
    const consumers = users.filter((u) => u.role === "consumer").length;

    return res.status(200).json({
      success: true,
      users,
      stats: {
        totalUsers: users.length,
        serviceProviders,
        consumers,
        monthlyRevenue,
      },
    });
  } catch (error) {
    console.error("Get users error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function updateSubscriptionStatus(req, res) {
  const { id, status } = req.body;

  if (!id || !status) {
    return res.status(400).json({ message: "id and status are required" });
  }

  const VALID = ["active", "rejected", "fraud"];
  if (!VALID.includes(status)) {
    return res.status(400).json({ message: "Invalid status value" });
  }

  try {
    const db = await getDb();

    const subscription = await db
      .collection("subscriptions")
      .findOne({ _id: new ObjectId(id) });

    if (!subscription) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const isBadge = (subscription.subscriptionType || "")
      .toLowerCase()
      .includes("badge");
    const userStatusField = isBadge
      ? "badgeSubscriptionStatus"
      : "subscriptionStatus";

    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(subscription.userId) });

    await db
      .collection("users")
      .updateOne(
        { _id: new ObjectId(subscription.userId) },
        { $set: { [userStatusField]: status } },
      );

    // The 1-month cycle starts when the subscription is actually approved,
    // not when the user submitted it — otherwise a delayed review eats into
    // the month they paid for.
    if (status === "active") {
      const subscriptionDate = new Date();
      const subscriptionEndDate = new Date(subscriptionDate);
      subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);

      await db
        .collection("subscriptions")
        .updateOne(
          { _id: subscription._id },
          { $set: { subscriptionDate, subscriptionEndDate } },
        );
    }

    // Send email notification
    if (user?.email) {
      const subjects = {
        active: "Your Linkaro subscription has been approved",
        rejected: "Your Linkaro subscription was not approved",
        fraud: "Important notice about your Linkaro subscription",
      };
      const html = subscriptionStatusEmail(
        user.name || "there",
        status,
        subscription.subscriptionType
      );
      sendEmail({ to: user.email, subject: subjects[status], html }).catch((err) =>
        console.error("Email send error:", err)
      );
    }

    if (user) {
      const messages = {
        active: "Your subscription has been approved and activated.",
        rejected: "Your subscription request has been rejected.",
        fraud: "Your subscription has been flagged for review.",
      };
      createNotification({
        userId: user._id,
        type: "subscription_status",
        message: messages[status],
        io: req.app.get("io"),
      }).catch((err) => console.error("Notification create error:", err));
    }

    return res.status(200).json({ success: true, status });
  } catch (error) {
    console.error("Update subscription status error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function updateUser(req, res) {
  const { id, ...fields } = req.body;
  if (!id) return res.status(400).json({ message: "id is required" });

  try {
    const db = await getDb();

    const user = await db.collection("users").findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ message: "User not found" });

    const update = {};

    if (fields.name)   update.name   = fields.name;
    if (fields.gender) update.gender = fields.gender;
    if (fields.cnic)   update.cnic   = fields.cnic;

    if (fields.phone) {
      update.phone = fields.phone.startsWith("+92") ? fields.phone : `+92${fields.phone}`;
    }

    if (fields.street || fields.city || fields.zip) {
      const existing = user.address || {};
      update.address = {
        street: fields.street ?? existing.street ?? "",
        city:   fields.city   ?? existing.city   ?? "",
        zip:    fields.zip    ?? existing.zip    ?? "",
      };
    }

    if (fields.profileImage) update.profileImage = fields.profileImage;
    if (fields.registrationStatus !== undefined && fields.registrationStatus !== null) update.registrationStatus = fields.registrationStatus;

    if (user.role === "provider") {
      if (fields.category)       update.category       = fields.category;
      if (fields.cnicFrontImage) update.cnicFrontImage = fields.cnicFrontImage;
      if (fields.cnicBackImage)  update.cnicBackImage  = fields.cnicBackImage;
      if (typeof fields.about === "string") update.about = fields.about.trim();

      // Re-derive the coordinates from the new address — same approach the
      // mobile app's edit-profile screen uses (geocode street+city, keep
      // the result only if it lands inside Pakistan). Coordinates are never
      // accepted directly from the request.
      if (update.address?.street && update.address?.city) {
        try {
          const coords = await geocodeAddressPakistan(update.address.street, update.address.city);
          if (coords) {
            update.latitude = coords.latitude;
            update.longitude = coords.longitude;
            update.geo = { type: "Point", coordinates: [coords.longitude, coords.latitude] };
          } else {
            console.warn(
              `Geocoding returned no usable result for "${update.address.street}, ${update.address.city}" (user ${id})`
            );
          }
        } catch (geoError) {
          console.error("Geocoding error:", geoError);
        }
      } else if (fields.street || fields.city) {
        console.warn(
          `Skipped geocoding for user ${id} — street and city are both required (got street="${update.address?.street}", city="${update.address?.city}")`
        );
      }
    }

    // Remove any blocked fields that may have slipped through
    BLOCKED_USER_FIELDS.forEach((k) => delete update[k]);

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    update.updatedAt = new Date();

    const prevStatus = user.registrationStatus;
    await db.collection("users").updateOne({ _id: new ObjectId(id) }, { $set: update });

    // Send email if registrationStatus changed
    if (
      "registrationStatus" in update &&
      update.registrationStatus !== prevStatus &&
      user.email
    ) {
      const name = update.name || user.name || "there";
      const html = update.registrationStatus === true
        ? registrationVerifiedEmail(name)
        : registrationUnverifiedEmail(name);
      const subject = update.registrationStatus === true
        ? "Your Linkaro account has been verified"
        : "Your Linkaro verification has been revoked";
      sendEmail({ to: user.email, subject, html }).catch((err) =>
        console.error("Email send error:", err)
      );

      createNotification({
        userId: user._id,
        type: "id_approved",
        message: update.registrationStatus === true
          ? "Your ID has been approved!"
          : "Your ID verification has been revoked.",
        io: req.app.get("io"),
      }).catch((err) => console.error("Notification create error:", err));
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Update user error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

const MANAGER_ROLES = ["admin", "user manager", "ticket manager"];

// Manager accounts (admin / user manager / ticket manager) live in the same
// "users" collection as consumers/providers, distinguished by role — that's
// already how login resolves them (auth.controller.js's ROLE_ROUTES).
// Only an actual admin may view or manage these accounts.
function requireAdminRole(req, res) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return false;
  }
  return true;
}

async function getManagers(req, res) {
  if (!requireAdminRole(req, res)) return;

  try {
    const db = await getDb();

    const managers = await db
      .collection("users")
      .find({ role: { $in: MANAGER_ROLES } })
      .project({ password: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    const stats = {
      total: managers.length,
      admin: managers.filter((m) => m.role === "admin").length,
      userManager: managers.filter((m) => m.role === "user manager").length,
      ticketManager: managers.filter((m) => m.role === "ticket manager").length,
    };

    return res.status(200).json({ success: true, managers, stats });
  } catch (error) {
    console.error("Get managers error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function createManager(req, res) {
  if (!requireAdminRole(req, res)) return;

  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ message: "Name, email, password and role are required" });
  }
  if (!MANAGER_ROLES.includes(role)) {
    return res.status(400).json({ message: "Invalid role" });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  try {
    const db = await getDb();
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db.collection("users").findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await db.collection("users").insertOne({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role,
      createdAt: new Date(),
    });

    return res.status(201).json({ success: true, id: result.insertedId });
  } catch (error) {
    console.error("Create manager error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function updateManager(req, res) {
  if (!requireAdminRole(req, res)) return;

  const { id, name, email, role, password } = req.body;

  if (!id) return res.status(400).json({ message: "id is required" });
  if (role && !MANAGER_ROLES.includes(role)) {
    return res.status(400).json({ message: "Invalid role" });
  }
  if (password && password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  try {
    const db = await getDb();

    const manager = await db.collection("users").findOne({ _id: new ObjectId(id) });
    if (!manager || !MANAGER_ROLES.includes(manager.role)) {
      return res.status(404).json({ message: "Manager not found" });
    }

    const update = {};
    if (name) update.name = name.trim();
    if (role) update.role = role;

    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      if (normalizedEmail !== manager.email) {
        const existing = await db
          .collection("users")
          .findOne({ email: normalizedEmail, _id: { $ne: manager._id } });
        if (existing) {
          return res.status(409).json({ message: "Email is already registered" });
        }
      }
      update.email = normalizedEmail;
    }

    if (password) {
      update.password = await bcrypt.hash(password, 10);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    await db.collection("users").updateOne({ _id: manager._id }, { $set: update });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Update manager error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function deleteManager(req, res) {
  if (!requireAdminRole(req, res)) return;

  const { id } = req.query;
  if (!id) return res.status(400).json({ message: "id is required" });

  try {
    const db = await getDb();

    const manager = await db.collection("users").findOne({ _id: new ObjectId(id) });
    if (!manager || !MANAGER_ROLES.includes(manager.role)) {
      return res.status(404).json({ message: "Manager not found" });
    }

    await db.collection("users").deleteOne({ _id: manager._id });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Delete manager error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

module.exports = {
  checkExpiredSubscriptions,
  createManager,
  deleteJob,
  deleteManager,
  deleteUser,
  getJobs,
  getManagers,
  getProviders,
  getSubscription,
  getSubscriptions,
  getTickets,
  getUser,
  getUsers,
  sendNotification,
  updateManager,
  updateSubscriptionStatus,
  updateTicket,
  updateUser,
  uploadImage,
};
