import assert from "node:assert/strict";
import { test } from "node:test";
import { listeningEndpoint } from "../src/app/ports.ts";

test("listening addresses from ss and netstat", () => {
  assert.deepEqual(listeningEndpoint("0.0.0.0:5432"), { host: "127.0.0.1", port: 5432 });
  assert.deepEqual(listeningEndpoint("127.0.0.1:3000"), { host: "127.0.0.1", port: 3000 });
  assert.deepEqual(listeningEndpoint("[::]:80"), { host: "127.0.0.1", port: 80 });
  assert.deepEqual(listeningEndpoint("[::1]:631"), { host: "::1", port: 631 });
  assert.deepEqual(listeningEndpoint("*:443"), { host: "127.0.0.1", port: 443 });
  assert.deepEqual(listeningEndpoint("127.0.0.53%lo:53"), { host: "127.0.0.53", port: 53 });
  assert.deepEqual(listeningEndpoint(":::22"), { host: "127.0.0.1", port: 22 });
  assert.deepEqual(listeningEndpoint("10.0.0.5:8080"), { host: "10.0.0.5", port: 8080 });
});

test("unusable addresses", () => {
  assert.equal(listeningEndpoint("*:*"), null);
  assert.equal(listeningEndpoint("0.0.0.0:0"), null);
  assert.equal(listeningEndpoint("garbage"), null);
});
