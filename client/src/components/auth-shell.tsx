import type { ReactNode } from "react";

/**
 * The USG ram, for a LIGHT ground.
 *
 * 🔴 Do not go back to `/logos/united-sports-group.png` here. That file is the
 * WHITE master, and index.css was making it visible on a white page with a
 * `filter: invert() sepia() saturate() hue-rotate()` chain — which rendered a
 * neon electric blue, and is the one thing the USG brand hub explicitly
 * forbids ("Don't recolour the ram"). These files are recoloured through the
 * alpha channel from that master at 1024×1024, so the shape is exact and the
 * colour is flat.
 *
 * ⚠️ The brand hub (apps/usg-brand) says the mark is "white on dark grounds,
 * MIDNIGHT on light". Royal is what Daniel asked for on 2026-09-02 and is a
 * real USG token (#222A57); swap the line below for the midnight file to
 * follow the hub instead.
 */
const USG_MARK = "/logos/united-sports-group-royal.png";
// const USG_MARK = "/logos/united-sports-group-midnight.png";  // per the brand hub

/**
 * The frame around every signed-out screen: sign in, forgot password, reset
 * password.
 *
 * One component so the three cannot drift apart — before this they were three
 * copies of the same near-black `#02060E` page with slightly different padding,
 * and fixing one never fixed the others.
 *
 * The mark now points at a real recoloured asset (see USG_MARK above) rather
 * than relying on index.css's filter chain, so it is the right navy at any
 * size instead of a filter's approximation of it.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-muted/40 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-card border border-border flex items-center justify-center mx-auto mb-4 overflow-hidden shadow-sm">
            <img src={USG_MARK} alt="" className="w-9 h-9 object-contain" />
          </div>
          <h1
            className="text-xl font-semibold tracking-tight text-foreground"
            data-testid="text-login-title"
          >
            {title}
          </h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
        </div>

        <div className="rounded-2xl bg-card border border-border shadow-sm p-6">{children}</div>
      </div>
    </div>
  );
}
