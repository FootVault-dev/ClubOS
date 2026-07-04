// USG Studio — BlockRenderer.
//
// Maps each block to its component and wraps it in an element carrying
// `data-block-id={block.id}` — the stable anchor the Signal beacon uses for
// per-section dwell (IntersectionObserver over `[data-block-id]`) and that
// studio_analytics_events.block_id points at. Also drives the scroll-reveal:
// it observes `.s-reveal` descendants and adds `.is-in` as they enter view.
import { useEffect, useRef, type ComponentType } from "react";
import type { Block } from "@shared/studio-blocks";
import { BLOCK_COMPONENTS, StudioSourceContext } from "./blocks";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function BlockRenderer({
  blocks,
  sourceTag = "studio",
  flat = false,
}: {
  blocks: Block[];
  sourceTag?: string;
  /** QA/preview: reveal everything immediately (also honoured via reduced-motion) */
  flat?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(".s-reveal"));

    if (flat || prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }

    // Anything already on-screen at mount reveals right away.
    els.forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add("is-in");
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 },
    );
    els.forEach((el) => {
      if (!el.classList.contains("is-in")) io.observe(el);
    });
    return () => io.disconnect();
  }, [blocks, flat]);

  return (
    <StudioSourceContext.Provider value={sourceTag}>
      <div ref={rootRef}>
        {blocks.map((block) => {
          const Cmp = BLOCK_COMPONENTS[block.type] as ComponentType<{ block: Block }>;
          return (
            <div key={block.id} data-block-id={block.id} data-block-type={block.type}>
              <Cmp block={block} />
            </div>
          );
        })}
      </div>
    </StudioSourceContext.Provider>
  );
}
