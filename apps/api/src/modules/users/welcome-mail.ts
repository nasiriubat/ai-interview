import type { EmailMessage } from "@aidp/core";

/**
 * The email a person gets when an admin adds them (simulation 2026-10-15). It carries no token:
 * it says where to sign in, and sign-in itself sends the one-time link, so a forwarded or stale
 * copy of this message opens nothing.
 */
export function userAddedMessage(input: {
  to: string;
  companyId: string;
  productName: string;
  organization: string;
  role: string;
  addedBy: string | null;
  webUrl: string;
}): EmailMessage {
  const product = input.productName.trim() || "Discovery";
  const signIn = `${input.webUrl.replace(/\/+$/, "")}/auth/signin`;
  const who = input.addedBy ? `${input.addedBy} added you` : "You have been added";
  const role = input.role === "admin" ? "an administrator" : "a member";
  return {
    to: input.to,
    companyId: input.companyId,
    subject: `You have been added to ${product}`,
    text: [
      `${who} to ${product} for ${input.organization}, as ${role}.`,
      "",
      `Sign in with this email address at ${signIn}`,
      "",
      "There is no password: each time you sign in, a one-time link is emailed to you.",
      "If you did not expect this, you can ignore this email.",
      "",
    ].join("\n"),
  };
}
