/**
 * Break-glass sign-in link, for a person with a shell on the server (D-440).
 *
 *   deploy/signin-link.sh admin@example.com                       # production, wraps the line below
 *   deploy/dc exec api node apps/api/dist/cli/signin-link.js admin@example.com
 *   pnpm signin-link admin@example.com                            # development, reads the root .env
 *
 * Prints one sign-in URL, valid once and for 15 minutes, for an existing, enabled staff user whose
 * tenant is active, and nothing else that is secret. Everything that is not the URL goes to stderr,
 * so `url=$(... signin-link.js x@y)` captures the link alone. The issue is recorded in the audit log
 * (`auth.signin_link_issued`, actor `cli`) and as a warning line here.
 *
 * Exit status: 0 issued, 1 refused (unknown, disabled, suspended), 2 usage or configuration.
 */
import { withTenantScope } from "@aidp/db";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { issueSigninLink, REFUSAL_TEXT, SIGNIN_LINK_AUDIT_ACTION } from "../modules/internal-auth/signin-link.js";

// Only what this needs, so a missing variable the server needs and this does not (the encryption
// key, say) does not stand between a locked-out operator and their link.
const Env = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(16),
  PUBLIC_WEB_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
});

function warn(msg: string, fields: Record<string, unknown>): void {
  // A pino-shaped line (level 40 is warn) on stderr, so log tooling reads it like the server's own.
  process.stderr.write(`${JSON.stringify({ level: 40, time: Date.now(), name: "signin-link", ...fields, msg })}\n`);
}

async function main(argv: string[]): Promise<number> {
  const email = argv[0];
  if (!email || argv.length !== 1 || email.startsWith("-")) {
    process.stderr.write("usage: signin-link <email>\n");
    return 2;
  }
  const env = Env.safeParse(process.env);
  if (!env.success) {
    // Names only, never values.
    const names = [...new Set(env.error.issues.map((i) => i.path.join(".")))].join(", ");
    process.stderr.write(`signin-link: missing or invalid configuration: ${names}\n`);
    return 2;
  }

  const db = withTenantScope(new PrismaClient());
  try {
    const result = await issueSigninLink(db, {
      email,
      authSecret: env.data.AUTH_SECRET,
      webUrl: env.data.PUBLIC_WEB_URL,
    });
    if (!result.ok) {
      process.stderr.write(`signin-link: refused: ${REFUSAL_TEXT[result.reason]}\n`);
      return 1;
    }
    warn("break-glass sign-in link issued from the command line", {
      event: SIGNIN_LINK_AUDIT_ACTION,
      userId: result.userId,
      companyId: result.companyId,
      role: result.role,
      expires: result.expires.toISOString(),
    });
    process.stderr.write(
      `signin-link: one-time link for a ${result.role}, valid until ${result.expires.toISOString()} ` +
        "(15 minutes, single use). Open it in the browser that should be signed in; do not share it.\n",
    );
    process.stdout.write(`${result.url}\n`);
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // The message, not the stack's locals: a Prisma error names the host, never the password.
    process.stderr.write(`signin-link: failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
