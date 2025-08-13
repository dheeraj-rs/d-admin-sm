import { MongoClient, MongoClientOptions, Db } from 'mongodb';
import Redis from 'ioredis';

if (!process.env.MONGODB_URI) {
  throw new Error('Invalid/Missing environment variable: "MONGODB_URI"');
}

const uri = process.env.MONGODB_URI;
const options: MongoClientOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  minPoolSize: 1,
};

let client: MongoClient;
let clientPromise: Promise<MongoClient>;

// Global connection for development
if (process.env.NODE_ENV === 'development') {
  let globalWithMongo = global as typeof globalThis & {
    _mongoClientPromise?: Promise<MongoClient>;
  };

  if (!globalWithMongo._mongoClientPromise) {
    client = new MongoClient(uri, options);
    globalWithMongo._mongoClientPromise = client.connect();
  }
  clientPromise = globalWithMongo._mongoClientPromise;
} else {
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

// Redis connection for caching and session management
export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 100, 3000), // Instead of retryDelayOnFailover
});

// Tenant isolation - each tenant gets their own database
export async function getTenantDatabase(tenantId: string): Promise<Db> {
  const client = await clientPromise;
  return client.db(`saas_tenant_${tenantId}`);
}

// Shared database for cross-tenant operations
export async function getSharedDatabase(): Promise<Db> {
  const client = await clientPromise;
  return client.db('saas_shared');
}

// Initialize indexes for better performance
export async function initializeDatabaseIndexes(tenantId: string) {
  const db = await getTenantDatabase(tenantId);
  
  // User collection indexes
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ tenantId: 1, role: 1 });
  await db.collection('users').createIndex({ isActive: 1, lastLogin: -1 });
  
  // Session collection indexes
  await db.collection('sessions').createIndex({ token: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ userId: 1 });
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  
  // Audit logs indexes
  await db.collection('auditLogs').createIndex({ userId: 1, timestamp: -1 });
  await db.collection('auditLogs').createIndex({ action: 1, timestamp: -1 });
  await db.collection('auditLogs').createIndex({ timestamp: -1 });
  
  // Dashboard widgets indexes
  await db.collection('dashboards').createIndex({ userId: 1 });
  
  console.log(`Database indexes initialized for tenant: ${tenantId}`);
}

export default clientPromise;