import test from "node:test";
import assert from "node:assert/strict";

import pool from "../db/database.js";
import {
  createInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
  InviteError,
  hashInviteToken,
} from "./inviteService.js";
import {
  createUser,
  findUserById,
  isDisabled,
  listUsers,
  setUserDisabled,
  UserError,
} from "./userService.js";
import { gateDb } from "../test/dbGate.js";

async function dbAvailable(): Promise<boolean> {
  try {
    const check = await pool.query(`SELECT to_regclass('public.invites') AS c`);
    return check.rows[0].c !== null;
  } catch {
    return false;
  }
}

function uniqueEmail(tag: string): string {
  return `phase-invite-${tag}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}@example.com`;
}

const createdUserIds: string[] = [];
const createdInviteIds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdInviteIds.length > 0) {
    await pool.query(`DELETE FROM invites WHERE id = ANY($1)`, [createdInviteIds]);
    createdInviteIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [createdUserIds]);
    createdUserIds.length = 0;
  }
}

async function makeAdmin(tag: string): Promise<string> {
  const user = await createUser({ email: uniqueEmail(tag), password: "correct-horse-123" });
  createdUserIds.push(user.id);
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [user.id]);
  return user.id;
}

test("invite stores only a peppered hash and the raw token is not persisted", async () => {
  if (!(await gateDb("services/inviteService.db.unit.test.ts", dbAvailable))) return;
  const adminId = await makeAdmin("hash");
  try {
    const { invite, token } = await createInvite(uniqueEmail("hash"), adminId);
    createdInviteIds.push(invite.id);
    assert.equal(invite.status, "pending");
    assert.equal(token.length, 64);
    const raw = (
      await pool.query(`SELECT token_hash FROM invites WHERE id = $1`, [invite.id])
    ).rows[0];
    assert.equal(raw.token_hash, hashInviteToken(token));
    assert.notEqual(raw.token_hash, token, "raw token must never be stored");
  } finally {
    await cleanup();
  }
});

test("redeeming an invite creates a member account and consumes the token once", async () => {
  if (!(await gateDb("services/inviteService.db.unit.test.ts", dbAvailable))) return;
  const adminId = await makeAdmin("redeem");
  const email = uniqueEmail("redeem");
  try {
    const { invite, token } = await createInvite(email, adminId);
    createdInviteIds.push(invite.id);

    const user = await redeemInvite({ token, email, password: "correct-horse-123" });
    createdUserIds.push(user.id);
    assert.equal(user.email, email.toLowerCase());
    assert.equal(user.role, "member");

    await assert.rejects(
      redeemInvite({ token, email, password: "correct-horse-123" }),
      (e: unknown) => e instanceof InviteError && e.code === "INVITE_USED"
    );

    const row = (
      await pool.query(`SELECT accepted_at FROM invites WHERE id = $1`, [invite.id])
    ).rows[0] as { accepted_at: string | null };
    assert.ok(row.accepted_at, "invite must be marked accepted");
    const listed = await listInvites();
    const found = listed.find((i) => i.id === invite.id);
    assert.equal(found?.status, "accepted");
  } finally {
    await cleanup();
  }
});

test("redeeming with a different email than the invite is refused", async () => {
  if (!(await gateDb("services/inviteService.db.unit.test.ts", dbAvailable))) return;
  const adminId = await makeAdmin("mismatch");
  try {
    const { invite, token } = await createInvite(uniqueEmail("mismatch"), adminId);
    createdInviteIds.push(invite.id);
    await assert.rejects(
      redeemInvite({ token, email: uniqueEmail("other"), password: "correct-horse-123" }),
      (e: unknown) => e instanceof InviteError && e.code === "INVITE_EMAIL_MISMATCH"
    );
  } finally {
    await cleanup();
  }
});

test("expired and revoked invites cannot be redeemed", async () => {
  if (!(await gateDb("services/inviteService.db.unit.test.ts", dbAvailable))) return;
  const adminId = await makeAdmin("expiry");
  try {
    const expired = await createInvite(uniqueEmail("expired"), adminId);
    createdInviteIds.push(expired.invite.id);
    await pool.query(`UPDATE invites SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [
      expired.invite.id,
    ]);
    await assert.rejects(
      redeemInvite({
        token: expired.token,
        email: expired.invite.email,
        password: "correct-horse-123",
      }),
      (e: unknown) => e instanceof InviteError && e.code === "INVITE_EXPIRED"
    );

    const revoked = await createInvite(uniqueEmail("revoked"), adminId);
    createdInviteIds.push(revoked.invite.id);
    await revokeInvite(revoked.invite.id);
    await assert.rejects(
      redeemInvite({
        token: revoked.token,
        email: revoked.invite.email,
        password: "correct-horse-123",
      }),
      (e: unknown) => e instanceof InviteError && e.code === "INVITE_REVOKED"
    );
  } finally {
    await cleanup();
  }
});

test("an unknown or empty invite token is refused", async () => {
  if (!(await gateDb("services/inviteService.db.unit.test.ts", dbAvailable))) return;
  await assert.rejects(
    redeemInvite({ token: "not-a-real-token", email: uniqueEmail("nope"), password: "correct-horse-123" }),
    (e: unknown) => e instanceof InviteError && e.code === "INVITE_INVALID"
  );
  await assert.rejects(
    redeemInvite({ token: "", email: uniqueEmail("nope2"), password: "correct-horse-123" }),
    (e: unknown) => e instanceof InviteError && e.code === "INVITE_REQUIRED"
  );
});

test("disabling a user blocks re-enable flows safely and self-disable is refused", async () => {
  if (!(await gateDb("services/inviteService.db.unit.test.ts", dbAvailable))) return;
  const adminId = await makeAdmin("disable");
  const memberId = await makeAdmin("disable-target");
  await pool.query(`UPDATE users SET role = 'member' WHERE id = $1`, [memberId]);
  try {
    const disabled = await setUserDisabled(memberId, true, adminId);
    assert.ok(disabled.disabled_at);
    const row = await findUserById(memberId);
    assert.ok(row && isDisabled(row));

    const enabled = await setUserDisabled(memberId, false, adminId);
    assert.equal(enabled.disabled_at, null);

    await assert.rejects(
      setUserDisabled(adminId, true, adminId),
      (e: unknown) => e instanceof UserError && e.code === "CANNOT_DISABLE_SELF"
    );

    const unknown = await makeAdmin("disable-unknown");
    await pool.query(`DELETE FROM users WHERE id = $1`, [unknown]);
    await assert.rejects(
      setUserDisabled("00000000-0000-4000-8000-000000000000", true, adminId),
      (e: unknown) => e instanceof UserError && e.code === "USER_NOT_FOUND"
    );
  } finally {
    await cleanup();
  }
});

test("the last active admin cannot be disabled", async () => {
  if (!(await gateDb("services/inviteService.db.unit.test.ts", dbAvailable))) return;
  const adminId = await makeAdmin("last-admin");
  // The guard counts every enabled admin in this shared test database, so park
  // any pre-existing ones for the duration of the assertion and always restore.
  const parked: string[] = [];
  try {
    const others = await pool.query(
      `SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> $1`,
      [adminId]
    );
    for (const row of others.rows as { id: string }[]) {
      parked.push(row.id);
      await pool.query(`UPDATE users SET disabled_at = NOW() WHERE id = $1`, [row.id]);
    }
    await assert.rejects(
      setUserDisabled(adminId, true, "11111111-1111-4111-8111-111111111111"),
      (e: unknown) => e instanceof UserError && e.code === "CANNOT_DISABLE_LAST_ADMIN"
    );
    // A second enabled admin lifts the guard.
    const second = await makeAdmin("last-admin-2");
    await setUserDisabled(adminId, true, second);
    const row = await findUserById(adminId);
    assert.ok(row && isDisabled(row));
    await setUserDisabled(adminId, false, second);
  } finally {
    if (parked.length > 0) {
      await pool.query(`UPDATE users SET disabled_at = NULL WHERE id = ANY($1)`, [parked]);
    }
    await cleanup();
  }
});

test("listUsers returns every account ordered oldest first", async () => {
  if (!(await gateDb("services/inviteService.db.unit.test.ts", dbAvailable))) return;
  try {
    const before = await listUsers();
    const first = await createUser({ email: uniqueEmail("list"), password: "correct-horse-123" });
    createdUserIds.push(first.id);
    const after = await listUsers();
    assert.equal(after.length, before.length + 1);
    assert.ok(after.every((u) => "role" in u && "disabled_at" in u));
    assert.deepEqual(
      after.map((u) => u.id),
      [...after].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)).map((u) => u.id)
    );
  } finally {
    await cleanup();
  }
});
