import type { ReactNode } from "react";

/**
 * The frame around every signed-out screen: sign in, forgot password, reset
 * password.
 *
 * One component so the three cannot drift apart — before this they were three
 * copies of the same near-black `#02060E` page with slightly different padding,
 * and fixing one never fixed the others.
 *
 * The mark is the USG ram, which is WHITE artwork on transparency. On a light
 * page it would be invisible, so index.css repaints it in the brand blue via a
 * filter chain solved to land exactly on --primary. That rule keys on the
 * image's src, which is why this uses the same path as the sidebar.
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
            <img
              src="/logos/united-sports-group.png"
              alt=""
              className="w-9 h-9 object-contain"
            />
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
