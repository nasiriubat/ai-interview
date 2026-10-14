/**
 * The login role every test connects as, and its password.
 *
 * Tests need to run as an unprivileged role so row-level security is engaged. The product's own
 * role, `app_api`, is cluster-wide, and the tests used to log it in with `ALTER ROLE app_api ...
 * PASSWORD`. That breaks anyone else on the same Postgres cluster: the demo stack and the live-run
 * harness bootstrap set the same role's password too, and whichever ran last won. The loser's next
 * connection failed with P1000 (authentication failed), in the middle of a suite, depending on
 * scheduling (seen as 500s from voice suites during a gate run while a demo stack was up).
 *
 * The tests now own a role of their own, a member of `app_api`: it inherits the grants, and the
 * policies (`TO app_api`) apply to its members, so row-level security is engaged exactly as for the
 * product's role, and nothing but the tests ever sets its password.
 */
export const APP_ROLE_TEST_USER = "aidp_test_app";
export const APP_ROLE_TEST_PASSWORD = "aidp-test-app-role";

interface RawExecutor {
  $executeRawUnsafe(sql: string): Promise<unknown>;
}

/**
 * Makes sure the test login role exists. Idempotent and safe to run from several suites at once:
 * two suites creating it in the same instant make one of them fail with a duplicate, which is
 * repeated and then finds the role there.
 */
export async function setAppRolePassword(owner: RawExecutor): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await owner.$executeRawUnsafe(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE_TEST_USER}') THEN
             CREATE ROLE ${APP_ROLE_TEST_USER} LOGIN PASSWORD '${APP_ROLE_TEST_PASSWORD}' IN ROLE app_api;
           END IF;
         END $$`,
      );
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  throw last;
}

/** The owner connection string with the test login role swapped in. */
export function appRoleUrl(ownerUrl: string): string {
  const u = new URL(ownerUrl);
  u.username = APP_ROLE_TEST_USER;
  u.password = APP_ROLE_TEST_PASSWORD;
  return u.toString();
}
