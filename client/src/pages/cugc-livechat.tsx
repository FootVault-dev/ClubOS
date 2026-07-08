import { LiveChatAdmin } from "./cic-livechat";

// CUGC Live Chat — org-scoped to the Christchurch United Gymnastics workspace.
export default function CugcLiveChat() {
  return (
    <LiveChatAdmin
      apiBase="/api/admin/cugc/chat"
      title="Live Chat"
      subtitle="Real-time conversations from cugc.co.nz — the visitor is emailed when you reply if they've stepped away."
    />
  );
}
