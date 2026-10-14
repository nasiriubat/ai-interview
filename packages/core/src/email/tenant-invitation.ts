export type EmailLanguage = "en" | "fi";

export interface TenantInvitationInput {
  language: EmailLanguage;
  companyName: string;
  /** The product name the tenant sees; "Discovery" until they change it. */
  productName: string;
  signInUrl: string;
}

/**
 * The mail a tenant's first admin receives when the operator creates the organization (D-189).
 * The sign-in link is the Auth.js magic-link entry for that address: no token is minted here, so
 * there is nothing in the mail that can be forwarded to become someone else's account.
 */
export function tenantInvitationEmail(i: TenantInvitationInput): { subject: string; text: string } {
  if (i.language === "fi") {
    return {
      subject: `Sinut on kutsuttu ylläpitäjäksi: ${i.companyName}`,
      text: [
        `Hei,`,
        ``,
        `${i.productName}-palveluun on luotu organisaatio "${i.companyName}", ja sinut on lisätty sen ylläpitäjäksi.`,
        ``,
        `Kirjaudu sisään tällä sähköpostiosoitteella: ${i.signInUrl}`,
        `Saat kirjautumislinkin sähköpostiisi. Sisäänkirjautumisen jälkeen etusivulla on aloitusopas, joka vie ensimmäiseen haastatteluun.`,
        ``,
        `Jos et odottanut tätä viestiä, voit jättää sen huomiotta.`,
      ].join("\n"),
    };
  }
  return {
    subject: `You have been invited as an admin: ${i.companyName}`,
    text: [
      `Hello,`,
      ``,
      `An organization called "${i.companyName}" has been created in ${i.productName}, and you were added as its admin.`,
      ``,
      `Sign in with this email address: ${i.signInUrl}`,
      `A sign-in link will be sent to your inbox. After you sign in, the dashboard has a getting-started card that leads to your first interview.`,
      ``,
      `If you were not expecting this message, you can ignore it.`,
    ].join("\n"),
  };
}
