import type { Persona } from "./personas.js";

/**
 * Nine fictional employees of one fictional clinic network, three per department, so the
 * department comparison has groups that clear the k-anonymity threshold. Names are invented.
 */
const r = (
  id: string,
  name: string,
  role: string,
  department: string,
  participation: Persona["participation"],
  widgets: Persona["widgets"],
  sheet: string,
  style: string,
): Persona => ({ id, name, role, department, participation, widgets, sheet, style });

const RECEPTION =
  "Front desk of a clinic in a regional clinic network. Patients book by phone, by web form and at the " +
  "desk; the three channels land in different places, so bookings are re-typed into the appointment " +
  "system (Medigrid) from a shared inbox and a paper diary. Each day starts with printing the day list and " +
  "ends with phoning no-shows. Reminder texts are sent by hand from a spreadsheet. Referral letters " +
  "arrive by fax and post and are scanned, renamed by hand and attached to the patient record. ";
const BILLING =
  "Billing office of a regional clinic network. Visits are exported from the appointment system to a " +
  "spreadsheet, corrected by hand and re-keyed into the invoicing system (Ledgerline). Insurer claims " +
  "are rejected for missing codes and are chased by email; a Thursday spreadsheet tracks open claims. " +
  "Month end means reconciling payments from three bank files in Excel. Duplicate invoices slip through. ";
const NURSING =
  "Nursing team in a clinic of a regional clinic network. Notes are written on paper during the " +
  "consultation and typed into the record system (Medigrid) afterwards, 20 to 30 minutes a day. Supplies " +
  "are counted by hand on Fridays and ordered through a paper form that the office enters. Room turnover " +
  "between patients is coordinated by shouting down the corridor. Shift handover is verbal plus a " +
  "printed list that is out of date. ";

export const DEMO_PERSONAS: Persona[] = [
  r(
    "rec_1",
    "Aino Laine",
    "Receptionist",
    "Front desk",
    "identified",
    "sometimes",
    RECEPTION + "Re-keys about 40 bookings a day.",
    "Friendly, quick, concrete, uses numbers.",
  ),
  r(
    "rec_2",
    "Mikko Heinonen",
    "Receptionist",
    "Front desk",
    "anonymous",
    "always",
    RECEPTION + "Does the no-show phone round, about 12 calls a day, and scans referrals.",
    "Dry, matter of fact.",
  ),
  r(
    "rec_3",
    "Sanna Rinne",
    "Front desk coordinator",
    "Front desk",
    "anonymous",
    "sometimes",
    RECEPTION + "Owns the reminder spreadsheet and covers three clinics when staff are away.",
    "Organised, a little tired.",
  ),
  r(
    "bil_1",
    "Tuomas Kallio",
    "Billing clerk",
    "Billing",
    "anonymous",
    "always",
    BILLING + "Handles 50 to 70 invoices a day.",
    "Precise, likes numbers.",
  ),
  r(
    "bil_2",
    "Hanna Mäkelä",
    "Claims specialist",
    "Billing",
    "identified",
    "sometimes",
    BILLING + "Spends about 6 hours a week chasing rejected claims.",
    "Patient, thorough, mildly sarcastic about forms.",
  ),
  r(
    "bil_3",
    "Pekka Niemi",
    "Finance controller",
    "Billing",
    "anonymous",
    "never",
    BILLING + "Reviews the month-end close and fears errors in the reconciliations.",
    "Measured, senior, short answers.",
  ),
  r(
    "nur_1",
    "Elina Saarinen",
    "Registered nurse",
    "Nursing",
    "identified",
    "sometimes",
    NURSING + "Types up notes for about 25 minutes after each session.",
    "Warm, practical.",
  ),
  r(
    "nur_2",
    "Jari Koivisto",
    "Practice nurse",
    "Nursing",
    "anonymous",
    "always",
    NURSING + "Does the Friday stock count, about 90 minutes.",
    "Direct, humorous.",
  ),
  r(
    "nur_3",
    "Outi Lehto",
    "Nurse lead",
    "Nursing",
    "anonymous",
    "sometimes",
    NURSING + "Writes the handover list and the rota changes.",
    "Calm, experienced, a little guarded.",
  ),
];
