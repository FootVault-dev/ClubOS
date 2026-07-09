// Welcome — warm intro + "what to expect" + a get-started CTA.
import {
  brand,
  mjmlDoc,
  header,
  eyebrow,
  heading,
  paragraph,
  leadLine,
  button,
  divider,
  footer,
  escText,
} from "./sections";
import type { StarterTemplate } from "./types";

function build(brandKey: string): string {
  const b = brand(brandKey);
  const sections = [
    header(b),
    eyebrow(b, "Welcome to the club"),
    heading(b, "Great to have you with us, {{first_name}}", { size: 28 }),
    paragraph(
      b,
      `You're officially part of ${escText(
        b.name,
      )}. We're a Christchurch club built on turning up, working hard and looking after each other — on and off the pitch. Here's what happens next.`,
    ),
    divider(b),
    leadLine(b, "Your first session.", "We'll email the where and when a few days out. Just bring boots, a drink and a smile."),
    leadLine(b, "Stay in the loop.", "Team updates, fixtures and the odd bit of good news land in your inbox — never spam."),
    leadLine(b, "Meet the crew.", "Coaches and staff who actually know your name. Reply to this email any time with a question."),
    button(b, "Get started", "https://", { padding: "26px 30px 8px" }),
    footer(b),
  ].join("\n");

  return mjmlDoc(b, sections, `Welcome to ${b.name} — here's what happens next.`);
}

export const welcomeTemplate: StarterTemplate = {
  id: "welcome-intro",
  name: "Welcome",
  description: "Warm welcome for a new member with what-to-expect and a CTA.",
  category: "welcome",
  brandKeys: "all",
  build,
};
