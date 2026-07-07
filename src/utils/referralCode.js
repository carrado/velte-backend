import crypto from 'crypto';

// Excludes visually-ambiguous characters (0/O, 1/I/L) since these codes are
// meant to be read aloud, texted, or retyped by hand, not just clicked as a
// link — a friend copying "VLT-O0O1" off a screenshot is a real failure mode.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

// Retries on the rare collision (~1 in 700M+ combinations per attempt) rather
// than trusting a single draw — the unique index on User.referralCode is the
// real guarantee; this just avoids a doomed-to-fail save on the unlucky hit.
export async function generateUniqueReferralCode(UserModel, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = randomCode();
    const existing = await UserModel.exists({ referralCode: code });
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique referral code after several attempts.');
}
