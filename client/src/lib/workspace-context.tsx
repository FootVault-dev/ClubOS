import { createContext, useContext, useState, useEffect } from "react";

type Org = {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  active: boolean;
  userRole: string;
  // Tab whitelist for the current user in this workspace.
  // null = full access (legacy default). Array = explicit whitelist.
  userTabs: string[] | null;
};

// Sub-view inside the CIC (tournament) workspace — toggles between the youth
// tournament and the CIC 7's adult tournament. Persisted separately from the org.
export type CicView = "youth" | "7s";

type WorkspaceContextType = {
  currentOrg: Org | null;
  setCurrentOrg: (org: Org) => void;
  organizations: Org[];
  setOrganizations: (orgs: Org[]) => void;
  cicView: CicView;
  setCicView: (v: CicView) => void;
};

const WorkspaceContext = createContext<WorkspaceContextType>({
  currentOrg: null,
  setCurrentOrg: () => {},
  organizations: [],
  setOrganizations: () => {},
  cicView: "youth",
  setCicView: () => {},
});

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [organizations, setOrganizations] = useState<Org[]>([]);
  const [currentOrg, setCurrentOrgState] = useState<Org | null>(null);
  const [cicView, setCicViewState] = useState<CicView>(
    () => (typeof localStorage !== "undefined" && localStorage.getItem("clubos_cic_view") === "7s" ? "7s" : "youth"),
  );

  const setCurrentOrg = (org: Org) => {
    setCurrentOrgState(org);
    localStorage.setItem("clubos_workspace", org.slug);
  };

  const setCicView = (v: CicView) => {
    setCicViewState(v);
    localStorage.setItem("clubos_cic_view", v);
  };

  useEffect(() => {
    if (organizations.length > 0 && !currentOrg) {
      const savedSlug = localStorage.getItem("clubos_workspace");
      const saved = organizations.find(o => o.slug === savedSlug);
      // Persist the resolved workspace, don't just hold it in state. Every API
      // call reads this key to send X-Workspace-Slug (see lib/queryClient), so a
      // user who has never CLICKED the workspace switcher used to send no header
      // at all: the sidebar showed their first workspace while org-scoped
      // endpoints got "no workspace selected" and returned nothing. That is why
      // Squads rendered empty for a CUFC admin who had never switched workspace.
      // Writing it here also repairs a stale slug for a workspace they've lost.
      setCurrentOrg(saved || organizations[0]);
    }
  }, [organizations, currentOrg]);

  return (
    <WorkspaceContext.Provider value={{ currentOrg, setCurrentOrg, organizations, setOrganizations, cicView, setCicView }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
