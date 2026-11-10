/**
 * Café Fernweh embeddable chat widget.
 *
 * Framework-independent vanilla Web Component. The host page only needs to
 * load this script and insert <cafe-chatbot api-base="..."></cafe-chatbot>.
 * All styling is encapsulated in shadow DOM so it cannot conflict with the
 * host site's styles. Inference credentials never reach the browser; all
 * AI calls go through the backend.
 */

const TEMPLATE = `
<style>
  :host {
    display: block;
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 360px;
    height: 560px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    z-index: 2147483647;
    box-sizing: border-box;
  }
  #wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: #efebe9;
    border: 1px solid #d7ccc8;
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.18);
    overflow: hidden;
  }
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
    padding: 2px 8px;
    border-radius: 4px;
  }
  #close:hover { background: rgba(255,255,255,0.15); }
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
    padding: 8px 12px;
    border: 1px solid #bcaa9a;
    border-radius: 20px;
    font-size: 14px;
    outline: none;
    background: #fff;
  }
  #input:focus { border-color: #795548; }
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
    text-align: right;
  }
  .hidden { display: none !important; }
</style>
<div id="wrap" class="hidden">
  <div id="header">
    <span>Café Fernweh</span>
    <button id="close" aria-label="Close chat">✕</button>
  </div>
  <div id="messages" aria-live="polite"></div>
  <div id="input-area">
    <input id="input" type="text" placeholder="Ask about the menu…" aria-label="Your message" />
    <button id="send" aria-label="Send message">Send</button>
  </div>
  <div id="status"></div>
</div>
`;

export class CafeChatbot extends HTMLElement {
  static get observedAttributes() { return ["api-base"]; }

  private apiBase: string;
  private conversationId: string | null = null;
  private messagesEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private sendEl: HTMLButtonElement;
  private statusEl: HTMLElement;
  private wrapEl: HTMLElement;
  private closed = false;

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

    this.sendEl.addEventListener("click", () => this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.send();
    });
    root.getElementById("close")!.addEventListener("click", () => {
      this.closed = true;
      this.wrapEl.classList.add("hidden");
    });
  }

  attributeChangedCallback(name: string, old: string, value: string | null) {
    if (name === "api-base" && value) this.apiBase = value;
  }

  connectedCallback() {
    if (this.closed) this.wrapEl.classList.add("hidden");
    else this.wrapEl.classList.remove("hidden");
  }

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.setSending(true);
    this.appendMessage("customer", text);
    this.inputEl.value = "";
    this.setStatus("Sending…");

    try {
      const res = await fetch(`${this.apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversation_id: this.conversationId,
          grounding: "retrieval_validation",
        }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as {
        conversation_id?: string;
        reply?: string;
      };
      this.conversationId = data.conversation_id ?? this.conversationId;
      this.appendMessage("assistant", data.reply || "(no reply)");
      this.setStatus("");
    } catch (err) {
      this.appendMessage("assistant", "Sorry, I couldn't reach Café Fernweh right now. Please try again.", true);
    } finally {
      this.setSending(false);
    }
  }

  private appendMessage(role: "customer" | "assistant", text: string, error = false) {
    const div = document.createElement("div");
    div.className = `msg ${role}${error ? " error" : ""}`;
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
