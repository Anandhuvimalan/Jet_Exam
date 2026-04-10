import { OAuth2Client } from "google-auth-library";

const GMAIL_DOMAIN = "@gmail.com";

export interface VerifiedGoogleIdentity {
  email: string;
  name: string;
  subject: string;
}

let cachedClient: OAuth2Client | null = null;

export function normalizeGoogleEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateGoogleEmail(email: string): string | null {
  const normalizedEmail = normalizeGoogleEmail(email);
  if (!normalizedEmail) {
    return "Email is required.";
  }

  if (!normalizedEmail.endsWith(GMAIL_DOMAIN)) {
    return "Only Gmail accounts are allowed.";
  }

  return null;
}

function getClient(): OAuth2Client {
  if (!cachedClient) {
    cachedClient = new OAuth2Client();
  }

  return cachedClient;
}

export async function verifyGoogleCredential(
  credential: string,
  audience: string
): Promise<VerifiedGoogleIdentity> {
  const ticket = await getClient().verifyIdToken({
    idToken: credential,
    audience
  });
  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error("Google did not return a valid identity payload.");
  }

  if (!payload.email || !payload.email_verified) {
    throw new Error("A verified Google email address is required.");
  }

  const normalizedEmail = normalizeGoogleEmail(payload.email);
  const emailError = validateGoogleEmail(normalizedEmail);
  if (emailError) {
    throw new Error(emailError);
  }

  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) {
    throw new Error("Google did not return a valid account identifier.");
  }

  const displayName = typeof payload.name === "string" && payload.name.trim()
    ? payload.name.trim()
    : normalizedEmail.replace(GMAIL_DOMAIN, "");

  return {
    email: normalizedEmail,
    name: displayName,
    subject
  };
}
