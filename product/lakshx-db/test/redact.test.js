"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { redactConnectionString, redactText } = require("../lib/redact.js");

test("redactConnectionString hides user:pass but keeps the rest of the URI legible", () => {
  assert.equal(
    redactConnectionString("mongodb://alice:s3cr3t@cluster0.example.net:27017/mydb"),
    "mongodb://***:***@cluster0.example.net:27017/mydb",
  );
});

test("redactConnectionString handles mongodb+srv and username-only credentials", () => {
  assert.equal(
    redactConnectionString("mongodb+srv://alice:pw@cluster.mongodb.net/db?retryWrites=true"),
    "mongodb+srv://***:***@cluster.mongodb.net/db?retryWrites=true",
  );
  assert.equal(redactConnectionString("mongodb://tokenonly@host/db"), "mongodb://***@host/db");
});

test("redactConnectionString leaves a credential-free URI unchanged", () => {
  const uri = "mongodb://localhost:27017/db";
  assert.equal(redactConnectionString(uri), uri);
});

test("redactConnectionString is a no-op on non-string input and doesn't throw", () => {
  assert.equal(redactConnectionString(undefined), undefined);
  assert.equal(redactConnectionString(null), null);
});

test("redactConnectionString hides credentials in PostgreSQL URIs (both postgres:// and postgresql://)", () => {
  assert.equal(
    redactConnectionString("postgres://alice:s3cr3t@db.example.net:5432/mydb"),
    "postgres://***:***@db.example.net:5432/mydb",
  );
  assert.equal(
    redactConnectionString("postgresql://alice:s3cr3t@db.example.net/mydb?sslmode=require"),
    "postgresql://***:***@db.example.net/mydb?sslmode=require",
  );
  assert.equal(redactConnectionString("postgres://tokenonly@host/db"), "postgres://***@host/db");
});

test("redactConnectionString hides credentials in MySQL URIs", () => {
  assert.equal(
    redactConnectionString("mysql://root:hunter2@127.0.0.1:3306/shop"),
    "mysql://***:***@127.0.0.1:3306/shop",
  );
  assert.equal(redactConnectionString("mysql://localhost:3306/shop"), "mysql://localhost:3306/shop");
});

test("redactText redacts pg/mysql URIs embedded inside a larger error message", () => {
  const msg = 'connection to server failed for postgres://admin:pw1@10.0.0.5/db and mysql://bob:pw2@10.0.0.6/db2 — retry';
  const redacted = redactText(msg);
  assert.equal(redacted.includes("pw1"), false);
  assert.equal(redacted.includes("pw2"), false);
  assert.match(redacted, /postgres:\/\/\*\*\*:\*\*\*@10\.0\.0\.5\/db/);
  assert.match(redacted, /mysql:\/\/\*\*\*:\*\*\*@10\.0\.0\.6\/db2/);
  assert.match(redacted, /retry/);
});

test("redactText finds and redacts a connection string embedded inside a larger error message", () => {
  const msg = 'connect ECONNREFUSED, tried mongodb://admin:hunter2@10.0.0.5:27017/db — check network';
  const redacted = redactText(msg);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("admin"), false);
  assert.match(redacted, /mongodb:\/\/\*\*\*:\*\*\*@10\.0\.0\.5:27017\/db/);
  assert.match(redacted, /check network/);
});
