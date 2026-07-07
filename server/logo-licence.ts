// Canonical Club Logo Licence — the SINGLE SOURCE OF TRUTH for the licence a
// participating club grants us to display its crest. The public agreement page
// (cicyouth.com/club-logo-agreement) fetches this text from the API and renders
// it verbatim; the signed-PDF proof (logo-licence-pdf.ts) and the confirmation
// emails are built from the SAME object — so what a club reads, what we archive,
// and what we can show an App Store / Play reviewer can never diverge.
//
// v2.0 (2026-07-07): maximum-rights, NON-exclusive grant. Perpetual, irrevocable,
// worldwide, royalty-free, sub-licensable, across every medium and every USG
// brand — future-proofed for app, website, print/signage and merchandise. Kept
// NON-exclusive by design: the club keeps full use of its own crest (an exclusive
// grant would bar them from using their own badge and kill adoption).

export interface LicenceClause {
  h: string; // heading
  p: string; // plain-English clause
}

export interface LogoLicence {
  version: string;
  title: string;
  intro: string;
  clauses: LicenceClause[];
  signAck: string;
  governingLaw: string;
}

export const CURRENT_LOGO_LICENCE: LogoLicence = {
  version: "2.0",
  title: "Club Crest & Logo Licence",
  intro:
    "This licence lets us proudly feature your club across the Christchurch International Cup and the wider United Sports Group — on our websites, apps, print, signage and merchandise. Please review the short terms below and sign.",
  clauses: [
    {
      h: "What you're granting",
      p: "You grant Christchurch United Football Club Incorporated and its related clubs, brands and affiliated entities — including the Christchurch International Cup, Christchurch United FC, South Island United, Mini Football Leagues, United Print and United Sports Group (\"we\", \"us\", \"our\") — a perpetual, irrevocable, worldwide, royalty-free, non-exclusive and sub-licensable licence to use, reproduce, display, publish, adapt and resize your club's name, crest, logo and related marks (your \"Marks\").",
    },
    {
      h: "Where we can use them",
      p: "We may use your Marks in any media, whether now known or developed in the future — including our websites and mobile apps, printed materials and signage, merchandise and physical or digital products, social media, advertising, marketing and communications, and broadcast or audiovisual content — for current and future editions of our tournaments, programmes and products.",
    },
    {
      h: "Sub-licensing so we can deliver",
      p: "We may sub-license your Marks to our service providers — such as printers, manufacturers, software platforms, app stores and media partners — solely so they can produce, host or display the materials described above on our behalf.",
    },
    {
      h: "Adapting for a clean fit",
      p: "So your crest always looks its best, you allow us to resize it, place it on different backgrounds and make minor adaptations for legibility and layout. We will not redraw or alter your Marks in a way that misrepresents your club.",
    },
    {
      h: "You keep full use of your own crest",
      p: "This licence is non-exclusive. You remain completely free to use your own Marks however you wish and to license them to anyone else. Nothing here transfers ownership — your club continues to own its Marks at all times.",
    },
    {
      h: "Your assurances",
      p: "You confirm that your club owns its Marks, or is authorised to license them, and that you are authorised to grant this licence on your club's behalf.",
    },
    {
      h: "Respectful use",
      p: "We will display your Marks respectfully. We will not use them to disparage your club, or to imply any endorsement, partnership or affiliation beyond what is genuinely true.",
    },
    {
      h: "Perpetual & irrevocable",
      p: "This licence is perpetual and irrevocable, so we can keep featuring your club across current and future editions without needing to ask again. If you'd ever prefer we stopped featuring your crest in a particular place, just email info@cicyouth.com and we'll do our best as a matter of goodwill — but materials already produced, such as printed signage or merchandise, may remain in use.",
    },
    {
      h: "No fee",
      p: "This licence is granted free of charge, is the entire agreement between us about your Marks, and is governed by the laws of New Zealand.",
    },
  ],
  signAck:
    "By typing my name and submitting this form, I am signing this agreement electronically under the Contract and Commercial Law Act 2017. I confirm I have read and agree to the licence above, and that the details I have provided are correct. The date, time and my device details are recorded as proof of agreement.",
  governingLaw:
    "Electronic signature under the Contract and Commercial Law Act 2017 (New Zealand). This record — the agreed licence text, the signatory's typed signature, and the timestamp, IP address and device recorded at the moment of signing — is retained by Christchurch United Football Club Incorporated as evidence that permission was granted to display the club's marks.",
};

// Canonical string hashed at signing time → an immutable fingerprint of exactly
// what this signatory agreed to. Any later change to the stored fields or the
// licence text produces a different hash, which is what makes the PDF defensible.
export function canonicalConsentText(input: {
  licenceVersion: string;
  clubName: string;
  repName: string;
  repRole?: string | null;
  repEmail: string;
  agreedAtIso: string;
}): string {
  const l = CURRENT_LOGO_LICENCE;
  const body = l.clauses.map((c) => `${c.h}\n${c.p}`).join("\n\n");
  return [
    `CLUB CREST & LOGO LICENCE v${input.licenceVersion}`,
    l.intro,
    body,
    l.signAck,
    `Club: ${input.clubName}`,
    `Signed by: ${input.repName}${input.repRole ? ` (${input.repRole})` : ""}`,
    `Email: ${input.repEmail}`,
    `Signed at: ${input.agreedAtIso}`,
  ].join("\n\n");
}
