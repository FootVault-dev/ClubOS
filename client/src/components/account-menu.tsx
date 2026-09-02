import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { User, Bell, Settings, Users, Globe, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useWorkspace } from "@/lib/workspace-context";
import { canAccessTab } from "@shared/tabs";
import { ACCOUNT_PERSONAL_ITEMS, accountAdminItems } from "@/lib/account-nav";

/**
 * The account menu — top-right, the SaaS convention.
 *
 * Replaces the old sidebar footer, which carried the user's name, a theme
 * toggle and a logout icon, and which put "who am I" in the one corner of the
 * screen nobody looks for it. Profile, Notifications, Settings, Team and
 * Domains all moved here from the sidebar's System section (Daniel,
 * 2026-09-02) — they are things you configure occasionally, not things you
 * work in, and eleven items in a sidebar is a cluttered sidebar.
 *
 * 🔴 Moving an item out of the sidebar must never widen who can reach it.
 * The admin items are filtered by the SAME `canAccessTab` call the sidebar
 * used, on the same tab slugs. The personal items (Profile, Notifications)
 * carry no tab gate because they never had one — they belong to the person
 * and their routes are requireAuth-only server-side.
 *
 * The theme toggle is deliberately absent: ClubOS admin is light only. See
 * lib/theme-provider.tsx for how to bring it back.
 */

const ICONS: Record<string, typeof User> = {
  Profile: User,
  Notifications: Bell,
  Settings: Settings,
  Team: Users,
  Domains: Globe,
};

export function AccountMenu() {
  const { currentOrg } = useWorkspace();
  // avatarUrl is OPTIONAL on this type on purpose — a ClubOS server that
  // predates the avatar column omits the key entirely, and the menu must
  // still render initials rather than break.
  const { data: user } = useQuery<{
    firstName: string;
    lastName: string;
    email?: string;
    role: string;
    avatarUrl?: string | null;
  }>({ queryKey: ["/api/auth/me"] });

  const logoutMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      window.location.href = "/admin/login";
    },
  });

  const adminItems = accountAdminItems(currentOrg?.slug).filter((item) =>
    canAccessTab({
      globalRole: user?.role,
      membershipRole: currentOrg?.userRole,
      membershipTabs: currentOrg?.userTabs,
      membershipUnlockedTabs: currentOrg?.userUnlockedTabs,
      tabSlug: item.tab as string,
    }),
  );

  // `""[0]` is undefined, which used to render the string "undefined" into the
  // circle on a half-provisioned account.
  const initials = user
    ? `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}` || "?"
    : "?";
  const fullName = user ? `${user.firstName} ${user.lastName}`.trim() : "";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="rounded-full ring-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-shadow hover:ring-2 hover:ring-border"
          data-testid="button-account-menu"
          aria-label="Account menu"
          title={fullName || "Account"}
        >
          <Avatar className="h-8 w-8">
            {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
            <AvatarFallback className="bg-primary text-primary-foreground text-[11px] font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60" sideOffset={8}>
        <div className="px-2 py-2">
          <p
            className="text-[13px] font-medium text-foreground truncate"
            data-testid="text-user-name"
          >
            {fullName || "…"}
          </p>
          {user?.email && (
            <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
          )}
          <p className="text-[11px] text-muted-foreground capitalize mt-0.5">
            {user?.role?.replace(/_/g, " ") || ""}
          </p>
        </div>

        <DropdownMenuSeparator />

        {ACCOUNT_PERSONAL_ITEMS.map((item) => {
          const Icon = ICONS[item.title] ?? User;
          return (
            <DropdownMenuItem key={item.title} asChild>
              <Link
                href={item.url}
                className="cursor-pointer"
                data-testid={`link-account-${item.title.toLowerCase()}`}
              >
                <Icon className="w-4 h-4 mr-2" />
                {item.title}
              </Link>
            </DropdownMenuItem>
          );
        })}

        {adminItems.length > 0 && <DropdownMenuSeparator />}

        {adminItems.map((item) => {
          const Icon = ICONS[item.title] ?? Settings;
          return (
            <DropdownMenuItem key={item.title} asChild>
              <Link
                href={item.url}
                className="cursor-pointer"
                data-testid={`link-account-${item.title.toLowerCase()}`}
              >
                <Icon className="w-4 h-4 mr-2" />
                {item.title}
              </Link>
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() => logoutMutation.mutate()}
          className="cursor-pointer text-destructive focus:text-destructive"
          data-testid="button-logout"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
