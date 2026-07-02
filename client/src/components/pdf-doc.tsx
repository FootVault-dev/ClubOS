// Renders a PDF (all pages) to canvases with PDF.js, and lets the caller
// overlay absolutely-positioned children per page (for placing / filling
// fields). Each page is wrapped in a relative box sized to its display size,
// so overlays positioned with % coordinates map 1:1 to the page.
// Responsive: `width` is a MAX — pages shrink to the container (mobile-safe).
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageDim { w: number; h: number; scale: number }

export function PdfDoc({
  url,
  width = 760,
  renderOverlay,
  onReady,
}: {
  url: string;
  width?: number;
  renderOverlay?: (pageIndex: number, w: number, h: number) => ReactNode;
  onReady?: (numPages: number) => void;
}) {
  const [pages, setPages] = useState<PageDim[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pdfRef = useRef<any>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  // Fit to the container: display width = min(requested, container width).
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [containerW, setContainerW] = useState<number | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 50) setContainerW((cur) => (cur !== null && Math.abs(cur - w) < 2 ? cur : w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const displayW = containerW === null ? null : Math.min(width, containerW);

  // Load doc + compute per-page display dimensions (wait for the container
  // measurement so we never do a first paint at the wrong width).
  useEffect(() => {
    if (displayW === null) return;
    const w = displayW;
    let cancelled = false;
    setPages([]);
    setError(null);
    (async () => {
      try {
        const pdf = pdfRef.current ?? (await pdfjsLib.getDocument({ url, withCredentials: true } as any).promise);
        if (cancelled) return;
        pdfRef.current = pdf;
        const dims: PageDim[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const p = await pdf.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          const scale = w / vp.width;
          dims.push({ w, h: vp.height * scale, scale });
        }
        if (cancelled) return;
        setPages(dims);
        onReady?.(pdf.numPages);
      } catch (e: any) {
        if (!cancelled) setError("Couldn't load the document preview.");
      }
    })();
    return () => { cancelled = true; };
  }, [url, displayW]);

  // Paint each page onto its canvas (crisp via devicePixelRatio).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdf = pdfRef.current;
      if (!pdf) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let i = 0; i < pages.length; i++) {
        const canvas = canvasRefs.current[i];
        if (!canvas) continue;
        const p = await pdf.getPage(i + 1);
        const vp = p.getViewport({ scale: pages[i].scale * dpr });
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvas.style.width = `${pages[i].w}px`;
        canvas.style.height = `${pages[i].h}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        try { await p.render({ canvasContext: ctx, viewport: vp } as any).promise; } catch { /* re-render race */ }
        if (cancelled) return;
      }
    })();
    return () => { cancelled = true; };
  }, [pages]);

  return (
    <div ref={wrapRef} className="w-full">
      {error ? (
        <div className="text-center text-sm text-slate-400 py-10">{error} <a className="underline" href={url} target="_blank" rel="noreferrer">Open PDF</a></div>
      ) : !pages.length ? (
        <div className="text-center text-sm text-slate-400 py-10">Loading document…</div>
      ) : (
        <div className="space-y-4">
          {pages.map((pg, i) => (
            <div key={i} className="relative mx-auto bg-white shadow-md rounded overflow-hidden" style={{ width: pg.w, height: pg.h }}>
              <canvas ref={(el) => (canvasRefs.current[i] = el)} />
              <div className="absolute inset-0">{renderOverlay?.(i, pg.w, pg.h)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
