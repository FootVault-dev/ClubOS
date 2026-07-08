import { LiveChatAdmin } from "./cic-livechat";

// United Print Live Chat — org-scoped to the United Prints workspace.
export default function PrintLiveChat() {
  return (
    <LiveChatAdmin
      apiBase="/api/admin/print/chat"
      title="Live Chat"
      subtitle="Real-time conversations from the United Print website — the visitor is emailed when you reply if they've stepped away."
    />
  );
}
