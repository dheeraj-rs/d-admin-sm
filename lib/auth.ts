import jwt, { JwtPayload } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { NextAuthOptions } from 'next-auth';
import { MongoDBAdapter } from '@auth/mongodb-adapter';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import clientPromise, { getTenantDatabase } from './db';
import { ObjectId } from 'mongodb';
import { User } from './models/user';

const JWT_SECRET =
  process.env.JWT_SECRET || 'fallback-secret-change-in-production';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

export interface CustomJWTPayload extends JwtPayload {
  userId: string;
  tenantId: string;
  role: string;
  permissions: string[];
  sessionId: string;
}

// Generate JWT tokens
export function generateTokens(user: User) {
  const payload = {
    userId: user._id,
    tenantId: user.tenantId,
    role: user.role,
    permissions: user.permissions,
    sessionId: generateSessionId(),
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: 'enterprise-saas',
    audience: user.tenantId,
  });

  const refreshToken = jwt.sign({ ...payload, type: 'refresh' }, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
    issuer: 'enterprise-saas',
    audience: user.tenantId,
  });

  return { accessToken, refreshToken };
}

// Verify JWT token
export function verifyToken(token: string): CustomJWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as CustomJWTPayload;
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

// Hash password
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}

// Verify password
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

// Generate session ID
export function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Check account lockout
export async function isAccountLocked(user: User): Promise<boolean> {
  if (user.lockoutUntil && user.lockoutUntil > new Date()) {
    return true;
  }
  return false;
}

// Update login attempts
export async function updateLoginAttempts(
  userId: string,
  tenantId: string,
  success: boolean
) {
  const db = await getTenantDatabase(tenantId);
  const users = db.collection('users');

  if (success) {
    // Reset on successful login
    await users.updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          loginAttempts: 0,
          lastLogin: new Date(),
        },
        $unset: { lockoutUntil: 1 },
      }
    );
  } else {
    // Increment failed attempts
    const user = await users.findOne({ _id: new ObjectId(userId) });
    if (user) {
      const newAttempts = (user.loginAttempts || 0) + 1;
      const lockoutTime =
        newAttempts >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null; // 30 min lockout

      await users.updateOne(
        { _id: new ObjectId(userId) },
        {
          $set: {
            loginAttempts: newAttempts,
            ...(lockoutTime && { lockoutUntil: lockoutTime }),
          },
        }
      );
    }
  }
}

// NextAuth configuration
export const authOptions: NextAuthOptions = {
  adapter: MongoDBAdapter(clientPromise),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        tenantId: { label: 'Tenant ID', type: 'text' },
      },
      async authorize(credentials) {
        if (
          !credentials?.email ||
          !credentials?.password ||
          !credentials?.tenantId
        ) {
          throw new Error('Missing required credentials');
        }

        try {
          const db = await getTenantDatabase(credentials.tenantId);
          const user = await db
            .collection('users')
            .findOne({ email: credentials.email }) as unknown as User;

          if (!user) {
            throw new Error('Invalid credentials');
          }

          if (await isAccountLocked(user)) {
            throw new Error(
              'Account is locked due to too many failed login attempts'
            );
          }

          // Check if password exists
          if (!user.password) {
            throw new Error('Invalid credentials');
          }
          
          const isValid = await verifyPassword(
            credentials.password,
            user.password
          );

          if (isValid) {
            // Ensure user._id exists and convert to string if it's an ObjectId
            const userId = user._id ? (typeof user._id === 'string' ? user._id : user._id.toString()) : '';
            if (!userId) {
              throw new Error('Invalid user ID');
            }
            
            await updateLoginAttempts(userId, credentials.tenantId, true);
            return {
              id: userId, // Already converted to string above
              email: user.email,
              name: user.name,
              tenantId: user.tenantId,
              role: user.role,
            };
          } else {
            // Ensure user._id exists and convert to string if it's an ObjectId
            const userId = user._id ? (typeof user._id === 'string' ? user._id : user._id.toString()) : '';
            if (userId) {
              await updateLoginAttempts(userId, credentials.tenantId, false);
            }
            throw new Error('Invalid credentials');
          }
        } catch (error) {
          console.error('Auth error:', error);
          throw error;
        }
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 15 * 60, // 15 minutes
  },
  jwt: {
    secret: JWT_SECRET,
    maxAge: 15 * 60, // 15 minutes
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.tenantId = (user as any).tenantId;
        token.role = (user as any).role;
      }
      return token;
    },
    async session({ session, token }) {
      // Keep the default user properties and add custom properties to the session object itself
      (session as any).userId = token.userId;
      (session as any).tenantId = token.tenantId;
      (session as any).role = token.role;
      return session;
    },
  },
  pages: {
    signIn: '/auth/login',
    error: '/auth/error',
  },
};
