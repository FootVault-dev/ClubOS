// USG Studio — public proposal page. Route: /p/:token (no auth).
//
// Fetches GET /api/public/studio/:token → { brandId, sourceTag, content } and
// renders the PageDoc through <BrandTheme> + <BlockRenderer>, then starts the
// Signal tracker. Mirrors the fetch-by-token structure of sign.tsx / sign-native.
import { useEffect } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { PageDoc } from "@shared/studio-blocks";
import { BrandTheme } from "@/studio-blocks/theme";
import { BlockRenderer } from "@/studio-blocks/BlockRenderer";
import { startStudioTracking } from "@/lib/studio-track";

// Response contract the SERVER increment must satisfy for GET /api/public/studio/:token
export interface StudioPublicResponse {
  brandId: string;
  sourceTag: string;
  content: PageDoc;
}

function isFlatMode(): boolean {
  if (typeof window === "undefined") return false;
  const qs = new URLSearchParams(window.location.search);
  return qs.has("flat") || qs.has("preview");
}

function setMetaDescription(desc?: string) {
  if (typeof document === "undefined" || !desc) return;
  let tag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = "description";
    document.head.appendChild(tag);
  }
  tag.content = desc;
}

/**
 * The rendered document — shared by the public page and the dev preview so both
 * go through the identical pipeline (theme → blocks → tracker).
 */
export function StudioDocument({
  brandId,
  sourceTag,
  doc,
  token,
  track = true,
  internal = false,
}: {
  brandId: string;
  sourceTag: string;
  doc: PageDoc;
  token: string;
  track?: boolean;
  internal?: boolean;
}) {
  const flat = isFlatMode();

  useEffect(() => {
    if (doc.meta?.title) document.title = doc.meta.title;
    setMetaDescription(doc.meta?.seoDescription);
  }, [doc]);

  useEffect(() => {
    if (!track || !token) return;
    const stop = startStudioTracking({ token, sourceTag, internal });
    return stop;
  }, [track, token, sourceTag, internal]);

  return (
    <BrandTheme brand={brandId} flat={flat}>
      <BlockRenderer blocks={doc.blocks} sourceTag={sourceTag} flat={flat} />
    </BrandTheme>
  );
}

function StudioState({ title, sub }: { title: string; sub?: string }) {
  return (
    <BrandTheme brand="nexus-dark" grain={false} flat>
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <span className="s-eyebrow is-gold">USG Studio</span>
        <h1 className="s-display mt-4 text-2xl font-semibold text-white">{title}</h1>
        {sub ? <p className="mt-2 text-sm text-neutral-400">{sub}</p> : null}
      </div>
    </BrandTheme>
  );
}

export default function StudioPublicPage() {
  const [, params] = useRoute("/p/:token");
  const token = params?.token ?? "";

  const { data, isLoading, isError } = useQuery<StudioPublicResponse>({
    // default queryFn joins the key with "/" → GET /api/public/studio/:token
    queryKey: ["/api/public/studio", token],
    enabled: !!token,
  });

  if (isLoading) return <StudioState title="Loading…" />;
  if (isError || !data) return <StudioState title="This page isn't available" sub="The link may be expired or incorrect." />;

  return (
    <StudioDocument brandId={data.brandId} sourceTag={data.sourceTag} doc={data.content} token={token} />
  );
}
