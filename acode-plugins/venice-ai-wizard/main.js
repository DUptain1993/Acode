/**
 * Venice AI Coding Wizard — Acode Plugin v2.0.0
 * Agentic coding assistant with full file system tools.
 */
(function () {
  "use strict";

  var PLUGIN_ID = "venice-ai-wizard";
  var STORAGE_KEY = "venice_ai_v2";
  var VENICE_BASE = "https://api.venice.ai/api/v1";
  var MAX_TOOL_ITER = 10;

  var MODELS = [
    ["gemma-4-uncensored", "Gemma 4 Uncensored"],
    ["llama-3.3-70b", "Llama 3.3 70B"],
    ["deepseek-r1-671b", "DeepSeek R1 671B"],
    ["qwen-2.5-coder-32b-instruct", "Qwen 2.5 Coder 32B"],
    ["mistral-31-24b", "Mistral 3.1 24B"],
    ["venice-uncensored", "Venice Uncensored"],
    ["llama-3.2-3b", "Llama 3.2 3B (Fast)"],
  ];

  var DEFAULT_SYSTEM_PROMPT =
    "You are an expert AI coding assistant embedded in Acode, a mobile code editor.\n" +
    "You have tools to read, write, edit, list, and search project files — use them proactively.\n\n" +
    "WORKFLOW:\n" +
    "1. Call get_project_structure first to understand the project layout\n" +
    "2. Read relevant files before modifying them\n" +
    "3. Use edit_file for targeted changes; write_file only for new files or full rewrites\n" +
    "4. Deliver complete, working code — never use placeholders like '// TODO'\n" +
    "5. After changes, briefly explain what you did and what to test\n\n" +
    "Use tools autonomously rather than asking users to do things manually.";

  /* ── Settings ────────────────────────────────────────────────────────────── */
  function defaults() {
    return {
      apiKey: "",
      model: "gemma-4-uncensored",
      temperature: "0.7",
      maxTokens: "4096",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };
  }

  function loadCfg() {
    try {
      var r = localStorage.getItem(STORAGE_KEY);
      if (r) return Object.assign(defaults(), JSON.parse(r));
    } catch (_) {}
    return defaults();
  }

  var cfg = loadCfg();

  function saveCfg() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (_) {}
  }

  /* ── Tool definitions (OpenAI format) ───────────────────────────────────── */
  var TOOLS = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the full content of a file in the project",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from project root, e.g. src/main.js" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or fully overwrite a file. Opens it in the editor.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from project root" },
            content: { type: "string", description: "Complete file content" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a file by replacing a specific unique string. Preferred for targeted changes.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from project root" },
            old_str: { type: "string", description: "Exact text to replace (must be unique in file)" },
            new_str: { type: "string", description: "Replacement text" }
          },
          required: ["path", "old_str", "new_str"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List files and folders in a directory",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path, or '.' for project root" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_project_structure",
        description: "Get a tree overview of the project (2 levels deep)",
        parameters: { type: "object", properties: {}, required: [] }
      }
    },
    {
      type: "function",
      function: {
        name: "search_in_files",
        description: "Search for text across all project files",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search for" },
            path: { type: "string", description: "Directory to search (default: project root)" }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_open_files",
        description: "Get all files currently open in the editor with their content",
        parameters: { type: "object", properties: {}, required: [] }
      }
    },
    {
      type: "function",
      function: {
        name: "insert_at_cursor",
        description: "Insert text at the current cursor position in the active editor",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to insert" }
          },
          required: ["text"]
        }
      }
    }
  ];

  /* ── File system ─────────────────────────────────────────────────────────── */
  function getFS() {
    try { var f = acode.require("fsOperation"); if (f) return f; } catch (_) {}
    return window.fsOperation || null;
  }

  function getProjectRoot() {
    try {
      var af = acode.require("addedfolder");
      if (af && af.length) return (af[0].url || af[0].uri || "").replace(/\/$/, "");
    } catch (_) {}
    try {
      if (window.addedFolder && window.addedFolder.length) {
        return (window.addedFolder[0].url || window.addedFolder[0].uri || "").replace(/\/$/, "");
      }
    } catch (_) {}
    try {
      var em = window.editorManager;
      if (em && em.activeFile && em.activeFile.location) {
        return em.activeFile.location.replace(/\/$/, "");
      }
    } catch (_) {}
    return null;
  }

  function resolvePath(rel) {
    var root = getProjectRoot();
    if (!root) throw new Error("No project folder is open. Please open a folder first.");
    rel = (rel || ".").replace(/^\.?\//g, "");
    if (!rel || rel === ".") return root;
    return root + "/" + rel;
  }

  async function lsDir(url) {
    var fs = getFS();
    if (!fs) throw new Error("File system not available");
    var obj = fs(url);
    if (obj.lsDir) return obj.lsDir();
    if (obj.listDir) return obj.listDir();
    if (obj.list) return obj.list();
    throw new Error("lsDir not supported in this Acode version");
  }

  async function toolReadFile(path) {
    try {
      var url = resolvePath(path);
      var fs = getFS();
      if (!fs) return { error: "File system unavailable" };
      var content = await fs(url).readFile("utf-8");
      return { success: true, path: path, content: content.slice(0, 100000) };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  async function toolWriteFile(path, content) {
    try {
      var url = resolvePath(path);
      var fs = getFS();
      if (!fs) return { error: "File system unavailable" };
      var parts = url.split("/");
      var fname = parts.pop();
      var dir = parts.join("/");
      var exists = false;
      try { exists = !!(await fs(url).exists()); } catch (_) {}
      if (exists) {
        await fs(url).writeFile(content);
      } else {
        await fs(dir).createFile(fname, content);
      }
      try { acode.newEditorFile(path, { text: content }); } catch (_) {}
      return { success: true, message: "Written: " + path };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  async function toolEditFile(path, oldStr, newStr) {
    try {
      var r = await toolReadFile(path);
      if (r.error) return r;
      var idx = r.content.indexOf(oldStr);
      if (idx === -1) return { error: "old_str not found in " + path + ". Check for exact whitespace/indentation." };
      var count = r.content.split(oldStr).length - 1;
      if (count > 1) return { error: "old_str appears " + count + " times — make it more specific." };
      var newContent = r.content.slice(0, idx) + newStr + r.content.slice(idx + oldStr.length);
      var fs = getFS();
      await fs(resolvePath(path)).writeFile(newContent);
      return { success: true, message: "Edited: " + path };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  async function toolListDirectory(path) {
    try {
      var url = resolvePath(path || ".");
      var entries = await lsDir(url);
      return {
        success: true,
        path: path,
        entries: entries.map(function (e) {
          return { name: e.name, type: e.isDirectory ? "dir" : "file" };
        })
      };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  async function toolGetProjectStructure() {
    try {
      var root = getProjectRoot();
      if (!root) return { error: "No project folder open" };
      var lines = [];

      async function walk(url, prefix, depth) {
        if (depth > 2) return;
        var entries;
        try { entries = await lsDir(url); } catch (_) { return; }
        entries.sort(function (a, b) {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name < b.name ? -1 : 1;
        });
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (e.name.charAt(0) === "." || e.name === "node_modules") continue;
          lines.push(prefix + e.name + (e.isDirectory ? "/" : ""));
          if (e.isDirectory && depth < 2) {
            await walk(url + "/" + e.name, prefix + "  ", depth + 1);
          }
        }
      }

      await walk(root, "", 0);
      return { success: true, structure: lines.join("\n") || "(empty project)" };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  async function toolSearchInFiles(query, searchPath) {
    try {
      var rootUrl = resolvePath(searchPath || ".");
      var results = [];

      async function searchDir(url, rel) {
        if (results.length >= 40) return;
        var entries;
        try { entries = await lsDir(url); } catch (_) { return; }
        for (var i = 0; i < entries.length && results.length < 40; i++) {
          var e = entries[i];
          if (e.name.charAt(0) === "." || e.name === "node_modules" || e.name === ".git") continue;
          var childUrl = url + "/" + e.name;
          var childRel = rel ? rel + "/" + e.name : e.name;
          if (e.isDirectory) {
            await searchDir(childUrl, childRel);
          } else {
            try {
              var text = await getFS()(childUrl).readFile("utf-8");
              var lines = text.split("\n");
              for (var j = 0; j < lines.length && results.length < 40; j++) {
                if (lines[j].toLowerCase().indexOf(query.toLowerCase()) !== -1) {
                  results.push({ file: childRel, line: j + 1, text: lines[j].trim().slice(0, 120) });
                }
              }
            } catch (_) {}
          }
        }
      }

      await searchDir(rootUrl, "");
      return { success: true, query: query, matches: results };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  function toolGetOpenFiles() {
    try {
      var em = window.editorManager;
      if (!em || !em.files) return { error: "No editor available" };
      var files = em.files.map(function (f) {
        var content = "";
        try {
          if (em.activeFile === f && em.editor && em.editor.getValue) {
            content = em.editor.getValue();
          } else if (f.session && f.session.doc && f.session.doc.toString) {
            content = f.session.doc.toString();
          }
        } catch (_) {}
        return {
          name: f.filename || f.name || "untitled",
          active: f === em.activeFile,
          content: content.slice(0, 50000)
        };
      });
      return { success: true, files: files };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  function toolInsertAtCursor(text) {
    try {
      var editor = window.editorManager && window.editorManager.editor;
      if (!editor || !editor.insert) return { error: "No active editor" };
      editor.insert(String(text));
      return { success: true };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  async function executeTool(name, args) {
    switch (name) {
      case "read_file":            return toolReadFile(args.path);
      case "write_file":           return toolWriteFile(args.path, args.content);
      case "edit_file":            return toolEditFile(args.path, args.old_str, args.new_str);
      case "list_directory":       return toolListDirectory(args.path);
      case "get_project_structure":return toolGetProjectStructure();
      case "search_in_files":      return toolSearchInFiles(args.query, args.path);
      case "get_open_files":       return toolGetOpenFiles();
      case "insert_at_cursor":     return toolInsertAtCursor(args.text);
      default: return { error: "Unknown tool: " + name };
    }
  }

  /* ── Venice API ──────────────────────────────────────────────────────────── */
  async function callVenice(messages, opts) {
    if (!cfg.apiKey) throw new Error("No API key — open ⚙ settings and enter your Venice AI key.");
    opts = opts || {};

    var useTools = !!(opts.tools && opts.tools.length);
    var useStream = !useTools && typeof opts.onChunk === "function";

    var body = {
      model: cfg.model,
      messages: messages,
      temperature: parseFloat(cfg.temperature) || 0.7,
      max_tokens: parseInt(cfg.maxTokens, 10) || 4096,
      stream: useStream,
    };

    if (useTools) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }

    var res = await fetch(VENICE_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      var errMsg = "Venice AI error " + res.status;
      try { var ej = await res.json(); errMsg = (ej.error && ej.error.message) || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }

    if (useStream) {
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var full = "";
      var buf = "";
      while (true) {
        var ch = await reader.read();
        if (ch.done) break;
        buf += dec.decode(ch.value, { stream: true });
        var ls = buf.split("\n"); buf = ls.pop();
        for (var i = 0; i < ls.length; i++) {
          var t = ls[i].trim();
          if (!t || t === "data: [DONE]") continue;
          if (t.indexOf("data: ") === 0) {
            try {
              var j = JSON.parse(t.slice(6));
              var d = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || "";
              if (d) { full += d; opts.onChunk(d, full); }
            } catch (_) {}
          }
        }
      }
      return { content: full, tool_calls: null };
    }

    var data = await res.json();
    var choice = data.choices && data.choices[0];
    if (!choice) throw new Error("Empty response from Venice AI");
    return {
      content: choice.message.content || "",
      tool_calls: choice.message.tool_calls || null,
      finish_reason: choice.finish_reason,
    };
  }

  /* ── Agent loop ──────────────────────────────────────────────────────────── */
  var conversationHistory = [];
  var toolsSupported = true;

  function buildMessages() {
    var out = [{ role: "system", content: cfg.systemPrompt }];
    for (var i = 0; i < conversationHistory.length; i++) {
      var m = conversationHistory[i];
      var msg = { role: m.role, content: m.content != null ? m.content : "" };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      out.push(msg);
    }
    return out;
  }

  async function runAgent(userText, onFirstResponse) {
    var userContent = userText;
    try {
      var em = window.editorManager;
      if (em && em.activeFile) {
        var name = em.activeFile.filename || em.activeFile.name || "untitled";
        var body = em.editor && em.editor.getValue ? em.editor.getValue() : "";
        if (body) userContent = "Active file (" + name + "):\n```\n" + body.slice(0, 30000) + "\n```\n\n---\n" + userText;
      }
    } catch (_) {}

    conversationHistory.push({ role: "user", content: userContent });

    var agentContainer = null;
    var iter = 0;
    var firstCall = true;

    while (iter < MAX_TOOL_ITER) {
      iter++;
      var msgs = buildMessages();
      var callOpts = toolsSupported ? { tools: TOOLS } : {};
      var result;

      try {
        result = await callVenice(msgs, callOpts);
      } catch (e) {
        if (toolsSupported && (e.message.indexOf("400") !== -1 || e.message.toLowerCase().indexOf("tool") !== -1)) {
          toolsSupported = false;
          result = await callVenice(msgs, {});
        } else {
          throw e;
        }
      }

      if (firstCall) {
        firstCall = false;
        onFirstResponse();
        agentContainer = createAgentContainer();
      }

      if (toolsSupported && result.tool_calls && result.tool_calls.length) {
        if (result.content) appendThinkingText(agentContainer, result.content);

        var assistantMsg = { role: "assistant", content: result.content || null, tool_calls: result.tool_calls };
        conversationHistory.push(assistantMsg);

        for (var i = 0; i < result.tool_calls.length; i++) {
          var tc = result.tool_calls[i];
          var tname = tc.function && tc.function.name || "unknown";
          var targs = {};
          try { targs = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}

          var handle = appendToolCard(agentContainer, tname, targs);
          var tresult = await executeTool(tname, targs);
          finalizeToolCard(handle, tresult);

          conversationHistory.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(tresult),
          });
        }
      } else {
        var finalText = result.content || "(no response)";
        conversationHistory.push({ role: "assistant", content: finalText });
        renderFinalIntoContainer(agentContainer, finalText);
        return finalText;
      }
    }

    var hitLimit = "[Reached max tool iterations]";
    if (agentContainer) renderFinalIntoContainer(agentContainer, hitLimit);
    conversationHistory.push({ role: "assistant", content: hitLimit });
    return hitLimit;
  }

  /* ── Editor helpers ──────────────────────────────────────────────────────── */
  function insertIntoEditor(text) {
    try {
      var editor = window.editorManager && window.editorManager.editor;
      if (!editor || !editor.insert) return false;
      editor.insert(String(text)); return true;
    } catch (_) { return false; }
  }

  function replaceEditorContent(text) {
    try {
      var em = window.editorManager;
      if (!em || !em.editor) return false;
      em.editor.dispatch({ changes: { from: 0, to: em.editor.state.doc.length, insert: String(text) } });
      return true;
    } catch (_) { return false; }
  }

  function createNewFile(name, content) {
    try { acode.newEditorFile(name, { text: content, isUnsaved: true }); return true; } catch (_) { return false; }
  }

  /* ── DOM helpers ─────────────────────────────────────────────────────────── */
  function el(tag, cls) {
    var e = document.createElement(tag); if (cls) e.className = cls; return e;
  }

  function mkBtn(label, cls, fn) {
    var b = el("button", cls); b.textContent = label; b.onclick = fn; return b;
  }

  function toast(msg) {
    try { acode.require("toast")(msg, 2000); } catch (_) {}
  }

  /* ── CSS — all colors explicit, no CSS variable inheritance ─────────────── */
  var CSS = [
    ".vai{display:flex;flex-direction:column;height:100%;background:#1e1e2e;font-size:13px;font-family:inherit;color:#cdd6f4;}",
    ".vai-hd{display:flex;align-items:center;padding:8px 10px;background:#181825;border-bottom:1px solid #313244;gap:6px;flex-shrink:0;}",
    ".vai-hd-title{flex:1;font-weight:600;font-size:13px;color:#cdd6f4;}",
    ".vai-model{font-size:10px;background:#313244;border-radius:4px;padding:2px 7px;color:#a6e3a1;cursor:pointer;white-space:nowrap;border:none;}",
    ".vai-sett{cursor:pointer;font-size:18px;color:#6c7086;}",
    ".vai-pb{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#11111b;border-bottom:1px solid #313244;flex-shrink:0;}",
    ".vai-pb-txt{flex:1;font-size:10px;color:#6c7086;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;font-style:italic;}",
    ".vai-pb-btn{font-size:10px;padding:2px 7px;background:transparent;border:1px solid #45475a;border-radius:4px;color:#89b4fa;cursor:pointer;flex-shrink:0;}",
    ".vai-pe{display:none;flex-direction:column;gap:4px;padding:6px 8px;background:#11111b;border-bottom:1px solid #313244;flex-shrink:0;}",
    ".vai-pe-lbl{font-size:10px;color:#89b4fa;font-weight:600;}",
    ".vai-pe-ta{width:100%;min-height:80px;max-height:200px;resize:vertical;background:#181825;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-size:12px;padding:6px 8px;box-sizing:border-box;outline:none;line-height:1.4;}",
    ".vai-pe-row{display:flex;gap:4px;justify-content:flex-end;margin-top:2px;}",
    ".vai-msgs{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px;min-height:0;}",
    ".vai-u{border-radius:8px 8px 2px 8px;padding:8px 12px;background:#313244;color:#cdd6f4;align-self:flex-end;max-width:90%;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5;}",
    ".vai-a{border-radius:8px 8px 8px 2px;padding:10px 12px;background:#181825;border:1px solid #313244;color:#cdd6f4;align-self:flex-start;width:100%;word-break:break-word;font-size:13px;line-height:1.5;box-sizing:border-box;}",
    ".vai-sys{color:#6c7086;font-size:11px;text-align:center;align-self:center;padding:4px 0;}",
    ".vai-err{border-radius:8px;padding:8px 12px;background:#2a1020;border:1px solid #f38ba8;color:#f38ba8;font-size:12px;}",
    ".vai-tool{border-radius:6px;padding:6px 10px;background:#12121f;border:1px solid #313244;font-size:11px;color:#a6adc8;margin:3px 0;}",
    ".vai-tool-hdr{display:flex;align-items:center;gap:6px;margin-bottom:2px;}",
    ".vai-tool-name{color:#89dceb;font-weight:600;font-family:monospace;}",
    ".vai-tool-args{color:#585b70;font-size:10px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}",
    ".vai-tool-ok{font-size:10px;color:#a6e3a1;margin-top:2px;}",
    ".vai-tool-fail{font-size:10px;color:#f38ba8;margin-top:2px;}",
    ".vai-think{font-size:11px;color:#585b70;font-style:italic;padding:2px 4px;margin:2px 0;}",
    ".vai-spin{display:inline-block;width:11px;height:11px;border:2px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:vai-spin .8s linear infinite;flex-shrink:0;}",
    "@keyframes vai-spin{to{transform:rotate(360deg)}}",
    ".vai-typing{display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:8px;background:#181825;border:1px solid #313244;align-self:flex-start;color:#6c7086;font-size:12px;}",
    ".vai-pre{background:#11111b;border-radius:6px;padding:8px 10px;overflow-x:auto;margin:6px 0;}",
    ".vai-pre-lang{font-size:10px;color:#89dceb;display:block;margin-bottom:4px;font-family:monospace;}",
    ".vai-pre code{color:#cdd6f4;display:block;white-space:pre;font-size:12px;line-height:1.4;}",
    ".vai-cact{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;}",
    ".vai-md-p{margin:4px 0;color:#cdd6f4;}",
    ".vai-md-h{font-weight:700;margin:8px 0 4px;color:#89b4fa;}",
    ".vai-md-ul{margin:4px 0 4px 16px;color:#cdd6f4;}",
    ".vai-md-li{margin:2px 0;color:#cdd6f4;}",
    ".vai-ic{background:#11111b;border-radius:3px;padding:1px 4px;font-size:12px;color:#89dceb;font-family:monospace;}",
    ".vai-btn{padding:4px 10px;border-radius:5px;border:none;cursor:pointer;font-size:11px;outline:none;}",
    ".vai-btn:active{opacity:.7;}",
    ".vai-btn-p{background:#89b4fa;color:#1e1e2e;font-weight:600;}",
    ".vai-btn-s{background:#313244;color:#cdd6f4;}",
    ".vai-btn-g{background:#a6e3a1;color:#1e1e2e;font-weight:600;}",
    ".vai-inp{padding:8px;background:#181825;border-top:1px solid #313244;display:flex;flex-direction:column;gap:6px;flex-shrink:0;}",
    ".vai-ta{width:100%;min-height:60px;max-height:150px;resize:vertical;background:#11111b;border:1px solid #313244;border-radius:6px;color:#cdd6f4;font-size:13px;padding:8px;box-sizing:border-box;outline:none;line-height:1.4;}",
    ".vai-ta:focus{border-color:#89b4fa;}",
    ".vai-irow{display:flex;gap:6px;align-items:center;}",
    ".vai-send{padding:8px 18px;background:#89b4fa;color:#1e1e2e;border:none;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;flex-shrink:0;}",
    ".vai-send:disabled{opacity:.4;cursor:not-allowed;}",
    ".vai-clr{padding:8px 10px;background:#313244;color:#a6adc8;border:none;border-radius:6px;font-size:12px;cursor:pointer;}",
  ].join("");

  function injectStyles() {
    if (document.getElementById("vai-css")) return;
    var s = document.createElement("style"); s.id = "vai-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ── Markdown renderer ───────────────────────────────────────────────────── */
  function renderMd(md) {
    var frag = document.createDocumentFragment();
    var lines = String(md || "").split("\n");
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (line.indexOf("```") === 0) {
        var lang = line.slice(3).trim();
        var cLines = []; i++;
        while (i < lines.length && lines[i].indexOf("```") !== 0) { cLines.push(lines[i]); i++; }
        i++;
        frag.appendChild(makeCodeBlock(lang, cLines.join("\n").replace(/\s+$/, "")));
        continue;
      }
      var hm = line.match(/^(#{1,4})\s+(.*)/);
      if (hm) {
        var h = el("div", "vai-md-h"); h.style.fontSize = (16 - hm[1].length) + "px";
        h.appendChild(renderInline(hm[2])); frag.appendChild(h); i++; continue;
      }
      if (/^[-*]\s/.test(line)) {
        var ul = el("ul", "vai-md-ul");
        while (i < lines.length && /^[-*]\s/.test(lines[i])) {
          var li = el("li", "vai-md-li"); li.appendChild(renderInline(lines[i].slice(2)));
          ul.appendChild(li); i++;
        }
        frag.appendChild(ul); continue;
      }
      if (!line.trim()) { i++; continue; }
      var p = el("p", "vai-md-p"); p.appendChild(renderInline(line)); frag.appendChild(p); i++;
    }
    return frag;
  }

  function renderInline(text) {
    var span = el("span"); span.style.color = "#cdd6f4";
    var parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.length > 2 && p.charAt(0) === "`" && p.charAt(p.length - 1) === "`") {
        var c = el("code", "vai-ic"); c.textContent = p.slice(1, -1); span.appendChild(c);
      } else if (p.length > 4 && p.indexOf("**") === 0 && p.lastIndexOf("**") === p.length - 2) {
        var b = el("b"); b.textContent = p.slice(2, -2); span.appendChild(b);
      } else if (p.length > 2 && p.charAt(0) === "*" && p.charAt(p.length - 1) === "*") {
        var em = el("em"); em.textContent = p.slice(1, -1); span.appendChild(em);
      } else {
        span.appendChild(document.createTextNode(p));
      }
    }
    return span;
  }

  function makeCodeBlock(lang, code) {
    var pre = el("div", "vai-pre");
    if (lang) { var badge = el("span", "vai-pre-lang"); badge.textContent = lang; pre.appendChild(badge); }
    var cEl = el("code"); cEl.textContent = code; pre.appendChild(cEl);
    var acts = el("div", "vai-cact");
    acts.appendChild(mkBtn("Insert", "vai-btn vai-btn-p", function () {
      insertIntoEditor(code) ? toast("Inserted ✓") : toast("No active editor");
    }));
    acts.appendChild(mkBtn("Replace file", "vai-btn vai-btn-s", function () {
      replaceEditorContent(code) ? toast("File replaced ✓") : toast("No active editor");
    }));
    acts.appendChild(mkBtn("New file…", "vai-btn vai-btn-g", function () {
      var name = prompt("Filename:", "untitled." + (lang || "txt")) || "";
      if (name.trim()) { createNewFile(name.trim(), code); toast("Opened " + name.trim()); }
    }));
    acts.appendChild(mkBtn("Copy", "vai-btn vai-btn-s", function () {
      try { navigator.clipboard.writeText(code).then(function () { toast("Copied ✓"); }); } catch (_) {}
    }));
    pre.appendChild(acts);
    return pre;
  }

  /* ── Message rendering ───────────────────────────────────────────────────── */
  var $msgs = null;

  function scroll() { if ($msgs) $msgs.scrollTop = $msgs.scrollHeight; }

  function appendEl(node) { if ($msgs) { $msgs.appendChild(node); scroll(); } return node; }

  function addSysMsg(text) { var d = el("div", "vai-sys"); d.textContent = text; appendEl(d); }

  function addErrMsg(text) { var d = el("div", "vai-err"); d.textContent = "⚠ " + text; appendEl(d); }

  function addUserBubble(text) { var d = el("div", "vai-u"); d.textContent = text; appendEl(d); }

  function addTyping() {
    var d = el("div", "vai-typing"); d.id = "vai-typ";
    var sp = el("div", "vai-spin"); d.appendChild(sp);
    d.appendChild(document.createTextNode(" Thinking…")); appendEl(d); return d;
  }

  function removeTyping() { var e = document.getElementById("vai-typ"); if (e && e.parentNode) e.parentNode.removeChild(e); }

  function createAgentContainer() { return appendEl(el("div", "vai-a")); }

  function appendThinkingText(c, text) {
    var d = el("div", "vai-think"); d.textContent = text; c.appendChild(d); scroll();
  }

  function appendToolCard(c, name, args) {
    var card = el("div", "vai-tool");
    var hdr = el("div", "vai-tool-hdr");
    var sp = el("div", "vai-spin");
    var nm = el("span", "vai-tool-name"); nm.textContent = name;
    hdr.appendChild(sp); hdr.appendChild(nm);
    var argParts = [];
    for (var k in args) {
      if (!Object.prototype.hasOwnProperty.call(args, k)) continue;
      var v = typeof args[k] === "string" ? args[k] : JSON.stringify(args[k]);
      argParts.push(k + ": " + (v.length > 50 ? v.slice(0, 50) + "…" : v));
    }
    var argEl = el("div", "vai-tool-args"); argEl.textContent = argParts.join(", ");
    card.appendChild(hdr); card.appendChild(argEl);
    c.appendChild(card); scroll();
    return { card: card, spinner: sp };
  }

  function finalizeToolCard(handle, result) {
    if (!handle) return;
    var sp = handle.spinner;
    if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
    var ok = !result.error;
    var res = el("div", ok ? "vai-tool-ok" : "vai-tool-fail");
    var summary = result.error || result.message || "";
    if (result.entries) summary = result.entries.length + " entries";
    if (result.matches) summary = result.matches.length + " matches";
    if (result.structure) summary = "structure loaded";
    if (result.files) summary = result.files.length + " open files";
    if (result.content) summary = result.content.length + " chars read";
    res.textContent = (ok ? "✓ " : "✗ ") + summary;
    handle.card.appendChild(res);
    var hdr = handle.card.querySelector(".vai-tool-hdr");
    if (hdr) hdr.insertBefore(document.createTextNode(ok ? "✓ " : "✗ "), hdr.firstChild);
    scroll();
  }

  function renderFinalIntoContainer(c, text) {
    c.appendChild(renderMd(text)); scroll();
  }

  /* ── Panel builder ───────────────────────────────────────────────────────── */
  var $modelBadge = null;
  var $promptPreview = null;
  var $promptEditor = null;
  var $ta = null;
  var $sendBtn = null;
  var isBusy = false;

  function getModelLabel(id) {
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i][0] === id) return MODELS[i][1];
    return id;
  }

  function buildPanel(container) {
    injectStyles();
    var panel = el("div", "vai");

    /* header */
    var hd = el("div", "vai-hd");
    var hdI = el("span", "icon wand-sparkles"); hdI.style.color = "#89b4fa";
    var hdT = el("span", "vai-hd-title"); hdT.textContent = "Venice AI";
    $modelBadge = el("button", "vai-model"); $modelBadge.textContent = getModelLabel(cfg.model);
    $modelBadge.title = "Click to change model"; $modelBadge.onclick = pickModel;
    var settI = el("span", "vai-sett icon settings"); settI.title = "Settings"; settI.onclick = openSettings;
    hd.appendChild(hdI); hd.appendChild(hdT); hd.appendChild($modelBadge); hd.appendChild(settI);

    /* prompt bar */
    var pb = el("div", "vai-pb");
    $promptPreview = el("span", "vai-pb-txt"); $promptPreview.onclick = togglePromptEditor;
    refreshPromptPreview();
    var pbBtn = el("button", "vai-pb-btn"); pbBtn.textContent = "Edit prompt"; pbBtn.onclick = togglePromptEditor;
    pb.appendChild($promptPreview); pb.appendChild(pbBtn);

    /* prompt editor */
    $promptEditor = el("div", "vai-pe");
    var peLbl = el("div", "vai-pe-lbl"); peLbl.textContent = "System Prompt";
    var peTA = el("textarea", "vai-pe-ta"); peTA.value = cfg.systemPrompt;
    var peRow = el("div", "vai-pe-row");
    peRow.appendChild(mkBtn("Reset", "vai-btn vai-btn-s", function () { peTA.value = DEFAULT_SYSTEM_PROMPT; }));
    peRow.appendChild(mkBtn("Cancel", "vai-btn vai-btn-s", function () {
      peTA.value = cfg.systemPrompt; $promptEditor.style.display = "none";
    }));
    peRow.appendChild(mkBtn("Save", "vai-btn vai-btn-p", function () {
      cfg.systemPrompt = peTA.value.trim() || DEFAULT_SYSTEM_PROMPT;
      saveCfg(); refreshPromptPreview(); $promptEditor.style.display = "none"; toast("Saved ✓");
    }));
    $promptEditor.appendChild(peLbl); $promptEditor.appendChild(peTA); $promptEditor.appendChild(peRow);

    /* messages */
    $msgs = el("div", "vai-msgs");

    /* input */
    var inp = el("div", "vai-inp");
    $ta = el("textarea", "vai-ta");
    $ta.setAttribute("placeholder", "Ask me to read, write, edit, or search your project files… (Enter to send, Shift+Enter for newline)");
    $ta.setAttribute("rows", "3");
    $ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    var iRow = el("div", "vai-irow");
    $sendBtn = el("button", "vai-send"); $sendBtn.textContent = "Send"; $sendBtn.onclick = sendMessage;
    var clrBtn = el("button", "vai-clr"); clrBtn.textContent = "Clear"; clrBtn.onclick = clearChat;
    iRow.appendChild($sendBtn); iRow.appendChild(clrBtn);
    inp.appendChild($ta); inp.appendChild(iRow);

    /* assemble */
    panel.appendChild(hd);
    panel.appendChild(pb);
    panel.appendChild($promptEditor);
    panel.appendChild($msgs);
    panel.appendChild(inp);
    container.appendChild(panel);

    addSysMsg("Venice AI ready — I can read, write, edit, and search your project files. What would you like to build?");

    return function () {
      var s = document.getElementById("vai-css"); if (s && s.parentNode) s.parentNode.removeChild(s);
    };
  }

  function refreshPromptPreview() {
    if (!$promptPreview) return;
    var s = cfg.systemPrompt;
    $promptPreview.textContent = "Prompt: " + (s.length > 60 ? s.slice(0, 60) + "…" : s);
  }

  function togglePromptEditor() {
    if (!$promptEditor) return;
    var open = $promptEditor.style.display === "flex";
    $promptEditor.style.display = open ? "none" : "flex";
    if (!open) {
      var ta = $promptEditor.querySelector(".vai-pe-ta"); if (ta) ta.value = cfg.systemPrompt;
    }
  }

  /* ── Send flow ───────────────────────────────────────────────────────────── */
  async function sendMessage() {
    if (isBusy || !$ta) return;
    var userText = $ta.value.trim();
    if (!userText) return;
    if (!cfg.apiKey) { addErrMsg("Enter your Venice AI API key in ⚙ settings first."); openSettings(); return; }

    $ta.value = "";
    isBusy = true;
    if ($sendBtn) $sendBtn.disabled = true;
    addUserBubble(userText);
    addTyping();
    var typingRemoved = false;

    function onFirstResponse() {
      if (!typingRemoved) { removeTyping(); typingRemoved = true; }
    }

    try {
      await runAgent(userText, onFirstResponse);
    } catch (err) {
      onFirstResponse();
      addErrMsg(err && err.message ? err.message : String(err));
    } finally {
      isBusy = false;
      if ($sendBtn) $sendBtn.disabled = false;
      if ($ta) $ta.focus();
    }
  }

  function clearChat() {
    conversationHistory = [];
    if ($msgs) $msgs.innerHTML = "";
    addSysMsg("Chat cleared. File tools are still active.");
  }

  /* ── Settings ────────────────────────────────────────────────────────────── */
  async function openSettings() {
    try {
      var appS = acode.require("settings");
      if (appS && appS.uiSettings && appS.uiSettings["plugin-" + PLUGIN_ID]) {
        appS.uiSettings["plugin-" + PLUGIN_ID].show(); return;
      }
    } catch (_) {}
    try {
      var vals = await acode.multiPrompt("Venice AI Settings", [
        { type: "text", id: "apiKey", placeholder: "Venice AI API Key", value: cfg.apiKey },
        { type: "text", id: "temperature", placeholder: "Temperature (0.0–1.0)", value: cfg.temperature },
        { type: "text", id: "maxTokens", placeholder: "Max Tokens", value: cfg.maxTokens },
      ]);
      if (!vals) return;
      if (vals.apiKey !== undefined) cfg.apiKey = vals.apiKey.trim();
      if (vals.temperature !== undefined) cfg.temperature = vals.temperature;
      if (vals.maxTokens !== undefined) cfg.maxTokens = vals.maxTokens;
      saveCfg(); toast("Settings saved ✓");
    } catch (_) {}
  }

  async function pickModel() {
    try {
      var sel = acode.require("select");
      var chosen = await sel("Venice AI Model", MODELS, { default: cfg.model });
      if (chosen) {
        cfg.model = chosen;
        if ($modelBadge) $modelBadge.textContent = getModelLabel(chosen);
        saveCfg(); toast("Model: " + getModelLabel(chosen));
      }
    } catch (_) {}
  }

  /* ── Acode settings list ─────────────────────────────────────────────────── */
  var settingsList = [
    { key: "apiKey",      text: "Venice AI API Key",  info: "Get free key at venice.ai",         value: cfg.apiKey,      prompt: "Enter API key",       promptType: "text" },
    { key: "model",       text: "AI Model",           info: "Venice AI model to use",             value: cfg.model,       select: MODELS, valueText: function (v) { return getModelLabel(v); } },
    { key: "temperature", text: "Temperature",        info: "0.0 = precise, 1.0 = creative",      value: cfg.temperature, prompt: "Temperature (0–1)",    promptType: "number" },
    { key: "maxTokens",   text: "Max Tokens",         info: "Max response length",                value: cfg.maxTokens,   prompt: "Max tokens",           promptType: "number" },
    { key: "systemPrompt",text: "System Prompt",      info: "Edit directly in the sidebar panel", value: "tap to edit",   chevron: true },
  ];

  function onSettingChange(key, value) {
    if (key === "systemPrompt") { togglePromptEditor(); return; }
    cfg[key] = value; saveCfg();
    if (key === "model" && $modelBadge) $modelBadge.textContent = getModelLabel(value);
  }

  /* ── Lifecycle ───────────────────────────────────────────────────────────── */
  function init() {
    try {
      var sa = acode.require("sidebarApps");
      if (!sa) { console.error("[Venice AI] sidebarApps unavailable"); return; }
      sa.add("wand-sparkles", PLUGIN_ID, "Venice AI", buildPanel);
    } catch (e) { console.error("[Venice AI] init:", e); }
  }

  function destroy() {
    try { acode.require("sidebarApps").remove(PLUGIN_ID); } catch (_) {}
    try { var s = document.getElementById("vai-css"); if (s && s.parentNode) s.parentNode.removeChild(s); } catch (_) {}
  }

  try {
    if (typeof acode !== "undefined") {
      acode.setPluginInit(PLUGIN_ID, init, { list: settingsList, cb: onSettingChange });
      acode.setPluginUnmount(PLUGIN_ID, destroy);
    }
  } catch (e) { console.error("[Venice AI] registration:", e); }
})();
