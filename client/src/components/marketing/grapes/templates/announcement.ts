// Simple announcement — a clean, single-column notice. Restraint is the design.
import {
  brand,
  mjmlDoc,
  header,
  eyebrow,
  heading,
  paragraph,
  button,
  footer,
} from "./sections";
import type { StarterTemplate } from "./types";

function build(brandKey: string): string {
  const b = brand(brandKey);
  const sections = [
    header(b),
    eyebrow(b, "A quick note"),
    heading(b, "Training is moving to Thursdays", { size: 28 }),
    paragraph(
      b,
      `Hi {{first_name}}, from next week our midweek session shifts from Wednesday to <strong style="color:${b.heading};">Thursday, 6:00pm</strong>, same venue. Everything else stays the same.`,
    ),
    paragraph(
      b,
      "If Thursdays don't work for your family, just reply to this email and we'll sort something out. Thanks for rolling with it.",
      { padding: "14px 30px 0" },
    ),
    button(b, "See the updated schedule", "https://", { padding: "24px 30px 8px" }),
    footer(b),
  ].join("\n");

  return mjmlDoc(b, sections, "Midweek training moves to Thursdays from next week.");
}

export const announcementTemplate: StarterTemplate = {
  id: "simple-announcement",
  name: "Simple announcement",
  description: "A clean single-column notice for one clear message.",
  category: "announcement",
  brandKeys: "all",
  build,
};
