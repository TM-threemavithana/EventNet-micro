import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";

type AuthUserLike = {
  backendToken?: string;
  role?: string;
};

// Safely converts any value to a non-empty string ID (supports both UUIDs and numeric IDs)
const toIdString = (value: unknown): string => {
  const stringValue = String(value ?? "").trim();
  return stringValue || "";
};

// NextAuth route handlers run on the server (Node), so backend calls MUST use an absolute URL.
// IMPORTANT: don't throw at module-evaluation time (breaks `next build` inside Docker).
const getBackendApiBaseUrl = (): string => {
  const base =
    process.env.INTERNAL_BACKEND_API_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_URL ||
    (process.env.NEXTAUTH_URL ? `${process.env.NEXTAUTH_URL}/api` : "");
  return base;
};

const safeBackendFetch = async (path: string, body: Record<string, unknown>) => {
  const baseUrl = getBackendApiBaseUrl();
  if (!baseUrl.startsWith("http")) {
    throw new Error("BACKEND_API_URL_NOT_CONFIGURED");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(`${baseUrl}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const handler = NextAuth({
  session: {
    strategy: 'jwt'
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: "Email", type: "text" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        try {
          const res = await safeBackendFetch("/users/auth/login", {
            email: credentials.email,
            password: credentials.password,
          });
          const data = await res.json();

          // ─── LOG 1: See what the backend returned ───
          console.log("[authorize] backend data.user:", data.user);

          if (res.ok && data.user) {
            const returned = {
              id: data.user.id,
              email: data.user.email,
              name: `${data.user.first_name || ''} ${data.user.last_name || ''}`.trim() || data.user.email,
              role: data.user.role,
              backendToken: data.token
            };

            // ─── LOG 2: See what authorize() is returning to NextAuth ───
            console.log("[authorize] returning user object:", returned);

            return returned;
          }
          return null;
        } catch {
          return null;
        }
      }
    }),
  ],
  callbacks: {
    async jwt({ token, account, user }) {

      // LOG 3: See what NextAuth passes into the jwt callback
      console.log("[jwt] user received:", user);
      console.log("[jwt] token.sub (NextAuth built-in):", token.sub);
      console.log("[jwt] token.userId before any changes:", token.userId);

      if (account && account.id_token) {
        // Google OAuth login — fetch database user ID from our backend
        token.idToken = account.id_token;
        try {
          const res = await safeBackendFetch("/users/auth/google", {
            token: account.id_token,
          });
          if (res.ok) {
            const data = await res.json();
            token.backendToken = data.token;
            token.role = data.user.role;
            // Store our database ID (not Google's sub)
            token.userId = toIdString(data.user?.id);
          }
        } catch {
          // Ignore backend sync failures
        }
      } else if (user && typeof user === "object" && "backendToken" in user) {
        // Credentials login — only runs on the very FIRST call when user object exists
        const typedUser = user as AuthUserLike;
        token.backendToken = typedUser.backendToken;
        token.role = typedUser.role;
        if (user.id) {
          token.userId = toIdString(user.id);
        }
      }

      // LOG 4: See what token.userId is after all the logic
      // IMPORTANT: token.sub is ALWAYS set by NextAuth from user.id automatically.
      // If our custom token.userId was never set (old session cookie), fall back to token.sub.
      console.log("[jwt] token.userId after all logic:", token.userId);
      console.log("[jwt] token.sub fallback would be:", token.sub);

      return token;
    },
    async session({ session, token }) {

      // LOG 5: See what token contains when building the session
      console.log("[session] token.userId:", token.userId, "token.sub:", token.sub);

      session.idToken = token.idToken as string;
      session.backendToken = token.backendToken as string;
      if (session.user) {
        // Use our explicit token.userId first; fall back to token.sub which NextAuth ALWAYS sets.
        const rawId = token.userId || token.sub || "";
        session.user.id = toIdString(rawId);
        session.user.role = token.role as string;
      }

      // LOG 6: See what session.user.id ends up as
      console.log("[session] session.user.id:", session.user?.id);

      return session;
    },
  },
});

export { handler as GET, handler as POST };