/**
 * Café Fernweh embeddable chat widget.
 *
 * Framework-independent vanilla Web Component. The host page only needs to
 * load this script and insert <cafe-chatbot api-base="...">.
 *
 * All styling is encapsulated in shadow DOM so it cannot conflict with the
 * host site's styles. Inference credentials never reach the browser; all AI
 * calls go through the backend.
 *
 * The widget starts closed behind an accessible launcher. It can be opened or
 * closed programmatically via the element's open()/close() methods, by the
 * launcher/close buttons, or with the keyboard (Enter/Space on the launcher,
 * Escape to close).
 */

const TEMPLATE = `
<style>
  :host {
    position: fixed;
    right: 0;
    bottom: 0;
    width: 0;
    height: 0;
    z-index: 2147483647;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    box-sizing: border-box;
  }
  #launcher {
    position: fixed;
    right: 24px;
    bottom: 24px;
    width: 58px;
    height: 58px;
    border: none;
    border-radius: 50%;
    background: #795548;
    color: #fff;
    font: 600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    letter-spacing: 0.02em;
    cursor: pointer;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  #launcher:hover { background: #5d4037; }
  #launcher:focus-visible { outline: 3px solid #ffcc80; outline-offset: 3px; }
  #launcher.hidden { display: none !important; }
  #wrap {
    position: fixed;
    right: 24px;
    bottom: 24px;
    width: 360px;
    height: 560px;
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    background: #efebe9;
    border: 1px solid #d7ccc8;
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.18);
    overflow: hidden;
    box-sizing: border-box;
  }
  #wrap.hidden { display: none !important; }
  #header {
    background: #795548;
    color: #fff;
    padding: 10px 14px;
    font-weight: 600;
    font-size: 15px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  #close {
    margin-left: auto;
    background: transparent;
    border: none;
    color: #fff;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 4px;
  }
  #close:hover { background: rgba(255, 255, 255, 0.15); }
  #close:focus-visible { outline: 2px solid #ffcc80; outline-offset: 1px; }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .msg {
    max-width: 78%;
    padding: 8px 12px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msg.customer {
    align-self: flex-end;
    background: #795548;
    color: #fff;
  }
  .msg.assistant {
    align-self: flex-start;
    background: #fff;
    border: 1px solid #d7ccc8;
    color: #3e2723;
  }
  .msg.error { color: #b3261e; }
  #input-area {
    display: flex;
    border-top: 1px solid #d7ccc8;
    padding: 8px;
    gap: 8px;
  }
  #input {
    flex: 1;
    min-width: 0;
    padding: 8px 12px;
    border: 1px solid #bcaa9a;
    border-radius: 20px;
    font-size: 14px;
    outline: none;
    background: #fff;
    color: #2d1f1a;
  }
  #input:focus { border-color: #795548; }
  #input:focus-visible { outline: 2px solid #795548; outline-offset: 1px; }
  #send {
    padding: 8px 16px;
    background: #795548;
    color: #fff;
    border: none;
    border-radius: 20px;
    font-weight: 600;
    cursor: pointer;
  }
  #send:hover { background: #5d4037; }
  #send:disabled { opacity: 0.6; cursor: not-allowed; }
  #status {
    font-size: 12px;
    color: #8d6e63;
    padding: 4px 14px;
    min-height: 18px;
    text-align: right;
  }
  @media (max-width: 420px) {
    #wrap {
      right: 12px;
      bottom: 12px;
      width: calc(100vw - 24px);
      height: calc(100vh - 24px);
      max-height: none;
    }
    #launcher { right: 12px; bottom: 12px; }
  }
</style>
<button id="launcher" type="button" aria-label="Open Café Fernweh chat" aria-expanded="false" aria-controls="wrap">
  <span aria-hidden="true">CHAT</span>
</button>
<div id="wrap" class="hidden" role="dialog" aria-label="Café Fernweh chat">
  <div id="header">
    <span>Café Fernweh</span>
    <button id="close" type="button" aria-label="Close chat">✕</button>
  </div>
  <div id="messages" aria-live="polite"></div>
  <div id="input-area">
    <input id="input" type="text" placeholder="Ask about the menu…" aria-label="Your message" autocomplete="off" />
    <button id="send" type="button" aria-label="Send message">Send</button>
  </div>
  <div id="status" role="status"></div>
</div>
`;

export class CafeChatbot extends HTMLElement {
  static get observedAttributes() { return ["api-base"]; }

  private apiBase: string;
  private conversationId: string | null = null;
  private isOpen = false;
  private messagesEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private sendEl: HTMLButtonElement;
  private statusEl: HTMLElement;
  private wrapEl: HTMLElement;
  private launcherEl: HTMLButtonElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" })!;
    root.innerHTML = TEMPLATE;
    this.apiBase = this.getAttribute("api-base") || "http://localhost:8787";

    this.wrapEl = root.getElementById("wrap")!;
    this.messagesEl = root.getElementById("messages")!;
    this.inputEl = root.getElementById("input") as HTMLInputElement;
    this.sendEl = root.getElementById("send") as HTMLButtonElement;
    this.statusEl = root.getElementById("status")!;
    this.launcherEl = root.getElementById("launcher") as HTMLButtonElement;

    this.launcherEl.addEventListener("click", () => this.open());
    this.sendEl.addEventListener("click", () => this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
    root.getElementById("close")!.addEventListener("click", () => this.close());

    this.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) {
        e.stopPropagation();
        this.close();
      }
    });
  }

  attributeChangedCallback(name: string, old: string, value: string | null) {
    if (name === "api-base" && value) this.apiBase = value;
  }

  connectedCallback() {
    // Always start closed; the launcher remains available if the element is
    // moved or reconnected in the host page.
    this.close();
  }

  /** Open the chat panel and move focus to the message input. */
  open(): void {
    this.isOpen = true;
    this.wrapEl.classList.remove("hidden");
    this.launcherEl.classList.add("hidden");
    this.launcherEl.setAttribute("aria-expanded", "true");
    this.inputEl.focus();
    this.dispatchEvent(new CustomEvent("cafe-chatbot-open", { bubbles: true }));
  }

  /** Close the chat panel and return focus to the launcher. */
  close(): void {
    this.isOpen = false;
    this.wrapEl.classList.add("hidden");
    this.launcherEl.classList.remove("hidden");
    this.launcherEl.setAttribute("aria-expanded", "false");
    this.launcherEl.focus();
    this.dispatchEvent(new CustomEvent("cafe-chatbot-close", { bubbles: true }));
  }

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.setSending(true);
    this.appendMessage("customer", text);
    this.inputEl.value = "";
    this.setStatus("Sending…");

    try {
      const payload: Record<string, unknown> = {
        message: text,
        grounding: "retrieval_validation",
      };
      // The API expects an optional UUID; sending `null` would fail validation.
      if (this.conversationId) payload.conversation_id = this.conversationId;
      const res = await fetch(`${this.apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as {
        conversation_id?: string;
        reply?: string;
      };
      this.conversationId = data.conversation_id ?? this.conversationId;
      this.appendMessage("assistant", data.reply || "(no reply)");
      this.setStatus("");
      this.inputEl.focus();
    } catch {
      this.appendMessage(
        "assistant",
        "Sorry, I couldn't reach Café Fernweh right now. Please try again.",
        true
      );
      this.setStatus("");
    } finally {
      this.setSending(false);
    }
  }

  private appendMessage(role: "customer" | "assistant", text: string, error = false) {
    const div = document.createElement("div");
    div.className = `msg ${role}${error ? " error" : ""}`;
    // textContent (never innerHTML) keeps model/user output inert: no XSS.
    div.textContent = text;
    this.messagesEl.appendChild(div);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private setSending(sending: boolean) {
    this.sendEl.disabled = sending;
    this.inputEl.disabled = sending;
  }

  private setStatus(text: string) {
    this.statusEl.textContent = text;
  }
}

if (!customElements.get("cafe-chatbot")) {
  customElements.define("cafe-chatbot", CafeChatbot);
}

declare global {
  interface HTMLElementTagNameMap {
    "cafe-chatbot": CafeChatbot;
  }
}
