const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");
const { getDb } = require("../../config/db");
const env = require("../../config/env");
const { VALID_CATEGORIES } = require("../../constants/categories");
const { isUserOnline } = require("../../sockets");
const { deleteManyFromCloudinary } = require("../../lib/cloudinary");

const ONLINE_WINDOW_MS = 2 * 60 * 1000;

function withOnlineStatus(user) {
  const { lastSeenAt, ...rest } = user;
  const lastSeen = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
  return {
    ...rest,
    isOnline:
      isUserOnline(user._id.toString()) ||
      Date.now() - lastSeen <= ONLINE_WINDOW_MS,
  };
}

async function me(req, res) {
  try {
    const db = await getDb();

    const user = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(req.decoded.id) },
        { projection: { password: 0 } }
      );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({ success: true, user });
  } catch (error) {
    console.error("Get user error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

// Providers within `radius` km of the consumer's current coordinates,
// ranked by rating, then verified badge, then jobs completed — distance is
// only used as the search cutoff, not for ordering.
async function listProviders(req, res) {
  try {
    const db = await getDb();

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(200).json({
        success: true,
        needsLocation: true,
        providers: [],
      });
    }

    const radiusKm = Number(req.query.radius) || 10;

    const providers = await db
      .collection("users")
      .aggregate([
        {
          $geoNear: {
            near: { type: "Point", coordinates: [lng, lat] },
            distanceField: "distanceMeters",
            maxDistance: radiusKm * 1000,
            spherical: true,
            query: {
              role: "provider",
              registrationStatus: true,
              subscriptionStatus: "active",
            },
          },
        },
        {
          $addFields: {
            isVerified: {
              $cond: [{ $eq: ["$badgeSubscriptionStatus", "active"] }, 1, 0],
            },
            sortRating: { $ifNull: ["$rating", 0] },
            sortJobsCompleted: { $ifNull: ["$jobsCompleted", 0] },
          },
        },
        {
          $sort: {
            sortRating: -1,
            isVerified: -1,
            sortJobsCompleted: -1,
          },
        },
        {
          $project: {
            name: 1,
            profileImage: 1,
            category: 1,
            address: 1,
            badgeSubscriptionStatus: 1,
            rating: 1,
            jobsCompleted: 1,
            phone: 1,
            lastSeenAt: 1,
            distanceKm: { $divide: ["$distanceMeters", 1000] },
          },
        },
      ])
      .toArray();

    return res.status(200).json({
      success: true,
      needsLocation: false,
      providers: providers.map(withOnlineStatus),
    });
  } catch (error) {
    console.error("List providers error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function providerDetail(req, res) {
  try {
    const db = await getDb();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid provider id" });
    }

    const provider = await db.collection("users").findOne(
      { _id: new ObjectId(id), role: "provider" },
      {
        projection: {
          name: 1,
          profileImage: 1,
          category: 1,
          about: 1,
          address: 1,
          badgeSubscriptionStatus: 1,
          rating: 1,
          jobsCompleted: 1,
          phone: 1,
          lastSeenAt: 1,
        },
      }
    );

    if (!provider) {
      return res.status(404).json({ message: "Provider not found" });
    }

    const services = await db
      .collection("providerServices")
      .find({ providerId: new ObjectId(id) })
      .sort({ createdAt: -1 })
      .toArray();

    const reviewedJobs = await db
      .collection("jobs")
      .find({
        assignedProviderId: new ObjectId(id),
        status: "completed",
        review: { $exists: true, $ne: "" },
      })
      .sort({ completedAt: -1 })
      .project({ rating: 1, review: 1, completedAt: 1, userId: 1 })
      .toArray();

    const consumerIds = [
      ...new Set(reviewedJobs.map((job) => job.userId.toString())),
    ].map((consumerId) => new ObjectId(consumerId));

    const consumers = await db
      .collection("users")
      .find({ _id: { $in: consumerIds } })
      .project({ name: 1, profileImage: 1 })
      .toArray();
    const consumerMap = new Map(consumers.map((c) => [c._id.toString(), c]));

    const reviews = reviewedJobs.map((job) => {
      const consumer = consumerMap.get(job.userId.toString());
      return {
        rating: job.rating ?? 0,
        review: job.review ?? "",
        completedAt: job.completedAt,
        consumerName: consumer?.name ?? null,
        consumerProfileImage: consumer?.profileImage ?? null,
      };
    });

    return res.status(200).json({
      success: true,
      provider: withOnlineStatus(provider),
      services,
      reviews,
    });
  } catch (error) {
    console.error("Get provider detail error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function profileImage(req, res) {
  const { id, token } = req.query;

  if (!id || !token) {
    return res.status(400).json({ message: "User ID and token are required" });
  }

  // Verify token
  let decoded;
  try {
    decoded = jwt.verify(token, env.secretKey);
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  // Token must belong to the requested user
  if (decoded.id !== id) {
    return res.status(403).json({ message: "Access denied" });
  }

  try {
    const db = await getDb();

    const user = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(id) },
        {
          projection: {
            profileImage: 1,
            totalJobs: 1,
            jobsCompleted: 1,
            name: 1,
            email: 1,
          },
        }
      );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      name: user.name || null,
      email: user.email || null,
      profileImage: user.profileImage || null,
      totalJobs: user.totalJobs ?? 0,
      jobsCompleted: user.jobsCompleted ?? 0,
    });
  } catch (error) {
    console.error("Profile image error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function subscription(req, res) {
  const { subscriptionType, paymentOption, amountPaid, receiptImage } = req.body;

  if (!subscriptionType) {
    return res.status(400).json({ message: "subscriptionType is required" });
  }

  if (!paymentOption) {
    return res.status(400).json({ message: "paymentOption is required" });
  }

  if (!amountPaid) {
    return res.status(400).json({ message: "amountPaid is required" });
  }

  if (!receiptImage) {
    return res.status(400).json({ message: "receiptImage is required" });
  }

  try {
    const db = await getDb();

    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(req.decoded.id) });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const subscriptionDate = new Date();

    const subscriptionEndDate = new Date(subscriptionDate);
    subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);

    await db.collection("subscriptions").insertOne({
      userId: new ObjectId(req.decoded.id),
      subscriptionType,
      paymentOption,
      amountPaid,
      subscriptionDate,
      subscriptionEndDate,
      receiptImage,
    });

    return res.status(201).json({
      success: true,
      message: "Subscription created successfully",
      data: {
        userId: req.decoded.id,
        subscriptionType,
        paymentOption,
        amountPaid,
        subscriptionDate,
        subscriptionEndDate,
        receiptImage,
      },
    });
  } catch (error) {
    console.error("Subscription error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function updateBadgeSubscription(req, res) {
  const { badgeSubscriptionStatus } = req.body;

  if (badgeSubscriptionStatus === undefined || badgeSubscriptionStatus === null) {
    return res.status(400).json({ message: "badgeSubscriptionStatus is required" });
  }

  try {
    const db = await getDb();

    await db
      .collection("users")
      .updateOne(
        { _id: new ObjectId(req.decoded.id) },
        {
          $set: {
            badgeSubscriptionStatus,
            subscriptionDate: new Date(),
            updatedAt: new Date(),
          },
        },
      );

    return res.status(200).json({ success: true, message: "Badge subscription status updated" });
  } catch (error) {
    console.error("Update badge subscription error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function updateProfile(req, res) {
  const { token, ...fields } = req.body;

  try {
    const db = await getDb();

    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(req.decoded.id) });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Build update object based on role
    const update = {};

    if (fields.name) update.name = fields.name;
    if (fields.cnic) update.cnic = fields.cnic;
    if (fields.gender) update.gender = fields.gender;
    if (fields.profileImage) update.profileImage = fields.profileImage;

    // Phone — store with +92 prefix
    if (fields.phone) {
      update.phone = fields.phone.startsWith("+92")
        ? fields.phone
        : `+92${fields.phone}`;
    }

    // Uniqueness checks (excluding this user, scoped to their role)
    if (update.cnic && update.cnic !== user.cnic) {
      const existingCnic = await db.collection("users").findOne({
        _id: { $ne: user._id },
        cnic: update.cnic,
        role: user.role,
      });
      if (existingCnic) {
        return res.status(409).json({ message: "CNIC is already registered" });
      }
    }

    if (update.phone && update.phone !== user.phone) {
      const existingPhone = await db.collection("users").findOne({
        _id: { $ne: user._id },
        phone: update.phone,
        role: user.role,
      });
      if (existingPhone) {
        return res.status(409).json({ message: "Phone number is already registered" });
      }
    }

    // Address fields
    if (fields.street || fields.city || fields.zip) {
      const existing = user.address || {};
      update.address = {
        street: fields.street ?? existing.street ?? "",
        city: fields.city ?? existing.city ?? "",
        zip: fields.zip ?? existing.zip ?? "",
      };
    }

    // Provider-only fields
    if (user.role === "provider") {
      if (fields.email) update.email = fields.email.toLowerCase().trim();
      if (fields.category) {
        if (!VALID_CATEGORIES.includes(fields.category)) {
          return res.status(400).json({ message: "Invalid category" });
        }
        update.category = fields.category;
      }
      if (typeof fields.about === "string") {
        update.about = fields.about.trim();
      }
      const lat = Number(fields.latitude);
      const lng = Number(fields.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        update.latitude = lat;
        update.longitude = lng;
        update.geo = { type: "Point", coordinates: [lng, lat] };
      }
      if (fields.cnicFrontImage) update.cnicFrontImage = fields.cnicFrontImage;
      if (fields.cnicBackImage) update.cnicBackImage = fields.cnicBackImage;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    // Changing category invalidates the services the provider posted under
    // their old one — wipe them (and their images) before applying the change.
    if (update.category && update.category !== user.category) {
      const oldServices = await db
        .collection("providerServices")
        .find({ providerId: user._id })
        .toArray();

      if (oldServices.length > 0) {
        const allImages = oldServices.flatMap((s) => s.images || []);
        deleteManyFromCloudinary(allImages);
        await db
          .collection("providerServices")
          .deleteMany({ providerId: user._id });
      }
    }

    await db
      .collection("users")
      .updateOne({ _id: new ObjectId(req.decoded.id) }, { $set: update });

    // Replaced images are now orphaned in Cloudinary — clean them up. Fired
    // without awaiting so the response isn't held up by the delete calls.
    const replacedImages = [
      "profileImage",
      "cnicFrontImage",
      "cnicBackImage",
    ]
      .filter((field) => update[field] && update[field] !== user[field])
      .map((field) => user[field]);
    deleteManyFromCloudinary(replacedImages);

    return res.status(200).json({ success: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update profile error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function updateSubscription(req, res) {
  const { subscriptionStatus } = req.body;

  if (subscriptionStatus === undefined || subscriptionStatus === null) {
    return res.status(400).json({ message: "subscriptionStatus is required" });
  }

  try {
    const db = await getDb();

    await db
      .collection("users")
      .updateOne(
        { _id: new ObjectId(req.decoded.id) },
        {
          $set: {
            subscriptionStatus,
            subscriptionDate: new Date(),
            updatedAt: new Date(),
          },
        },
      );

    return res.status(200).json({ success: true, message: "Subscription status updated" });
  } catch (error) {
    console.error("Update subscription error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function verifyPassword(req, res) {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: "Password is required" });
  }

  try {
    const db = await getDb();

    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(req.decoded.id) });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isHashed = /^\$2[aby]\$/.test(user.password);
    const passwordMatch = isHashed
      ? await bcrypt.compare(password, user.password)
      : password === user.password;

    if (!passwordMatch) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Verify password error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function checkEmail(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const db = await getDb();

    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(req.decoded.id) });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db.collection("users").findOne({
      _id: { $ne: user._id },
      email: normalizedEmail,
      role: user.role,
    });

    if (existing) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Check email error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function updateEmail(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const db = await getDb();

    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(req.decoded.id) });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db.collection("users").findOne({
      _id: { $ne: user._id },
      email: normalizedEmail,
      role: user.role,
    });

    if (existing) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    await db
      .collection("users")
      .updateOne({ _id: user._id }, { $set: { email: normalizedEmail } });

    return res.status(200).json({ success: true, message: "Email updated successfully" });
  } catch (error) {
    console.error("Update email error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

// "Delete Account" — soft-deletes the account instead of removing it, so it
// can be reactivated by signing up again with the same email (see
// signupConsumer/signupProvider). Login and provider-switch both treat a
// deactivated account as if it doesn't exist.
async function deactivateAccount(req, res) {
  try {
    const db = await getDb();

    await db
      .collection("users")
      .updateOne(
        { _id: new ObjectId(req.decoded.id) },
        { $set: { isActive: false, updatedAt: new Date() } }
      );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Deactivate account error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

module.exports = {
  me,
  listProviders,
  providerDetail,
  profileImage,
  subscription,
  updateBadgeSubscription,
  updateProfile,
  updateSubscription,
  verifyPassword,
  checkEmail,
  updateEmail,
  deactivateAccount,
};
