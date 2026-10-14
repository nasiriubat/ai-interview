import type { EmailMessage } from "./port.js";

/** What the worker needs to word the confirmation; no transcript, no address. */
export interface DeletionNoticeInput {
  to: string;
  companyId: string;
  campaignName: string;
  /** ISO 639-1 code of the interview's language. Anything but Finnish is sent in English. */
  language: string;
  deletedAt: Date;
}

/**
 * The deletion confirmation an identified participant is mailed after "delete my data" (FR-13,
 * D-175). It says what was deleted and when and that nothing else will be sent: no session id, no
 * excerpt, nothing that a mailbox owner other than the participant could learn from it.
 */
export function deletionNotice(input: DeletionNoticeInput): EmailMessage {
  const fi = input.language.toLowerCase().startsWith("fi");
  const day = input.deletedAt.toISOString().slice(0, 10);
  return fi
    ? {
        to: input.to,
        companyId: input.companyId,
        subject: `Vastauksesi on poistettu: ${input.campaignName}`,
        text: `Vastauksesi, äänitteesi ja tiedostosi haastattelussa "${input.campaignName}" poistettiin ${day}.\n\nTämä on ainoa viesti, jonka lähetämme asiasta.`,
      }
    : {
        to: input.to,
        companyId: input.companyId,
        subject: `Your answers were deleted: ${input.campaignName}`,
        text: `Your answers, recordings and files in "${input.campaignName}" were deleted on ${day}.\n\nThis is the only message we will send about it.`,
      };
}
