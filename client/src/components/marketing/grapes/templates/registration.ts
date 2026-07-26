// Registration / Sign-ups open — punchy hero + benefits + big register CTA + urgency.
import {
  brand,
  mjmlDoc,
  header,
  eyebrow,
  heading,
  paragraph,
  leadLine,
  button,
  footer,
  escText,
} from "./sections";
import type { StarterTemplate } from "./types";

function build(brandKey: string): string {
  const b = brand(brandKey);

  // Urgency strip — a bordered accent note right under the CTA.
  const urgency = `    <mj-section background-color="${b.surface}" padding="14px 30px 0">
      <mj-column background-color="${b.bg}" border="1px solid ${b.accent}" border-radius="10px" padding="12px 18px">
        <mj-text color="${b.accent}" font-family="${b.font}" font-size="14px" font-weight="700" align="center" padding="0">Spots are limited — last term filled in under a week.</mj-text>
      </mj-column>
    </mj-section>`;

  const sections = [
    header(b),
    eyebrow(b, "Registrations are open"),
    heading(b, "Secure your spot for Term 3", { size: 31 }),
    paragraph(
      b,
      `{{first_name}}, sign-ups for the new term at ${escText(
        b.name,
      )} are live. Same great coaching, same friendly crew — now taking bookings.`,
    ),
    leadLine(b, "Small groups.", "Qualified coaches and real time on the ball for every player.", { padding: "16px 30px 0" }),
    leadLine(b, "Rain or shine.", "Indoor and covered pitches mean sessions still run, whatever the weather."),
    leadLine(b, "Two-minute sign-up.", "Easy online booking and payment. Done before the kettle boils."),
    button(b, "Register now", "https://", { padding: "24px 30px 0" }),
    urgency,
    footer(b),
  ].join("\n");

  return mjmlDoc(
    b,
    sections,
    `Term 3 sign-ups are open at ${b.name} — spots are limited.`,
  );
}

export const registrationTemplate: StarterTemplate = {
  id: "registration-open",
  name: "Registrations open",
  description: "Punchy sign-ups hero with benefits, a big register CTA and urgency.",
  category: "registration",
  brandKeys: "all",
  build,
};
