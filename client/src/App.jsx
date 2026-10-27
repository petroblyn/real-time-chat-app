import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";
const assetUrl = (url) => url?.startsWith("http") ? url : `${API}${url || ""}`;
const initials = (name = "?") => name.slice(0, 2).toUpperCase();
const time = (date) => date ? new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("chat_token") || "");
  const [me, setMe] = useState(JSON.parse(localStorage.getItem("chat_user") || "null"));
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [contacts, setContacts] = useState([]);
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const socketRef = useRef(null);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const typingTimer = useRef(null);
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  const api = useCallback(async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API}${url}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }, [token]);

  const refreshContacts = useCallback(async () => {
    if (!token) return;
    try { setContacts(await api("/api/users")); } catch (e) { setError(e.message); }
  }, [api, token]);

  const loadMessages = useCallback(async (contact) => {
    if (!contact) return;
    try {
      const rows = await api(`/api/messages/${contact.id}`);
      setMessages(rows);
      socketRef.current?.emit("mark_read", { sender_id: contact.id });
    } catch (e) { setError(e.message); }
  }, [api]);

  useEffect(() => {
    if (!token || !me) return;
    let socket;
    refreshContacts();
    socket = io(API, { auth: { token }, transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect_error", () => setError("Live connection failed. Check that the server is running."));
    socket.on("presence", setOnline);
    socket.on("new_message", (message) => {
      const current = activeRef.current;
      if (current && (Number(message.sender_id) === Number(current.id) || Number(message.recipient_id) === Number(current.id))) {
        setMessages((old) => old.some((m) => Number(m.id) === Number(message.id)) ? old : [...old, message]);
        if (Number(message.sender_id) === Number(current.id)) socket.emit("mark_read", { sender_id: current.id });
      }
      refreshContacts();
    });
    socket.on("typing", (payload) => { if (Number(payload.user_id) === Number(activeRef.current?.id)) setTyping(true); });
    socket.on("stop_typing", (payload) => { if (Number(payload.user_id) === Number(activeRef.current?.id)) setTyping(false); });
    socket.on("message_read", ({ reader_id, message_ids, read_at }) => {
      if (Number(reader_id) === Number(activeRef.current?.id)) {
        const ids = new Set(message_ids.map(Number));
        setMessages((old) => old.map((m) => ids.has(Number(m.id)) ? { ...m, read_at } : m));
      }
    });
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [token, me, refreshContacts]);

  useEffect(() => {
    if (active) { setTyping(false); loadMessages(active); }
    else setMessages([]);
  }, [active, loadMessages]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, typing]);

  async function submitAuth(e) {
    e.preventDefault(); setAuthError(""); setBusy(true);
    try {
      const data = await fetch(`${API}/api/auth/${mode === "register" ? "register" : "login"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "Authentication failed."); return d; });
      localStorage.setItem("chat_token", data.token);
      localStorage.setItem("chat_user", JSON.stringify(data.user));
      setToken(data.token); setMe(data.user); setPassword("");
    } catch (e) { setAuthError(e.message); }
    finally { setBusy(false); }
  }

  function logout() {
    localStorage.removeItem("chat_token"); localStorage.removeItem("chat_user");
    setToken(""); setMe(null); setContacts([]); setActive(null); setMessages([]);
    socketRef.current?.disconnect();
  }

  function sendTyping(value) {
    setDraft(value);
    if (!active || !socketRef.current) return;
    socketRef.current.emit("typing", { recipient_id: active.id });
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => socketRef.current?.emit("stop_typing", { recipient_id: active.id }), 900);
  }

  function sendMessage(e) {
    e?.preventDefault();
    if (!active || !socketRef.current || (!draft.trim())) return;
    const content = draft.trim();
    setError("");
    socketRef.current.emit("private_message", { recipient_id: active.id, content }, (result) => {
      if (result?.error) setError(result.error);
      else { setDraft(""); socketRef.current?.emit("stop_typing", { recipient_id: active.id }); refreshContacts(); }
    });
  }

  async function uploadFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !active) return;
    setError(""); setBusy(true);
    try {
      const form = new FormData(); form.append("file", file);
      const uploaded = await api("/api/upload", { method: "POST", body: form });
      socketRef.current.emit("private_message", {
        recipient_id: active.id, content: "", file_url: uploaded.file_url, file_name: uploaded.file_name
      }, (result) => { if (result?.error) setError(result.error); });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const filtered = useMemo(() => contacts.filter((c) => c.username.toLowerCase().includes(search.toLowerCase())), [contacts, search]);

  if (!token || !me) return <div className="auth-page">
    <div className="auth-card">
      <div className="brand-mark">✦</div><h1>Chatly</h1>
      <p className="muted">Simple, instant conversations.</p>
      <div className="auth-tabs"><button className={mode === "login" ? "selected" : ""} onClick={() => { setMode("login"); setAuthError(""); }}>Log in</button><button className={mode === "register" ? "selected" : ""} onClick={() => { setMode("register"); setAuthError(""); }}>Create account</button></div>
      <form onSubmit={submitAuth}>
        <label>Username</label><input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. petro_blyn" required minLength={3} maxLength={30} />
        <label>Password</label><input autoComplete={mode === "register" ? "new-password" : "current-password"} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} />
        {authError && <p className="error">{authError}</p>}
        <button className="primary full" disabled={busy}>{busy ? "Please wait…" : mode === "register" ? "Create account" : "Log in"}</button>
      </form>
      <p className="tiny muted">Messages are stored on your chat server.</p>
    </div>
  </div>;

  return <main className="app-shell">
    <aside className={`sidebar ${active ? "mobile-hidden" : ""}`}>
      <header className="sidebar-top"><div className="avatar self">{initials(me.username)}</div><div className="me-info"><strong>{me.username}</strong><span>Available to chat</span></div><button className="icon-btn" title="Log out" onClick={logout}>↪</button></header>
      <div className="sidebar-title"><span>Messages</span><span className="online-count">{online.length} online</span></div>
      <div className="search-wrap"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people" /></div>
      <div className="contact-list">
        {filtered.map((c) => <button key={c.id} className={`contact ${active?.id === c.id ? "active" : ""}`} onClick={() => { setActive(c); setError(""); }}>
          <div className="avatar">{initials(c.username)}{online.includes(Number(c.id)) && <i className="online-dot" />}</div>
          <div className="contact-copy"><div className="contact-line"><strong>{c.username}</strong><span>{time(c.last_message_at)}</span></div><p>{c.last_message || (online.includes(Number(c.id)) ? "Online now" : "Start a conversation")}</p></div>
        </button>)}
        {!filtered.length && <div className="empty-contacts">{contacts.length ? "No matching people." : "No other users yet. Create a second account in another browser to test chat."}</div>}
      </div>
      <footer className="sidebar-footer"><span className="green-dot" /> End-to-end delivery via live connection</footer>
    </aside>
    <section className={`chat-panel ${!active ? "mobile-hidden" : ""}`}>
      {!active ? <div className="welcome"><div className="welcome-icon">✦</div><h2>Your conversations, in real time.</h2><p>Choose a person on the left to start messaging.</p><div className="welcome-note">Messages • Typing indicators • Read receipts • File sharing</div></div> :
      <>
        <header className="chat-header"><button className="back-btn" onClick={() => setActive(null)}>‹</button><div className="avatar">{initials(active.username)}{online.includes(Number(active.id)) && <i className="online-dot" />}</div><div className="chat-person"><strong>{active.username}</strong><span>{typing ? "typing…" : online.includes(Number(active.id)) ? "online" : "offline"}</span></div><span className="secure-label">● Live chat</span></header>
        {error && <div className="inline-error">{error}<button onClick={() => setError("")}>×</button></div>}
        <div className="messages-area">
          {messages.length === 0 && <div className="conversation-empty"><span>✦</span><p>This is the beginning of your conversation with {active.username}.</p></div>}
          {messages.map((m) => {
            const mine = Number(m.sender_id) === Number(me.id);
            return <div key={m.id} className={`message-row ${mine ? "mine" : "theirs"}`}><div className="bubble">
              {m.content && <p>{m.content}</p>}
              {m.file_url && <a className="attachment" href={assetUrl(m.file_url)} target="_blank" rel="noreferrer"><span className="file-icon">↧</span><span><strong>{m.file_name || "Attachment"}</strong><small>Open or download file</small></span></a>}
              <div className="message-meta"><time>{time(m.created_at)}</time>{mine && <span className={m.read_at ? "read" : ""} title={m.read_at ? "Read" : "Sent"}>{m.read_at ? "✓✓" : "✓"}</span>}</div>
            </div></div>;
          })}
          {typing && <div className="typing-bubble"><span></span><span></span><span></span></div>}
          <div ref={bottomRef} />
        </div>
        <form className="composer" onSubmit={sendMessage}>
          <input ref={fileRef} type="file" hidden onChange={uploadFile} />
          <button type="button" className="attach-btn" title="Attach file" disabled={busy} onClick={() => fileRef.current?.click()}>＋</button>
          <input value={draft} onChange={(e) => sendTyping(e.target.value)} placeholder={`Message ${active.username}…`} aria-label="Message" />
          <button type="submit" className="send-btn" disabled={!draft.trim()}>➤</button>
        </form>
      </>}
    </section>
  </main>;
}
