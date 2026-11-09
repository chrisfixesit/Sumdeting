import { randomBytes, randomInt, createHash } from "node:crypto";

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function newCode() {
  return String(randomInt(0, 1e6)).padStart(6, "0");
}

export function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function normaliseEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
