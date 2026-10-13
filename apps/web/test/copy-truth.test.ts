import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { fi } from "@/i18n/fi";

/*
 * The participant copy must promise only what the implementation does (copy audit section 0).
 * These are the facts the old strings got wrong; they are checked in both locales so a later copy
 * pass cannot quietly reintroduce them.
 */
const locales = { en, fi } as const;

describe.each(Object.entries(locales))(
  "participant copy (%s) matches the implementation",
  (_name, strings) => {
    const p = strings.participant;

    it("does not promise a deletion email, which is not sent", () => {
      const text = [p.session.deletedBody, p.session.deletedTitle].join(" ");
      expect(text).not.toMatch(/email|sähköposti|vahvistus/i);
    });

    it("does not say nothing leaves the organization (model providers process the answers)", () => {
      const text = [
        p.arrival.storedIdentified,
        p.arrival.storedAnonymous,
        p.arrival.storedChoice,
        p.invite.stored,
      ].join(" ");
      expect(text).not.toMatch(/outside your organization|outside their organization|ulkopuolelle/i);
    });

    it("scopes deletion to answers, recordings and files, not everything or all data", () => {
      const text = [
        p.session.deleteTitle,
        p.session.deleteBody,
        p.session.deletedTitle,
        p.arrival.deletePromise,
      ].join(" ");
      expect(text).not.toMatch(
        /everything you said|kaiken sanomasi|kaikki sanomasi|your data was deleted|tietosi on poistettu/i,
      );
    });
  },
);

describe("what is kept, in both locales", () => {
  it("names who may read identified answers, the AI services, and the retention", () => {
    expect(en.participant.arrival.storedIdentified).toMatch(/admins can read/);
    expect(en.participant.arrival.storedIdentified).toMatch(/AI services/);
    expect(en.participant.arrival.storedIdentified).toMatch(/retention period/);
    expect(fi.participant.arrival.storedIdentified).toMatch(/ylläpitäjät voivat lukea/);
    expect(fi.participant.arrival.storedIdentified).toMatch(/tekoälypalvelut/);
    expect(fi.participant.arrival.storedIdentified).toMatch(/säilytysajan/);
  });

  it("anonymous copy also names the AI services and the retention", () => {
    expect(en.participant.arrival.storedAnonymous).toMatch(/AI services/);
    expect(en.participant.arrival.storedAnonymous).toMatch(/retention period/);
    expect(fi.participant.arrival.storedAnonymous).toMatch(/tekoälypalvelut/);
    expect(fi.participant.arrival.storedAnonymous).toMatch(/säilytysajan/);
  });
});
