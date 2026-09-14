import type { SettingsService } from "../settings/service.js";
import type { EmailMessage, EmailPort } from "./port.js";
import { SmtpEmail } from "./smtp.js";

export type EmailScope = "tenant" | "platform" | "env";

export interface EmailConfig {
  smtpUrl: string;
  from: string;
  replyTo: string;
  usedScope: EmailScope;
}

export interface SettingsEmailDeps {
  settings: SettingsService;
  /** Environment fallback, used when neither the tenant nor the platform sets a value. */
  env: { smtpUrl?: string | undefined; from: string };
  /** Where a message goes when no SMTP URL is configured anywhere (console in dev, memory in tests). */
  fallback: EmailPort;
  /** Builds the transport for a URL; overridable in tests so nothing touches the network. */
  transportFor?: (url: string, from: string) => EmailPort;
}

/**
 * The email port the API and the worker both use (contract 19). Every send resolves
 * `email.smtpUrl`, `email.from` and `email.replyTo` from the settings chain — the message's
 * tenant first, then the platform — and falls back to the environment. Transports are cached
 * per resolved URL, so a tenant with its own SMTP does not rebuild one per message.
 */
export class SettingsEmail implements EmailPort {
  private cached: { url: string; port: EmailPort } | null = null;

  constructor(private readonly deps: SettingsEmailDeps) {}

  /** The configuration in effect for a tenant (or for the platform when no tenant is given). */
  async resolve(companyId?: string): Promise<EmailConfig> {
    const chain = companyId ? [{ scope: "tenant" as const, scopeId: companyId }] : [];
    const keys = ["email.smtpUrl", "email.from", "email.replyTo", "branding.emailSender"] as const;
    const resolved = await this.deps.settings.resolveDetailed([...keys], chain);
    const str = (key: (typeof keys)[number]): string => {
      const v = resolved[key]?.value;
      return typeof v === "string" ? v : "";
    };
    /** A key counts as configured only when some scope actually set it, not at its catalog default. */
    const setAt = (key: (typeof keys)[number]): string => (resolved[key]?.scope != null ? str(key) : "");
    const url = str("email.smtpUrl");
    const scopeOf = resolved["email.smtpUrl"]?.scope;
    return {
      smtpUrl: url || (this.deps.env.smtpUrl ?? ""),
      // email.from wins, then the deprecated branding.emailSender, then EMAIL_FROM.
      from: setAt("email.from") || setAt("branding.emailSender") || this.deps.env.from,
      replyTo: str("email.replyTo"),
      usedScope: url && (scopeOf === "tenant" || scopeOf === "platform") ? scopeOf : "env",
    };
  }

  async send(message: EmailMessage): Promise<void> {
    const config = await this.resolve(message.companyId);
    const out: EmailMessage = {
      ...message,
      from: message.from ?? config.from,
      ...((message.replyTo ?? config.replyTo) ? { replyTo: message.replyTo ?? config.replyTo } : {}),
    };
    await this.portFor(config).send(out);
  }

  private portFor(config: EmailConfig): EmailPort {
    if (!config.smtpUrl) return this.deps.fallback;
    if (this.cached?.url === config.smtpUrl) return this.cached.port;
    const build = this.deps.transportFor ?? ((url: string, from: string) => new SmtpEmail(url, from));
    const port = build(config.smtpUrl, config.from);
    const previous = this.cached?.port;
    if (previous instanceof SmtpEmail) previous.close();
    this.cached = { url: config.smtpUrl, port };
    return port;
  }
}
