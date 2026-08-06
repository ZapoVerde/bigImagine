import { useEffect, useState } from 'react';
import { ApiError, getChatLineage } from '../../api/client';
import type { ChatLineageNode } from '../../api/types';
import './BranchMapPanel.css';

interface BranchMapPanelProps {
  apiKey: string | null;
  chatId: string;
  /** Switches (or opens) a chat tab by id — same callback ChatView's "Fork from here" action
   *  already uses, reused here so clicking any branch just jumps to it. */
  onOpenChat: (chatId: string, title?: string) => void;
  onClose: () => void;
}

interface TreeNode extends ChatLineageNode {
  children: TreeNode[];
}

// getLineage always returns a root (parentChatId null) plus every descendant, so exactly one node
// here has no parent in the set — everything else nests under it.
function buildTree(nodes: ChatLineageNode[]): TreeNode | null {
  const byId = new Map<string, TreeNode>(nodes.map((n) => [n.chatId, { ...n, children: [] }]));
  let root: TreeNode | null = null;
  for (const node of byId.values()) {
    const parent = node.parentChatId ? byId.get(node.parentChatId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      root = node;
    }
  }
  return root;
}

// docs/chat-memory.md: a fork is a new chat_sessions row, related to its parent only through
// parentChatId/forkMessageId. This panel is the read-only map of one such family — the point of
// it is that a household member never has to rename a chat just to remember how it branched.
export default function BranchMapPanel({ apiKey, chatId, onOpenChat, onClose }: BranchMapPanelProps) {
  const [nodes, setNodes] = useState<ChatLineageNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getChatLineage(chatId, apiKey)
      .then(setNodes)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load branch map'))
      .finally(() => setLoading(false));
  }, [chatId, apiKey]);

  const root = nodes ? buildTree(nodes) : null;

  return (
    <div className="branch-map-panel">
      <div className="branch-map-header">
        <span className="branch-map-title">Branch Map</span>
        <button type="button" className="branch-map-close" title="Close branch map" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="branch-map-content">
        {error && <div className="branch-map-error">{error}</div>}
        {loading && !nodes && <div className="branch-map-loading">Loading…</div>}
        {nodes && nodes.length <= 1 && (
          <p className="branch-map-empty">No branches yet — use "Fork from here" on a message to start one.</p>
        )}
        {root && nodes && nodes.length > 1 && (
          <ul className="branch-map-tree">
            <BranchMapRow node={root} activeChatId={chatId} onOpenChat={onOpenChat} />
          </ul>
        )}
      </div>
    </div>
  );
}

function BranchMapRow({
  node,
  activeChatId,
  onOpenChat,
}: {
  node: TreeNode;
  activeChatId: string;
  onOpenChat: (chatId: string, title?: string) => void;
}) {
  const isCurrent = node.chatId === activeChatId;
  return (
    <li className="branch-map-node">
      <button
        type="button"
        className={`branch-map-node-button${isCurrent ? ' current' : ''}`}
        title={isCurrent ? 'This is the chat you are viewing' : `Switch to "${node.title}"`}
        disabled={isCurrent}
        onClick={() => onOpenChat(node.chatId, node.title)}
      >
        <span className="branch-map-node-title">{node.title}</span>
        {node.kind === 'rp' && <span className="branch-map-node-badge">RP</span>}
        {node.archivedAt && <span className="branch-map-node-badge branch-map-node-badge-archived">Archived</span>}
      </button>
      {node.children.length > 0 && (
        <ul className="branch-map-children">
          {node.children.map((child) => (
            <BranchMapRow key={child.chatId} node={child} activeChatId={activeChatId} onOpenChat={onOpenChat} />
          ))}
        </ul>
      )}
    </li>
  );
}
