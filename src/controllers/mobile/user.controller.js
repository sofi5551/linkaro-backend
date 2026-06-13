const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");
const { getDb } = require("../../config/db");
const env = require("../../config/env");
const { VALID_CATEGORIES } = require("../../constants/categories");

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

async function listProviders(req, res) {
  try {
    const db = await getDb();

    const consumer = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(req.decoded.id) },
        { projection: { "address.city": 1 } }
      );

    if (!consumer) {
      return res.status(404).json({ message: "User not found" });
    }

    const city = consumer.address?.city;

    const query = {
      role: "provider",
      registrationStatus: true,
      subscriptionStatus: "active",
    };
    if (city) {
      query["address.city"] = { $regex: `^${city}$`, $options: "i" };
    }

    const providers = await db
      .collection("users")
      .find(query, {
        projection: {
          name: 1,
          profileImage: 1,
          categories: 1,
          address: 1,
          badgeSubscriptionStatus: 1,
          rating: 1,
          reviewsCount: 1,
        },
      })
      .toArray();

    return res.status(200).json({ success: true, providers });
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
          categories: 1,
          address: 1,
          badgeSubscriptionStatus: 1,
          rating: 1,
          reviewsCount: 1,
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

    return res.status(200).json({ success: true, provider, services });
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
      .findOne({ _id: new ObjectId(id) }, { projection: { profileImage: 1, totalJobs: 1, name: 1, email: 1 } });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      name: user.name || null,
      email: user.email || null,
      profileImage: user.profileImage || null,
      totalJobs: user.totalJobs ?? 0,
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
      if (Array.isArray(fields.categories) && fields.categories.length > 0) {
        if (!fields.categories.every((c) => VALID_CATEGORIES.includes(c))) {
          return res.status(400).json({ message: "Invalid category" });
        }
        update.categories = fields.categories;
      }
      if (fields.cnicFrontImage) update.cnicFrontImage = fields.cnicFrontImage;
      if (fields.cnicBackImage) update.cnicBackImage = fields.cnicBackImage;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    await db
      .collection("users")
      .updateOne({ _id: new ObjectId(req.decoded.id) }, { $set: update });

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
};
