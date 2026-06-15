const { MongoClient } = require("mongodb");
const env = require("./env");

const options = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 30000,
};

const client = new MongoClient(env.mongodbUri, options);
let clientPromise;

function getClientPromise() {
  if (!clientPromise) {
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDb() {
  const connectedClient = await getClientPromise();
  return connectedClient.db("linkaro");
}

// Ensures the geospatial index used for nearby-job lookups exists, and
// backfills the GeoJSON `geo` field on any legacy job documents that only
// have plain `latitude`/`longitude` fields.
async function ensureIndexes() {
  const db = await getDb();
  const jobs = db.collection("jobs");

  await jobs.updateMany(
    {
      latitude: { $exists: true },
      longitude: { $exists: true },
      geo: { $exists: false },
    },
    [
      {
        $set: {
          geo: { type: "Point", coordinates: ["$longitude", "$latitude"] },
        },
      },
    ]
  );

  await jobs.createIndex({ geo: "2dsphere" });
  await jobs.createIndex({ userId: 1, createdAt: -1 });
  await jobs.createIndex({ assignedProviderId: 1, status: 1, completedAt: -1 });

  const providerServices = db.collection("providerServices");
  await providerServices.createIndex({ providerId: 1, createdAt: -1 });

  const messages = db.collection("messages");
  await messages.createIndex({ conversationId: 1, createdAt: -1 });

  const conversations = db.collection("conversations");
  await conversations.createIndex({ participants: 1, updatedAt: -1 });
}

module.exports = { getDb, getClientPromise, ensureIndexes };
