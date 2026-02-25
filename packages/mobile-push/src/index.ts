import { Hono } from "hono";
import { verifyInternalToken } from "@open-inspect/shared";

interface Env {
  INTERNAL_CALLBACK_SECRET?: string;
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
}

interface PushRecipient {
  userId: string;
  devices: Array<{
    deviceId: string;
    pushToken: string;
    platform: "android" | "ios";
    pushProvider: "fcm";
  }>;
}

interface SessionCompletePayload {
  sessionId: string;
  messageId: string;
  success: boolean;
  timestamp: number;
  recipients: PushRecipient[];
}

interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedGoogleAccessToken: { token: string; expiresAtMs: number } | null = null;

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "healthy", service: "danstack-mobile-push" }));

app.post("/callbacks/session-complete", async (c) => {
  const secret = c.env.INTERNAL_CALLBACK_SECRET;
  if (!secret) return c.json({ error: "INTERNAL_CALLBACK_SECRET not configured" }, 500);

  const isValid = await verifyInternalToken(c.req.header("Authorization") ?? null, secret);
  if (!isValid) return c.json({ error: "Unauthorized" }, 401);

  let payload: SessionCompletePayload;
  try {
    payload = (await c.req.json()) as SessionCompletePayload;
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  if (
    !payload.sessionId ||
    !payload.messageId ||
    !Array.isArray(payload.recipients) ||
    payload.recipients.length === 0
  ) {
    return c.json({ error: "Invalid payload shape" }, 400);
  }

  const projectId = c.env.FCM_PROJECT_ID;
  const serviceAccountJson = c.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!projectId || !serviceAccountJson) {
    return c.json({ error: "FCM not configured" }, 503);
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(serviceAccountJson);
  } catch (error) {
    return c.json(
      { error: "Failed to get Google access token", detail: errorToString(error) },
      502
    );
  }

  const invalidTokens: string[] = [];
  let delivered = 0;
  let failed = 0;

  for (const recipient of payload.recipients) {
    for (const device of recipient.devices) {
      if (device.pushProvider !== "fcm") {
        continue;
      }

      const result = await sendWithRetry(async () => {
        return sendFcmMessage({
          projectId,
          accessToken,
          pushToken: device.pushToken,
          sessionId: payload.sessionId,
          messageId: payload.messageId,
          success: payload.success,
        });
      });

      if (result.ok) {
        delivered++;
      } else {
        failed++;
        if (result.invalidToken) {
          invalidTokens.push(device.pushToken);
        }
      }
    }
  }

  return c.json({
    status: "ok",
    delivered,
    failed,
    invalidTokens,
  });
});

async function sendWithRetry(
  fn: () => Promise<{ ok: boolean; invalidToken?: boolean; retryable?: boolean }>
): Promise<{ ok: boolean; invalidToken?: boolean }> {
  const first = await fn();
  if (first.ok || !first.retryable) return first;

  await sleep(500);
  const second = await fn();
  return { ok: second.ok, invalidToken: second.invalidToken };
}

async function sendFcmMessage(input: {
  projectId: string;
  accessToken: string;
  pushToken: string;
  sessionId: string;
  messageId: string;
  success: boolean;
}): Promise<{ ok: boolean; invalidToken?: boolean; retryable?: boolean }> {
  const title = input.success ? "Session complete" : "Session failed";
  const body = input.success
    ? "Your Open-Inspect session finished."
    : "Your Open-Inspect session finished with an error.";
  const deepLink = `openinspect://session/${input.sessionId}`;

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${input.projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        message: {
          token: input.pushToken,
          notification: { title, body },
          data: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            success: String(input.success),
            deepLink,
            eventType: "execution_complete",
          },
          android: {
            priority: "high",
          },
        },
      }),
    }
  );

  if (response.ok) {
    return { ok: true };
  }

  const text = await response.text().catch(() => "");
  const invalidToken = isInvalidTokenResponse(response.status, text);
  const retryable = response.status === 429 || response.status >= 500;

  return { ok: false, invalidToken, retryable };
}

function isInvalidTokenResponse(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return (
    body.includes("UNREGISTERED") ||
    body.includes("registration token is not a valid FCM registration token") ||
    body.includes("INVALID_ARGUMENT")
  );
}

async function getGoogleAccessToken(serviceAccountJson: string): Promise<string> {
  if (cachedGoogleAccessToken && cachedGoogleAccessToken.expiresAtMs > Date.now() + 60_000) {
    return cachedGoogleAccessToken.token;
  }

  const serviceAccount = JSON.parse(serviceAccountJson) as GoogleServiceAccount;
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Invalid service account JSON");
  }

  const tokenUri = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: "RS256", typ: "JWT" };
  const jwtPayload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const assertion = await signJwt(jwtHeader, jwtPayload, serviceAccount.private_key);
  const tokenResponse = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text().catch(() => "");
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${detail}`);
  }

  const tokenBody = (await tokenResponse.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedGoogleAccessToken = {
    token: tokenBody.access_token,
    expiresAtMs: Date.now() + tokenBody.expires_in * 1000,
  };

  return tokenBody.access_token;
}

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKeyPem: string
): Promise<string> {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const encodedSignature = base64UrlEncodeBytes(new Uint8Array(signature));
  return `${signingInput}.${encodedSignature}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function errorToString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default app;
