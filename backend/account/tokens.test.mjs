import { test } from "node:test";
import assert from "node:assert/strict";
import { newToken, newCode, hash, normaliseEmail } from "./tokens.mjs";

test("normaliseEmail trims and lowercases", () => {
  assert.equal(normaliseEmail(" Mum@Gmail.COM "), "mum@gmail.com");
});

test("normaliseEmail rejects invalid and over-long input", () => {
  assert.equal(normaliseEmail("not-an-email"), null);
  assert.equal(normaliseEmail("a".repeat(255 - 6) + "@b.com"), null);
  assert.equal(normaliseEmail(undefined), null);
});

test("newCode is 6 digits", () => {
  for (let i = 0; i < 200; i++) assert.match(newCode(), /^\d{6}$/);
});

test("newToken values are unique and url-safe", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const t = newToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 100);
});

test("hash is sha-256 hex", () => {
  assert.equal(
    hash("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});
