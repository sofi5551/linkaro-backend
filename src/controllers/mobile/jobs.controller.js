const { ObjectId } = require("mongodb");
const { getDb } = require("../../config/db");
const { isUserOnline } = require("../../sockets");
const { createNotification } = require("../../lib/notifications");
const { sendEmail, jobHiredEmail, jobCompletedEmail } = require("../../lib/mailer");

const ONLINE_WINDOW_MS = 2 * 60 * 1000;

async function myJobs(req, res) {
  try {
    const db = await getDb();

    const jobs = await db
      .collection("jobs")
      .find({ userId: new ObjectId(req.decoded.id), status: { $ne: "expired" } })
      .sort({ createdAt: -1 })
      .toArray();

    const providerIds = [
      ...new Set(
        jobs
          .filter((job) => job.assignedProviderId)
          .map((job) => job.assignedProviderId.toString())
      ),
    ].map((id) => new ObjectId(id));

    let providerMap = new Map();
    if (providerIds.length) {
      const providers = await db
        .collection("users")
        .find({ _id: { $in: providerIds } })
        .project({
          name: 1,
          profileImage: 1,
          rating: 1,
          category: 1,
          phone: 1,
          jobsCompleted: 1,
          lastSeenAt: 1,
        })
        .toArray();
      providerMap = new Map(providers.map((p) => [p._id.toString(), p]));
    }

    const now = Date.now();

    const result = jobs.map((job) => {
      const provider = job.assignedProviderId
        ? providerMap.get(job.assignedProviderId.toString())
        : null;
      if (!provider) return job;
      const lastSeenAt = provider.lastSeenAt
        ? new Date(provider.lastSeenAt).getTime()
        : 0;
      return {
        ...job,
        assignedTo: provider.name ?? null,
        providerImage: provider.profileImage ?? null,
        providerRating: provider.rating ?? null,
        providerBusiness: provider.category ?? null,
        providerPhone: provider.phone ?? null,
        providerJobsCompleted: provider.jobsCompleted ?? 0,
        providerIsOnline:
          isUserOnline(job.assignedProviderId.toString()) ||
          now - lastSeenAt <= ONLINE_WINDOW_MS,
        completedBy: job.status === "completed" ? provider.name ?? null : null,
      };
    });

    return res.status(200).json({ success: true, jobs: result });
  } catch (error) {
    console.error("Get my jobs error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

// Single job lookup — used to open a job's detail screen from a
// notification (e.g. "you've been hired"), which only carries a jobId.
async function getJobById(req, res) {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Valid job id is required" });
  }

  try {
    const db = await getDb();

    const job = await db.collection("jobs").findOne({ _id: new ObjectId(id) });

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    const myId = req.decoded.id;
    const isPoster = job.userId.toString() === myId;
    const isAssignedProvider =
      job.assignedProviderId && job.assignedProviderId.toString() === myId;

    let isEligibleProvider = false;
    if (!isPoster && !isAssignedProvider && job.status === "open") {
      const requester = await db
        .collection("users")
        .findOne(
          { _id: new ObjectId(myId) },
          { projection: { role: 1, category: 1 } }
        );
      isEligibleProvider =
        requester?.role === "provider" && requester.category === job.category;
    }

    if (!isPoster && !isAssignedProvider && !isEligibleProvider) {
      return res.status(403).json({ message: "Access denied" });
    }

    return res.status(200).json({ success: true, job });
  } catch (error) {
    console.error("Get job by id error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function assignProvider(req, res) {
  const { id } = req.params;
  const { providerId } = req.body;

  if (!ObjectId.isValid(id) || !providerId || !ObjectId.isValid(providerId)) {
    return res
      .status(400)
      .json({ message: "Valid job id and providerId are required" });
  }

  try {
    const db = await getDb();

    const job = await db.collection("jobs").findOne({ _id: new ObjectId(id) });

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (job.userId.toString() !== req.decoded.id) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (job.status !== "open") {
      return res.status(400).json({ message: "Job is not open for assignment" });
    }

    const provider = await db
      .collection("users")
      .findOne({ _id: new ObjectId(providerId), role: "provider" });

    if (!provider) {
      return res.status(404).json({ message: "Provider not found" });
    }

    await db.collection("jobs").updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "in_progress",
          assignedProviderId: new ObjectId(providerId),
          assignedAt: new Date(),
        },
      }
    );

    const io = req.app.get("io");
    if (io) {
      io.to(`category:${job.category}`).emit("job_unavailable", {
        jobId: job._id.toString(),
      });
    }

    createNotification({
      userId: provider._id,
      type: "job_hired",
      message: `You've been hired for the job "${job.title}".`,
      io,
      jobId: job._id,
    }).catch((err) => console.error("Notification create error:", err));

    if (provider.email) {
      sendEmail({
        to: provider.email,
        subject: "You've been hired for a job on Linkaro",
        html: jobHiredEmail(provider.name || "there", job.title),
      }).catch((err) => console.error("Email send error:", err));
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Assign provider error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function cancelJob(req, res) {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Valid job id is required" });
  }

  try {
    const db = await getDb();

    const job = await db.collection("jobs").findOne({ _id: new ObjectId(id) });

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (job.userId.toString() !== req.decoded.id) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (job.status !== "open") {
      return res
        .status(400)
        .json({ message: "Only pending jobs can be cancelled" });
    }

    await db.collection("jobs").deleteOne({ _id: new ObjectId(id) });

    const io = req.app.get("io");
    if (io) {
      io.to(`category:${job.category}`).emit("job_unavailable", {
        jobId: job._id.toString(),
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Cancel job error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function completeJob(req, res) {
  const { id } = req.params;
  const { rating, review } = req.body;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Valid job id is required" });
  }

  const ratingNum = Number(rating);
  if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res
      .status(400)
      .json({ message: "A rating between 1 and 5 is required" });
  }
  if (!review || !review.trim()) {
    return res.status(400).json({ message: "A review is required" });
  }

  try {
    const db = await getDb();

    const job = await db.collection("jobs").findOne({ _id: new ObjectId(id) });

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (job.userId.toString() !== req.decoded.id) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (job.status !== "in_progress") {
      return res
        .status(400)
        .json({ message: "Only in-progress jobs can be completed" });
    }

    await db.collection("jobs").updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          rating: ratingNum,
          review: review.trim(),
        },
      }
    );

    if (job.assignedProviderId) {
      const provider = await db
        .collection("users")
        .findOne(
          { _id: job.assignedProviderId },
          { projection: { rating: 1, jobsCompleted: 1, name: 1, email: 1 } }
        );

      const prevCount = provider?.jobsCompleted ?? 0;
      const prevRating = provider?.rating ?? 0;
      const newRating = (prevRating * prevCount + ratingNum) / (prevCount + 1);

      await db.collection("users").updateOne(
        { _id: job.assignedProviderId },
        { $set: { rating: newRating }, $inc: { jobsCompleted: 1 } }
      );

      const stars = "★".repeat(ratingNum) + "☆".repeat(5 - ratingNum);

      createNotification({
        userId: job.assignedProviderId,
        type: "job_completed",
        message: `The job "${job.title}" has been marked as completed. ${stars} Review: "${review.trim()}"`,
        io: req.app.get("io"),
      }).catch((err) => console.error("Notification create error:", err));

      if (provider?.email) {
        sendEmail({
          to: provider.email,
          subject: "Job completed on Linkaro",
          html: jobCompletedEmail(provider.name || "there", job.title),
        }).catch((err) => console.error("Email send error:", err));
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Complete job error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

const VALID_PRIORITIES = ["High", "Medium", "Low"];

async function postJob(req, res) {
  const {
    title,
    category,
    problem,
    location,
    scheduledTime,
    priority,
    latitude,
    longitude,
  } = req.body;

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
      priority: VALID_PRIORITIES.includes(priority) ? priority : "Medium",
      status: "open",
      createdAt: new Date(),
    };

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      jobDoc.latitude = lat;
      jobDoc.longitude = lng;
      jobDoc.geo = { type: "Point", coordinates: [lng, lat] };
    }

    const result = await db.collection("jobs").insertOne(jobDoc);

    await db
      .collection("users")
      .updateOne({ _id: new ObjectId(req.decoded.id) }, { $inc: { totalJobs: 1 } });

    if (jobDoc.geo) {
      const io = req.app.get("io");
      if (io) {
        const consumer = await db
          .collection("users")
          .findOne(
            { _id: new ObjectId(req.decoded.id) },
            { projection: { name: 1, profileImage: 1, lastSeenAt: 1 } }
          );
        const lastSeenAt = consumer?.lastSeenAt
          ? new Date(consumer.lastSeenAt).getTime()
          : 0;

        io.to(`category:${category}`).emit("job_posted", {
          _id: result.insertedId,
          title: jobDoc.title,
          category: jobDoc.category,
          problem: jobDoc.problem,
          location: jobDoc.location,
          latitude: jobDoc.latitude,
          longitude: jobDoc.longitude,
          scheduledTime: jobDoc.scheduledTime,
          priority: jobDoc.priority,
          status: jobDoc.status,
          createdAt: jobDoc.createdAt,
          consumerId: jobDoc.userId,
          consumerName: consumer?.name ?? null,
          consumerProfileImage: consumer?.profileImage ?? null,
          consumerIsOnline:
            isUserOnline(req.decoded.id) ||
            Date.now() - lastSeenAt <= ONLINE_WINDOW_MS,
        });
      }
    }

    return res.status(201).json({ success: true, jobId: result.insertedId });
  } catch (error) {
    console.error("Post job error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

// Jobs near a provider: open jobs matching the provider's category, within
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

    const linkedConsumer = await db
      .collection("users")
      .findOne({ email: provider.email, role: "consumer" });

    const excludedUserIds = [new ObjectId(req.decoded.id)];
    if (linkedConsumer) excludedUserIds.push(linkedConsumer._id);

    const inRange = await db
      .collection("jobs")
      .aggregate([
        {
          $geoNear: {
            near: { type: "Point", coordinates: [lng, lat] },
            distanceField: "distanceMeters",
            maxDistance: radiusKm * 1000,
            spherical: true,
            query: {
              status: "open",
              category: provider.category,
              userId: { $nin: excludedUserIds },
            },
          },
        },
      ])
      .toArray();

    const consumerIds = [
      ...new Set(inRange.map((job) => job.userId.toString())),
    ].map((id) => new ObjectId(id));

    const consumers = await db
      .collection("users")
      .find({ _id: { $in: consumerIds } })
      .project({ name: 1, profileImage: 1, lastSeenAt: 1 })
      .toArray();
    const consumerMap = new Map(
      consumers.map((c) => [c._id.toString(), c])
    );

    const now = Date.now();

    const jobs = inRange.map((job) => {
      const consumer = consumerMap.get(job.userId.toString());
      const lastSeenAt = consumer?.lastSeenAt
        ? new Date(consumer.lastSeenAt).getTime()
        : 0;
      return {
        _id: job._id,
        title: job.title,
        category: job.category,
        problem: job.problem,
        location: job.location,
        latitude: job.latitude,
        longitude: job.longitude,
        scheduledTime: job.scheduledTime,
        priority: job.priority ?? "Medium",
        status: job.status,
        createdAt: job.createdAt,
        distanceKm: job.distanceMeters / 1000,
        consumerId: job.userId,
        consumerName: consumer?.name ?? null,
        consumerProfileImage: consumer?.profileImage ?? null,
        consumerIsOnline: consumer
          ? isUserOnline(job.userId.toString()) ||
            now - lastSeenAt <= ONLINE_WINDOW_MS
          : false,
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

// Called by the provider's own app the instant it locally determines (via
// the category-scoped `job_posted` socket event + its own last-known GPS,
// never sent to or stored by the server) that a newly-posted job is within
// their radius. Records the match as a real in-app notification so it shows
// up later in the Notifications screen — the push itself is skipped since
// the client, by definition, is already connected and already showing its
// own toast for this exact event.
async function notifyNearbyJobMatch(req, res) {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Valid job id is required" });
  }

  try {
    const db = await getDb();

    const provider = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(req.decoded.id) },
        { projection: { role: 1, category: 1 } }
      );

    if (!provider || provider.role !== "provider") {
      return res.status(403).json({ message: "Access denied" });
    }

    const job = await db.collection("jobs").findOne({ _id: new ObjectId(id) });

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (job.status !== "open" || job.category !== provider.category) {
      return res.status(400).json({ message: "Job is not a valid match" });
    }

    const existing = await db.collection("notifications").findOne({
      userId: new ObjectId(req.decoded.id),
      jobId: job._id,
      type: "job_nearby",
    });
    if (existing) {
      return res.status(200).json({ success: true });
    }

    await createNotification({
      userId: req.decoded.id,
      type: "job_nearby",
      message: `A new job "${job.title}" was posted near you.`,
      io: req.app.get("io"),
      jobId: job._id,
      skipPush: true,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    // Two near-simultaneous calls for the same job (e.g. a redelivered
    // socket event) can both pass the findOne check above before either
    // insert lands — the unique index then rejects the second one. That's
    // an expected, benign outcome here, not a real failure.
    if (error.code === 11000) {
      return res.status(200).json({ success: true });
    }
    console.error("Notify nearby job match error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

module.exports = {
  myJobs,
  getJobById,
  postJob,
  nearbyJobs,
  notifyNearbyJobMatch,
  assignProvider,
  cancelJob,
  completeJob,
};
