-- Staff offboarding (P10, D-161): a user can be disabled and deleted.
--
-- `disabledAt` withdraws access without losing history; `tokensValidAfter` is the revocation
-- watermark: the principal resolver refuses an Auth.js token whose `iat` is earlier, so a
-- 30-day session ends the moment a user is disabled, and stays ended if they are re-enabled.
-- Both are nullable and additive: the previous application version ignores them.
ALTER TABLE "User" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "tokensValidAfter" TIMESTAMP(3);
