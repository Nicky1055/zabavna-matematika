# Teacher isolation

## Deployment status: database applied, website not published

Applied to project nzbsbofuvdiyooqljlvv on 2026-08-31.
First executed the migration and 58 database assertions inside a ROLLBACK-only
transaction. Then repeated the assertions, rolled back the synthetic fixtures
to a savepoint, and committed only the migration.

The final counts remain 1 profile, 1 class, 9 students and 4 game results.
All 9 existing PINs were hashed. No synthetic auth users remain.
No real user was promoted, deleted or given a new password.

The browser website changes remain on feature/supabase-foundation. They have
NOT been merged into main or published to GitHub Pages. Deploy the updated
auth-service.js, db-service.js, access-control.js, teacher-panel.js and index.html
together. Older clients cannot use the removed direct student-table login or
direct result insertion. Students must sign in again after updating the website.

## Files

- security-audit.sql: read-only metadata audit; no student names or PIN values.
- audit-before-20260831.json: previous schema, policies, grants and functions.
- 20260831_teacher_isolation.sql: reviewed migration; run in a transaction.
- teacher-isolation-tests.sql: synthetic database fixtures and 58 assertions.
  NEVER run this file with an unqualified COMMIT; always roll back its fixtures.
- security-test-report-20260831.json: successful rollback-test report.
- deployment-report-20260831.json: successful deployment and unchanged row counts.

## Authorization

Teachers read and manage only classes whose teacher_id equals auth.uid().
Student and journal access follows the owner of the parent class.
Sharing a school name does not grant access to another teacher's data.
A typed school name is not independent proof of school membership.
Class creation uses the teacher's profile school.

Registration always creates a teacher, including when signup metadata requests
admin. Column privileges prevent changing role, profile ID, class owner or the
student's parent class. Administrative access requires an existing database role;
only a trusted database administrator can assign it, never the registration form.

Anonymous clients cannot query profiles, classes, students or game_results
directly. The health RPC replaces the former anonymous classes SELECT.
The old public permissive policies were removed, not combined with new ones.

## Student login

The exact class code permits only the minimal class/active roster lookup needed
by the existing login screen. Treat this code as private classroom information;
anyone who knows it can see that roster, but not PINs, hashes or the journal.

Four-digit PINs are verified on the server, stored as bcrypt hashes (cost 10),
and never readable through the browser API, including by teachers.
Five failed PIN attempts lock that pupil's login for 15 minutes. This limits
guessing, but also means a person knowing the class code could temporarily lock
a pupil out. A trusted administrator can reset the counter or the teacher can
set a new PIN through authorized database operations; there is no reset UI yet.

A successful login issues a random 256-bit bearer token valid for 12 hours.
Only its SHA-256 hash is stored in math_private.student_sessions. This private
schema is not intended for exposure through the Data API; clients have no table
privileges even if it were exposed accidentally.
The existing mathStudentSession key now includes sessionToken and expiresAt.
Old unsigned sessions are discarded. Do not log or share bearer tokens.
A PIN change, student deletion or logout revokes the corresponding tokens.
An offline logout clears the browser immediately; if revocation cannot reach
the server, the token remains valid until expiry. No token is placed in URLs.

Result RPCs derive student_id, class_id and student_name from the verified token,
not supplied browser IDs. They validate the seven game keys and numeric ranges.
This enforces identity/ownership, not anti-cheat verification of answers: game
logic is still client-side. Guests remain local-only. Network failures preserve
mathLog; automatic retry of missed uploads is not implemented.

## Verification

The 58 SQL checks run under real PostgreSQL anon/authenticated roles using
synthetic JWT subject settings, two teachers from the same school and an admin.
They are database-policy tests, not password-based browser logins.
They cover own/cross-class CRUD, profile privilege escalation, anonymous reads,
PIN hashing/guessing, token expiry/revocation and all seven result keys.

The 63 Node tests cover UI ownership guards, stale responses after logout/class
changes, session restoration, all seven Home flows, timers/audio cleanup,
local journal preservation and the restricted RPC contract. Run:

    node --test tests/teacher-ownership.test.cjs tests/student-session.test.cjs tests/teacher-logout.test.cjs tests/game-home.test.cjs

These Node tests use fakes and do not replace the SQL checks.
Local file navigation was blocked by the browser's security policy, so no
end-to-end browser test of a real teacher login was claimed.

## Recovery

The audit is metadata, not a complete data backup. Keep a database backup
before further schema changes. Git rollback does not revert Supabase.
PIN hashing is intentionally one-way: do not restore the insecure direct-table
login or broad policies. If an issue appears, correct it with a new reviewed
migration, keeping RLS and restricted grants in place.
