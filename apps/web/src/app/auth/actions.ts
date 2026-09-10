"use server";

import { signIn } from "@/auth";

function safeCallback(raw: FormDataEntryValue | null): string {
  const v = typeof raw === "string" ? raw : "";
  return v.startsWith("/") && !v.startsWith("//") ? v : "/admin";
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  await signIn("google", { redirectTo: safeCallback(formData.get("callbackUrl")) });
}

export async function signInWithEmail(formData: FormData): Promise<void> {
  const email = formData.get("email");
  if (typeof email !== "string" || !email) return;
  await signIn("nodemailer", { email, redirectTo: safeCallback(formData.get("callbackUrl")) });
}
