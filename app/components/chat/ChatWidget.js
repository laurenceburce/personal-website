"use client";

import { useEffect, useRef, useState } from "react";
import AuthFeatureGate from "../auth/AuthFeatureGate";
import { trackAnalyticsEvent } from "../../utils/analyticsClient";

function parseInline(text) {
  const parts = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] != null) parts.push(<strong key={m.index}>{m[2]}</strong>);
    else if (m[3] != null) parts.push(<em key={m.index}>{m[3]}</em>);
    else if (m[4] != null) parts.push(<code key={m.index}>{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownMessage({ text }) {
  const lines = text.split("\n");
  const nodes = [];
  let listItems = null;
  let listType = null;

  const flushList = () => {
    if (!listItems) return;
    const Tag = listType;
    nodes.push(<Tag key={`list-${nodes.length}`}>{listItems}</Tag>);
    listItems = null;
    listType = null;
  };

  lines.forEach((line, i) => {
    const ulMatch = line.match(/^[\*\-]\s+(.+)/);
    const olMatch = line.match(/^\d+\.\s+(.+)/);

    if (ulMatch) {
      if (listType !== "ul") { flushList(); listType = "ul"; listItems = []; }
      listItems.push(<li key={i}>{parseInline(ulMatch[1])}</li>);
    } else if (olMatch) {
      if (listType !== "ol") { flushList(); listType = "ol"; listItems = []; }
      listItems.push(<li key={i}>{parseInline(olMatch[1])}</li>);
    } else {
      flushList();
      const trimmed = line.trim();
      if (trimmed) nodes.push(<p key={i}>{parseInline(trimmed)}</p>);
    }
  });
  flushList();

  return <div className="chat-bubble-md">{nodes}</div>;
}

const GREETING = {
  role: "assistant",
  content: "Hi! I'm Laurence Burce's portfolio assistant. I can answer questions about his software-engineering experience, AI and automation work, projects, skills, education, availability, and contact information."
};

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    trackAnalyticsEvent("Chat: Message Sent", "");

    const history = messages
      .slice(1)
      .filter(m => m.content.trim());

    setMessages(prev => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "" }
    ]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: "assistant",
            content: err.error || "Something went wrong. Please try again."
          };
          return copy;
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: "assistant",
            content: copy[copy.length - 1].content + chunk
          };
          return copy;
        });
      }
    } catch {
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          role: "assistant",
          content: "Network error. Please check your connection and try again."
        };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function clearChat() {
    setMessages([GREETING]);
    setInput("");
    setLoading(false);
  }

  return (
    <div className="chat-widget">
      {open && (
        <div className="chat-panel" role="dialog" aria-label="AI portfolio assistant">
          <div className="chat-header">
            <div className="chat-header-left">
              <span className="chat-header-dot" aria-hidden="true" />
              <div className="chat-header-info">
                <span className="chat-header-title">AI Assistant</span>
                <span className="chat-header-sub">Ask about Laurence&apos;s work</span>
              </div>
            </div>
            <div className="chat-header-actions">
              <button
                className="chat-icon-btn"
                onClick={clearChat}
                title="Clear chat"
                aria-label="Clear chat history"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10"/>
                  <path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
                </svg>
              </button>
              <button
                className="chat-icon-btn"
                onClick={() => setOpen(false)}
                aria-label="Close chat"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          <AuthFeatureGate
            title="Sign In to Chat"
            message="Sign in before using the AI assistant."
            className="auth-feature-gate auth-feature-gate-chat"
          >
            <div className="chat-messages">
              {messages.map((msg, i) => (
                <div key={i} className={`chat-bubble chat-bubble--${msg.role}`}>
                  {msg.content === "" && loading && i === messages.length - 1 ? (
                    <span className="chat-typing" aria-label="AI is typing">
                      <span /><span /><span />
                    </span>
                  ) : msg.role === "assistant" ? (
                    <MarkdownMessage text={msg.content} />
                  ) : (
                    <span className="chat-bubble-text">{msg.content}</span>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <form className="chat-form" onSubmit={handleSend}>
              <textarea
                ref={inputRef}
                className="chat-textarea"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything..."
                rows={1}
                disabled={loading}
                maxLength={1000}
                aria-label="Chat message"
              />
              <button
                type="submit"
                className="chat-send"
                disabled={loading || !input.trim()}
                aria-label="Send message"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </button>
            </form>
            <p className="chat-powered-by">Powered by Gemini &middot; Enter to send</p>
          </AuthFeatureGate>
        </div>
      )}

      <button
        className={`chat-fab${open ? " chat-fab--open" : ""}`}
        onClick={() => setOpen(o => { if (!o) trackAnalyticsEvent("Chat: Open", ""); return !o; })}
        aria-label={open ? "Close AI assistant" : "Open AI portfolio assistant"}
        title="AI Portfolio Assistant"
      >
        {open ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        ) : (
          <>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Ask AI</span>
          </>
        )}
      </button>
    </div>
  );
}
