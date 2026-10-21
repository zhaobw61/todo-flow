"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Filter = "all" | "active" | "completed";
type Todo = { id: string; title: string; completed: boolean };

const STORAGE_KEY = "todo-flow-items";

function isTodoArray(value: unknown): value is Todo[] {
  return Array.isArray(value) && value.every((todo) =>
    typeof todo?.id === "string"
    && typeof todo?.title === "string"
    && typeof todo?.completed === "boolean",
  );
}

function createTodoId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `todo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const defaultTodos: Todo[] = [
  { id: "claude-review", title: "让 Claude 审查 TodoList 代码", completed: false },
  { id: "antigravity-test", title: "使用 Antigravity 测试页面", completed: false },
  { id: "cloudflare-deploy", title: "部署到 Cloudflare Pages", completed: false },
];

const filterLabels: Record<Filter, string> = {
  all: "全部",
  active: "待完成",
  completed: "已完成",
};

export default function Home() {
  const [todos, setTodos] = useState<Todo[]>(defaultTodos);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [ready, setReady] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const todoRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
      if (isTodoArray(parsed)) setTodos(parsed);
    } catch {
      // Storage can be unavailable or contain invalid data; keep the safe defaults.
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
    } catch {
      // The list remains usable when storage is blocked or full.
    }
  }, [ready, todos]);

  const visibleTodos = useMemo(() => {
    if (filter === "active") return todos.filter((todo) => !todo.completed);
    if (filter === "completed") return todos.filter((todo) => todo.completed);
    return todos;
  }, [filter, todos]);

  const completedCount = todos.filter((todo) => todo.completed).length;
  const remainingCount = todos.length - completedCount;
  const progress = todos.length === 0 ? 0 : Math.round((completedCount / todos.length) * 100);

  function addTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = input.trim();
    if (!title) return;
    setTodos((current) => [...current, { id: createTodoId(), title, completed: false }]);
    setInput("");
    setAnnouncement(`已添加：${title}`);
  }

  function toggleTodo(id: string) {
    const todo = todos.find((item) => item.id === id);
    if (todo) setAnnouncement(`${todo.completed ? "已恢复" : "已完成"}：${todo.title}`);
    setTodos((current) => current.map((item) =>
      item.id === id ? { ...item, completed: !item.completed } : item,
    ));
  }

  function deleteTodo(id: string) {
    const index = todos.findIndex((todo) => todo.id === id);
    const deleted = todos[index];
    const next = todos.filter((todo) => todo.id !== id);
    setAnnouncement(`已删除：${deleted?.title ?? "任务"}`);
    setTodos((current) => current.filter((todo) => todo.id !== id));

    window.requestAnimationFrame(() => {
      const nextTodo = next[Math.min(index, next.length - 1)];
      if (nextTodo) todoRefs.current.get(nextTodo.id)?.focus();
      else inputRef.current?.focus();
    });
  }

  function clearCompleted() {
    setAnnouncement(`已清除 ${completedCount} 项已完成任务`);
    setTodos((current) => current.filter((todo) => !todo.completed));
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <main className="page-shell">
      <section className="todo-app" aria-labelledby="page-title">
        <header className="app-header">
          <div className="brand-row">
            <a className="brand" href="#top" aria-label="返回 TodoFlow 顶部">
              <span className="brand-mark" aria-hidden="true">✓</span>
              TodoFlow
            </a>
            <span className="date-chip">专注今天</span>
          </div>

          <div className="hero-copy" id="top">
            <p className="eyebrow">MAKE SPACE FOR WHAT MATTERS</p>
            <h1 id="page-title">今天，想完成什么？</h1>
            <p>把任务写下来，一件一件完成。你的清单会自动保存在当前浏览器中。</p>
          </div>

          <form className="add-form" onSubmit={addTodo}>
            <label className="sr-only" htmlFor="new-todo">添加一个新任务</label>
            <input
              id="new-todo"
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="例如：完成网页自动化测试"
              autoComplete="off"
              maxLength={120}
            />
            <button type="submit" disabled={!input.trim()}>
              <span aria-hidden="true">＋</span> 添加任务
            </button>
          </form>
        </header>

        <section className="content-panel" aria-labelledby="list-title">
          <div className="summary-row">
            <div>
              <p className="section-label">MY TASKS</p>
              <h2 id="list-title">我的清单</h2>
            </div>
            <div className="progress-copy" aria-label={`已完成 ${progress}%`}>
              <strong>{ready ? progress : "—"}%</strong>
              <span>{ready ? `${remainingCount} 项待完成` : "正在读取清单"}</span>
            </div>
          </div>

          <div className="progress-track" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>

          <div className="toolbar">
            <div className="filters" role="group" aria-label="筛选任务">
              {(Object.keys(filterLabels) as Filter[]).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={filter === value ? "filter active" : "filter"}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {filterLabels[value]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="clear-button"
              onClick={clearCompleted}
              disabled={completedCount === 0}
            >
              清除已完成
            </button>
          </div>

          <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

          <ul className="todo-list" aria-busy={!ready}>
            {ready && visibleTodos.map((todo) => (
              <li className={todo.completed ? "todo-item completed" : "todo-item"} key={todo.id}>
                <input
                  type="checkbox"
                  className="check-button"
                  aria-label={todo.title}
                  checked={todo.completed}
                  ref={(element) => {
                    if (element) todoRefs.current.set(todo.id, element);
                    else todoRefs.current.delete(todo.id);
                  }}
                  onChange={() => toggleTodo(todo.id)}
                />
                <span className="todo-title">{todo.title}</span>
                <button
                  type="button"
                  className="delete-button"
                  aria-label={`删除任务：${todo.title}`}
                  onClick={() => deleteTodo(todo.id)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>

          {!ready && <div className="loading-state">正在读取你的清单…</div>}

          {ready && visibleTodos.length === 0 && (
            <div className="empty-state">
              <span aria-hidden="true">○</span>
              <h3>{todos.length === 0 ? "清单还是空的" : "这里没有任务"}</h3>
              <p>{todos.length === 0 ? "在上方输入一件想完成的事吧。" : "换个筛选条件看看。"}</p>
            </div>
          )}

          <footer className="list-footer">
            <span>{todos.length} 项任务</span>
            <span>{completedCount} 项已完成</span>
          </footer>
        </section>
      </section>
      <p className="page-note">少一点杂念，多一点完成。</p>
    </main>
  );
}
