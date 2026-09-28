import { Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

import {
  resolveAvatarSvgConfig,
  resolveAvatarUrl,
} from "../../views/okou-page/avatar-utils.ts";
import {
  AVATAR_ARTWORK_SLOT,
  AVATAR_HEAD_SLOT,
  avatarSvgComposition,
  avatarSvgContentTransform,
} from "../../views/okou-page/avatar-svg-utils.ts";
import { serializeAgentMention } from "./composer-agent-suggestion-domain.ts";
import { AGENT_MENTION_NODE_NAME } from "./user-message-document-codec.ts";

interface AgentMentionAttributes {
  readonly agentId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

interface AgentMentionAvatarSource {
  readonly agentId: string;
  readonly avatarUrl: string | null;
}

/** The avatar composition switches, as seen by a mention chip. */
export interface AgentMentionAvatarSwitches {
  readonly framing: boolean;
}

export interface AgentMentionAvatarRuntime {
  readonly resolve: (agentId: string, fallback: string | null) => string | null;
  readonly replaceAgents: (agents: readonly AgentMentionAvatarSource[]) => void;
  /**
   * The `avatarFraming` switch. Mention chips are
   * ProseMirror node views built outside React and outside command scope, so
   * the switches are pushed in from the sync command that already feeds this
   * runtime rather than read from `featureSwitch$` here.
   */
  readonly setSwitches: (next: AgentMentionAvatarSwitches) => void;
  /**
   * Stable by reference until a field actually changes, which is what lets a
   * node view detect a switch flip by identity.
   */
  readonly switches: () => AgentMentionAvatarSwitches;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createAgentMentionAvatarRuntime(): AgentMentionAvatarRuntime {
  let agents: readonly AgentMentionAvatarSource[] = [];
  let switches: AgentMentionAvatarSwitches = {
    framing: false,
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    resolve(agentId, fallback) {
      const agent = agents.find((candidate) => {
        return candidate.agentId === agentId;
      });
      return agent ? agent.avatarUrl : fallback;
    },
    replaceAgents(nextAgents) {
      agents = nextAgents;
      notify();
    },
    setSwitches(next) {
      if (switches.framing === next.framing) {
        return;
      }
      switches = next;
      notify();
    },
    switches() {
      return switches;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function agentMentionAttributes(node: ProseMirrorNode): AgentMentionAttributes {
  const agentId: unknown = node.attrs.agentId;
  const name: unknown = node.attrs.name;
  const avatarUrl: unknown = node.attrs.avatarUrl;
  if (
    typeof agentId !== "string" ||
    typeof name !== "string" ||
    (avatarUrl !== null && typeof avatarUrl !== "string")
  ) {
    throw new Error("Agent mention node attributes are invalid");
  }
  return { agentId, name, avatarUrl };
}

export function agentMentionText(node: ProseMirrorNode): string {
  const { agentId, name } = agentMentionAttributes(node);
  return serializeAgentMention(agentId, name);
}

function renderAgentMentionAvatar(
  container: HTMLElement,
  avatarUrl: string | null,
  switches: AgentMentionAvatarSwitches,
): void {
  container.replaceChildren();
  const svgConfig = resolveAvatarSvgConfig(avatarUrl);
  if (svgConfig) {
    const { behind, head, front, headOffsetY, contentOffsetY, contentScale } =
      avatarSvgComposition(svgConfig, switches);
    const applySlot = (
      element: HTMLElement,
      slot: Readonly<Record<string, string>>,
    ) => {
      for (const [name, value] of Object.entries(slot)) {
        element.setAttribute(name, value);
      }
    };
    const layers = document.createElement("span");
    layers.className = "absolute inset-0";
    applySlot(layers, AVATAR_ARTWORK_SLOT);
    const transform = avatarSvgContentTransform({
      contentOffsetY: switches.framing ? contentOffsetY : 0,
      contentScale,
    });
    if (transform) {
      layers.style.transform = transform;
    }
    const appendLayers = (parent: HTMLElement, urls: readonly string[]) => {
      for (const src of urls) {
        const image = document.createElement("img");
        image.alt = "";
        image.src = src;
        image.className = "absolute inset-0 h-full w-full object-cover";
        parent.append(image);
      }
    };
    const headLayers = document.createElement("span");
    headLayers.className = "absolute inset-0";
    applySlot(headLayers, AVATAR_HEAD_SLOT);
    headLayers.style.transform = `translateY(${headOffsetY}%)`;
    appendLayers(layers, behind);
    appendLayers(headLayers, head);
    layers.append(headLayers);
    appendLayers(layers, front);
    container.append(layers);
    return;
  }

  const src = resolveAvatarUrl(avatarUrl);
  if (src) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = src;
    image.className = "h-full w-full object-cover";
    container.append(image);
  }
}

function createAgentMentionNodeView(
  node: ProseMirrorNode,
  className: string,
  avatarRuntime: AgentMentionAvatarRuntime,
): NodeView {
  const dom = document.createElement("span");
  dom.className = className;
  dom.contentEditable = "false";
  dom.style.outline = "none";
  dom.style.userSelect = "none";

  const avatar = document.createElement("span");
  avatar.className =
    "relative h-4 w-4 shrink-0 overflow-hidden rounded-full bg-muted";
  avatar.ariaHidden = "true";
  const name = document.createElement("span");
  name.className = "min-w-0 select-none truncate";
  dom.append(avatar, name);

  let currentNode = node;
  let currentAvatarUrl: string | null | undefined;
  // The chip is redrawn only when its picture would actually change. The
  // switches are part of that picture, not just the URL: flipping one swaps the
  // layer set or the framing for the same avatar.
  let currentSwitches: AgentMentionAvatarSwitches | undefined;
  function render(nextNode: ProseMirrorNode): void {
    const attributes = agentMentionAttributes(nextNode);
    const avatarUrl = avatarRuntime.resolve(
      attributes.agentId,
      attributes.avatarUrl,
    );
    const switches = avatarRuntime.switches();
    dom.dataset.agentMention = attributes.agentId;
    dom.dataset.agentName = attributes.name;
    if (avatarUrl === null) {
      delete dom.dataset.agentAvatarUrl;
    } else {
      dom.dataset.agentAvatarUrl = avatarUrl;
    }
    name.textContent = attributes.name;
    if (avatarUrl !== currentAvatarUrl || switches !== currentSwitches) {
      currentAvatarUrl = avatarUrl;
      currentSwitches = switches;
      renderAgentMentionAvatar(avatar, avatarUrl, switches);
    }
  }
  render(node);
  const unsubscribe = avatarRuntime.subscribe(() => {
    render(currentNode);
  });

  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) {
        return false;
      }
      currentNode = nextNode;
      render(nextNode);
      return true;
    },
    selectNode() {
      dom.dataset.selected = "";
    },
    deselectNode() {
      delete dom.dataset.selected;
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      unsubscribe();
    },
  };
}

export function createAgentMentionNode(
  className: string,
  avatarRuntime: AgentMentionAvatarRuntime,
): Node<undefined, unknown> {
  return Node.create({
    name: AGENT_MENTION_NODE_NAME,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes() {
      return {
        agentId: { default: "" },
        name: { default: "" },
        avatarUrl: { default: null },
      };
    },
    parseHTML() {
      return [
        {
          tag: "span[data-agent-mention]",
          getAttrs: (element) => {
            return {
              agentId: element.dataset.agentMention ?? "",
              name: element.dataset.agentName ?? "",
              avatarUrl: element.dataset.agentAvatarUrl ?? null,
            };
          },
        },
      ];
    },
    renderHTML({ node }) {
      const { agentId, name, avatarUrl } = agentMentionAttributes(node);
      return [
        "span",
        {
          "data-agent-mention": agentId,
          "data-agent-name": name,
          ...(avatarUrl === null ? {} : { "data-agent-avatar-url": avatarUrl }),
          class: className,
        },
        name,
      ];
    },
    renderText({ node }) {
      return agentMentionText(node);
    },
    addNodeView() {
      return ({ node }) => {
        return createAgentMentionNodeView(node, className, avatarRuntime);
      };
    },
  });
}
