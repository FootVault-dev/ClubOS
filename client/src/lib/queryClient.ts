import { getActiveWorkspaceSlug } from "./workspace-slug";
import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// The workspace header. THIS TAB's workspace first (set by workspace-context);
// localStorage only before the context has resolved one — it is shared across
// tabs, and reading it on every request is how a CUFC tab ended up asking for
// Mini Football's data after another tab switched (2026-09-09).
function workspaceHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const slug = getActiveWorkspaceSlug() ?? localStorage.getItem("clubos_workspace");
  return slug ? { "X-Workspace-Slug": slug } : {};
}

/**
 * A GET that carries the workspace header — for the places that hand-roll a
 * fetch() instead of going through apiRequest() or getQueryFn().
 *
 * 🔴 A bare fetch() to a requireTab()-gated endpoint is INVISIBLE to a super
 * admin and broken for everybody else. requireTab returns early on the
 * super_admin role check, one line before it looks for X-Workspace-Slug, so
 * Daniel gets a working page and every staff member gets HTTP 400 and a blank
 * screen. That is exactly how the Contacts tab shipped: it worked for the only
 * person who could never hit the bug. Reach for this, not fetch().
 */
export async function workspaceFetch(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: { ...workspaceHeaders(), ...(init.headers || {}) },
  });
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...workspaceHeaders(),
    },
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers: workspaceHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
