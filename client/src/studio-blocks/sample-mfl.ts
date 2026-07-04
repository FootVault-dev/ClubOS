// USG Studio — sample MFL PageDoc fixture (dev/QA only).
//
// A realistic Mini Football Leagues sponsorship proposal that exercises EVERY
// block type, rendered by /studio-preview through the exact same pipeline the
// public page uses — so the visual can be verified without the server.
import type { PageDoc } from "@shared/studio-blocks";

// Self-contained gradient tile so image blocks render without external assets.
const GRADIENT_TILE =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='900'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
      `<stop offset='0' stop-color='#171307'/><stop offset='1' stop-color='#0a0a0a'/></linearGradient></defs>` +
      `<rect width='1200' height='900' fill='url(#g)'/>` +
      `<circle cx='320' cy='260' r='420' fill='#D1B96E' opacity='0.14'/>` +
      `<circle cx='980' cy='760' r='360' fill='#E6D5A0' opacity='0.08'/></svg>`,
  );

export const SAMPLE_MFL_SOURCE_TAG = "mfl-sample-proposal";

export const sampleMflPageDoc: PageDoc = {
  meta: {
    title: "Mini Football Leagues — Partnership Proposal",
    seoDescription:
      "Back Christchurch's largest weekend kids' football league — thousands of local families, every Saturday, all season.",
  },
  blocks: [
    {
      type: "hero",
      id: "hero",
      eyebrow: "Prepared for a founding partner · Mini Football Leagues",
      headline: "Christchurch's biggest kids' league — and the **whole city is watching.**",
      subhead:
        "Every Saturday, hundreds of small-sided teams take the field across the city. It is the warmest weekly audience in Christchurch: local families, together, at their happiest. We'd like one brand to own it.",
    },
    {
      type: "section",
      id: "the-idea",
      heading: "Where a generation of Cantabrians **falls in love with the game.**",
      bodyMd:
        "Mini Football Leagues is small-sided football done properly — short seasons, close games, no travel, every child on the ball.\n\nIt is built for the families who want their kids **active, outdoors, and together** on a Saturday morning, without the cost and commitment of a traditional club. That is why it's grown so fast:\n\n- Fixed-fee teams, deposit-and-weekly payments\n- Every age group, every skill level\n- One venue, one morning, the whole community in one place",
    },
    {
      type: "stat_grid",
      id: "reach",
      stats: [
        { value: "50+", label: "teams every season" },
        { value: "600+", label: "kids on the ball weekly" },
        { value: "1,200+", label: "parents & whānau on the sideline" },
        { value: "4", label: "seasons a year — always on" },
      ],
    },
    {
      type: "proof",
      id: "why-it-works",
      heading: "A sponsorship that people actually **feel good about.**",
      items: [
        {
          label: "Warm, weekly, local",
          detail:
            "Not a billboard on the motorway — your brand in the middle of the happiest two hours of a family's week, every week of the season.",
        },
        {
          label: "The family decision-maker",
          detail:
            "Parents aged 30–45 making real household spending calls, met in a genuinely positive setting with no sales pitch attached.",
        },
        {
          label: "Grows as we grow",
          detail:
            "We're scaling from 50 toward 100+ teams. A founding partner is named on all of it, from the first whistle onward.",
        },
        {
          label: "Content that travels",
          detail:
            "Match-day photos and highlights shared by hundreds of families every weekend — your logo carried far beyond the field.",
        },
      ],
    },
    {
      type: "image_feature",
      id: "the-moment",
      imageRef: GRADIENT_TILE,
      heading: "Saturday morning, and the whole city shows up",
      bodyMd:
        "Pitches full. Parents with coffees on the sideline. Kids in your colours. This is the moment your brand gets to be part of — *the good kind of visible.*",
      caption: "Mini Football Leagues · match day",
    },
    {
      type: "quote",
      id: "voice",
      quote: "It's the one thing my two actually get out of bed for on a Saturday. The whole family goes.",
      attribution: "Sarah",
      role: "MFL parent, Riccarton",
    },
    {
      type: "deal_options",
      id: "deals",
      heading: "Three ways to **come on board.**",
      options: [
        {
          name: "Community",
          price: "$3,000 / yr",
          summary: "A genuine local presence, at an accessible entry point.",
          features: ["Logo on the league website", "Named in season emails", "Social thank-you posts", "Sideline signage"],
        },
        {
          name: "Club Partner",
          price: "$7,500 / yr",
          summary: "The default choice — real visibility, all season.",
          features: [
            "Everything in Community",
            "Logo on every team's shirt sleeve",
            "Branded match-day content",
            "A booth at finals day",
            "Quarterly performance recap",
          ],
        },
        {
          name: "Headline Partner",
          price: "Let's talk",
          summary: "Your name on the league. One partner only.",
          features: [
            "Everything in Club Partner",
            "“Mini Football Leagues, presented by you”",
            "Naming rights on all comms",
            "First right of renewal",
            "Co-created community campaign",
          ],
        },
      ],
    },
    {
      type: "logo_wall",
      id: "partners",
      heading: "In good company across United Sports Group",
      logoRefs: [
        "/logos/mini-football-leagues.png",
        "/logos/christchurch-united.png",
        "/logos/united-sports-group.png",
        "/logos/united-prints.png",
      ],
    },
    {
      type: "faq",
      id: "faq",
      items: [
        {
          q: "How long is the commitment?",
          a: "Partnerships run for a **season or a year** — your choice. Most partners start with one season and renew.",
        },
        {
          q: "Can we activate on match days?",
          a: "Yes. Booths, giveaways, and branded moments are all on the table — we'll help you make it land with families.",
        },
        {
          q: "What do we get to measure?",
          a: "Reach, match-day attendance, social impressions, and content shares — recapped for you each quarter.",
        },
      ],
    },
    {
      type: "cta",
      id: "cta",
      label: "Let's put your brand where **the city already is.**",
      sublabel:
        "A short, no-pressure conversation — we'll walk you through the numbers and where you'd fit. Online, or we'll come to you.",
      action: { kind: "book_meeting", ref: "daniel/intro-30" },
    },
  ],
};
