import React, { useState, useEffect } from "react";

const App = () => {
  const [todos, setTodos] = useState(() => {
    const todos = "todos";
    const saved = localStorage.getItem(todos);
    return saved ? JSON.parse(saved) : [];
  });
  const [inputValue, setInputValue] = useState("");
  const [filter, setFilter] = useState("all");
  const length = 0;
  const hundred = 100;
  useEffect(() => {
    localStorage.setItem("todos", JSON.stringify(todos));
  }, [todos]);

  const addTodo = (e) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const newTodo = {
      id: Date.now(),
      text: inputValue,
      completed: false,
      createdAt: new Date().toISOString(),
    };

    setTodos([newTodo, ...todos]);
    setInputValue("");
  };

  const toggleTodo = (id) => {
    setTodos(
      todos.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo,
      ),
    );
  };

  const deleteTodo = (id) => {
    setTodos(todos.filter((todo) => todo.id !== id));
  };

  const filteredTodos = todos.filter((todo) => {
    if (filter === "active") return !todo.completed;
    if (filter === "completed") return todo.completed;
    return true;
  });

  const completedCount = todos.filter((t) => t.completed).length;
  const progress =
    todos.length === 0
      ? length
      : Math.round((completedCount / todos.length) * hundred);
  console.log("something random");

  return (
    <div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8 flex flex-col items-center">
      <div className="max-w-md w-full space-y-8 animate-fade-in">
        {/* Header Section */}
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight text-white mb-2">
            Focus<span className="text-indigo-500">.</span>
          </h1>
          <p className="text-slate-400 font-light italic">
            Stay organized, stay productive.
          </p>
        </div>

        {/* Progress Card */}
        <div className="glass rounded-3xl p-6 mb-8 animate-slide-up">
          <div className="flex justify-between items-center mb-4">
            <span className="text-sm font-medium text-slate-300">
              Daily Progress
            </span>
            <span className="text-sm font-bold text-indigo-400">
              {progress}%
            </span>
          </div>
          <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
            <div
              className="bg-indigo-500 h-full transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-3">
            {completedCount} of {todos.length} tasks completed
          </p>
        </div>

        {/* Input Section */}
        <form
          onSubmit={addTodo}
          className="relative group animate-slide-up"
          style={{ animationDelay: "0.1s" }}
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="What needs to be done?"
            className="input-field w-full py-4 pl-6 pr-14 text-lg focus:ring-2 focus:ring-indigo-500/20"
          />
          <button
            type="submit"
            className="absolute right-2 top-2 bottom-2 w-10 flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors text-white shadow-lg shadow-indigo-500/20"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        </form>

        {/* Filters */}
        <div
          className="flex space-x-2 animate-slide-up"
          style={{ animationDelay: "0.2s" }}
        >
          {["all", "active", "completed"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-1.5 rounded-full text-xs font-semibold capitalize transition-all ${
                filter === f
                  ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/30"
                  : "bg-white/5 text-slate-400 hover:bg-white/10"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* List Section */}
        <div
          className="space-y-3 animate-slide-up"
          style={{ animationDelay: "0.3s" }}
        >
          {filteredTodos.length > 0 ? (
            filteredTodos.map((todo) => (
              <div
                key={todo.id}
                className="group glass rounded-2xl p-4 flex items-center space-x-4 transition-all hover:bg-white/[0.08] animate-fade-in"
              >
                <button
                  onClick={() => toggleTodo(todo.id)}
                  className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${
                    todo.completed
                      ? "bg-indigo-500 border-indigo-500 text-white"
                      : "border-slate-600 hover:border-indigo-400"
                  }`}
                >
                  {todo.completed && (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-4 w-4"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </button>

                <span
                  className={`flex-1 text-slate-200 transition-all ${todo.completed ? "line-through text-slate-500" : ""}`}
                >
                  {todo.text}
                </span>

                <button
                  onClick={() => deleteTodo(todo.id)}
                  className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-red-400 transition-all"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
              </div>
            ))
          ) : (
            <div className="text-center py-12 glass rounded-3xl border-dashed">
              <p className="text-slate-500 font-light">No tasks found</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-8 text-center text-slate-600 text-xs">
          Built with React & Tailwind CSS • Syncs to LocalStorage
        </div>
      </div>
    </div>
  );
};

export default App;
