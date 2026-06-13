const { ObjectId } = require("mongodb");
const { getDb } = require("../../config/db");

const EARTH_RADIUS_KM = 6371;

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function myJobs(req, res) {
  try {
    const db = await getDb();

    const jobs = await db
      .collection("jobs")
      .find({ userId: new ObjectId(req.decoded.id) })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({ success: true, jobs });
  } catch (error) {
    console.error("Get my jobs error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function postJob(req, res) {
  const { title, category, problem, location, scheduledTime, latitude, longitude } =
    req.body;

  if (!title || !category || !problem || !location) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const db = await getDb();

    const jobDoc = {
      userId: new ObjectId(req.decoded.id),
      title: title.trim(),
      category,
      problem: problem.trim(),
      location: location.trim(),
      scheduledTime: scheduledTime || "ASAP",
      status: "open",
      createdAt: new Date(),
    };

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      jobDoc.latitude = lat;
      jobDoc.longitude = lng;
    }

    const result = await db.collection("jobs").insertOne(jobDoc);

    await db
      .collection("users")
      .updateOne({ _id: new ObjectId(req.decoded.id) }, { $inc: { totalJobs: 1 } });

    return res.status(201).json({ success: true, jobId: result.insertedId });
  } catch (error) {
    console.error("Post job error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

// Jobs near a provider: open jobs matching the provider's categories, within
// `radius` km of the given coordinates, sorted closest-first.
async function nearbyJobs(req, res) {
  try {
    const db = await getDb();

    const provider = await db
      .collection("users")
      .findOne({ _id: new ObjectId(req.decoded.id) });

    if (!provider) {
      return res.status(404).json({ message: "User not found" });
    }

    if (provider.subscriptionStatus !== "active") {
      return res.status(200).json({
        success: true,
        needsSubscription: true,
        needsLocation: false,
        jobs: [],
      });
    }

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(200).json({
        success: true,
        needsSubscription: false,
        needsLocation: true,
        jobs: [],
      });
    }

    const radiusKm = Number(req.query.radius) || 10;
    const categories = Array.isArray(provider.categories)
      ? provider.categories
      : [];

    const rawJobs = await db
      .collection("jobs")
      .find({
        status: "open",
        category: { $in: categories },
        latitude: { $exists: true },
        longitude: { $exists: true },
      })
      .toArray();

    const inRange = rawJobs
      .map((job) => ({
        ...job,
        distanceKm: haversineKm(lat, lng, job.latitude, job.longitude),
      }))
      .filter((job) => job.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const consumerIds = [
      ...new Set(inRange.map((job) => job.userId.toString())),
    ].map((id) => new ObjectId(id));

    const consumers = await db
      .collection("users")
      .find({ _id: { $in: consumerIds } })
      .project({ name: 1, profileImage: 1 })
      .toArray();
    const consumerMap = new Map(
      consumers.map((c) => [c._id.toString(), c])
    );

    const jobs = inRange.map((job) => {
      const consumer = consumerMap.get(job.userId.toString());
      return {
        _id: job._id,
        title: job.title,
        category: job.category,
        problem: job.problem,
        location: job.location,
        scheduledTime: job.scheduledTime,
        status: job.status,
        createdAt: job.createdAt,
        distanceKm: job.distanceKm,
        consumerId: job.userId,
        consumerName: consumer?.name ?? null,
        consumerProfileImage: consumer?.profileImage ?? null,
      };
    });

    return res.status(200).json({
      success: true,
      needsSubscription: false,
      needsLocation: false,
      jobs,
    });
  } catch (error) {
    console.error("Get nearby jobs error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

module.exports = { myJobs, postJob, nearbyJobs };
