#!/usr/bin/env node
/**
 * Build Wayfound.html: one self-contained file that runs by double-click (file://), no network.
 *
 *   node tools/build_offline.mjs               write Wayfound.html
 *   node tools/build_offline.mjs --self-test   exercise the bundler on fixtures
 *   options: --out <file>   --data <dir>   --skip-smoke
 *
 * index.html is the source of truth. Local stylesheets and classic scripts are inlined where they
 * stand, every campus dataset in data/ is embedded as window.WAYFOUND_DATA[<file name>], and every ES module reachable
 * from a <script type="module"> is bundled into one module script.
 *
 * The bundler renames nothing. Each module body is wrapped in its own function scope, so two modules
 * may reuse the same top-level names. `export` declarations become the function's return value and
 * `import` statements become destructuring from the dependency's returned object, in dependency
 * order. An import or export form it does not understand stops the build with the file and line.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_SLOT = '<!--wayfound:module-bundle-->';
const MIME = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

class BuildError extends Error {}

function failAt(file, src, pos, message) {
  const line = src.slice(0, pos).split('\n').length;
  const lineEnd = src.indexOf('\n', pos);
  const excerpt = src.slice(pos, lineEnd < 0 ? src.length : lineEnd).trim().slice(0, 120);
  throw new BuildError(`${file}:${line}: ${message}\n    ${excerpt}`);
}

// ---------- a small JavaScript tokenizer ----------
// Enough lexing to know what is code and what is a string, template, regex or comment, and how
// deeply nested each token is. Statements are only rewritten at nesting depth 0.

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await']);

function tokenize(file, src) {
  const tokens = [];
  const n = src.length;
  let i = src.startsWith('#!') ? src.indexOf('\n') : 0;
  let depth = 0;
  let sawNewline = false;

  const push = (type, start, end, tokenDepth = depth) => {
    tokens.push({ type, text: src.slice(start, end), start, end, depth: tokenDepth, newlineBefore: sawNewline });
    sawNewline = false;
  };
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'word') return REGEX_AFTER_WORD.has(prev.text);
    if (prev.type === 'punct') return prev.text !== ')' && prev.text !== ']';
    return false; // after a number, string, template or regex a slash is division
  };
  const readString = (quote) => {
    const start = i++;
    while (i < n && src[i] !== quote) {
      if (src[i] === '\n') failAt(file, src, start, 'unterminated string');
      i += src[i] === '\\' ? 2 : 1;
    }
    if (i >= n) failAt(file, src, start, 'unterminated string');
    push('string', start, ++i);
  };
  const readTemplate = () => {
    const start = i++;
    const outerDepth = depth;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        i += 2;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        depth++;
        readCode(true); // returns just past the matching }
        depth--;
      } else {
        i++;
      }
    }
    if (i >= n) failAt(file, src, start, 'unterminated template literal');
    push('template', start, ++i, outerDepth);
  };
  const readRegex = () => {
    // Returns false when the slash turns out not to start a regex literal (regexes cannot span lines).
    let j = i + 1;
    let inClass = false;
    for (; j < n; j++) {
      const c = src[j];
      if (c === '\n') return false;
      if (c === '\\') j++;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    if (j >= n) return false;
    j++;
    while (j < n && /[a-z]/i.test(src[j])) j++;
    const start = i;
    i = j;
    push('regex', start, i);
    return true;
  };
  function readCode(insideTemplate) {
    const baseDepth = depth;
    while (i < n) {
      const c = src[i];
      if (c === '\n') {
        sawNewline = true;
        i++;
      } else if (c === ' ' || c === '\t' || c === '\r' || c === '\u00a0' || c === '\ufeff') {
        i++;
      } else if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
      } else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) failAt(file, src, i, 'unterminated comment');
        if (src.slice(i, end).includes('\n')) sawNewline = true;
        i = end + 2;
      } else if (c === '"' || c === "'") {
        readString(c);
      } else if (c === '`') {
        readTemplate();
      } else if (c === '/' && regexAllowed() && readRegex()) {
        // consumed a regex literal
      } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const start = i;
        while (i < n && /[0-9A-Za-z_.]/.test(src[i])) i++;
        push('number', start, i);
      } else if (/[A-Za-z_$#\u0080-\uffff]/.test(c)) {
        const start = i++;
        while (i < n && /[\w$\u0080-\uffff]/.test(src[i])) i++;
        push('word', start, i);
      } else if (c === '(' || c === '[' || c === '{') {
        push('punct', i, i + 1);
        depth++;
        i++;
      } else if (c === ')' || c === ']' || c === '}') {
        if (insideTemplate && c === '}' && depth === baseDepth) {
          i++;
          return;
        }
        if (--depth < 0) failAt(file, src, i, `unbalanced "${c}"`);
        push('punct', i, i + 1);
        i++;
      } else {
        push('punct', i, i + 1);
        i++;
      }
    }
    if (insideTemplate) failAt(file, src, n - 1, 'unterminated ${ } in a template literal');
  }
  readCode(false);
  if (depth !== 0) failAt(file, src, Math.max(0, n - 1), 'unbalanced brackets at the end of the file');
  return tokens;
}

const CONTINUES_AFTER = new Set(['new', 'typeof', 'void', 'delete', 'await', 'yield', 'in', 'instanceof', 'of',
  'return', 'throw', 'case', 'else', 'do', 'extends']);

/** A newline separates prev and next at the top level: does automatic semicolon insertion end the statement? */
function endsStatement(prev, next) {
  if (prev.type === 'punct' && !')]}'.includes(prev.text)) return false; // an operator or opener needs more
  if (prev.type === 'word' && CONTINUES_AFTER.has(prev.text)) return false;
  if (next.type === 'word') return next.text !== 'in' && next.text !== 'instanceof';
  if (next.type === 'punct') return '{@!~'.includes(next.text); // any other punctuator continues the expression
  return next.type !== 'template';
}

// ---------- module transform ----------

function transformModule(file, src) {
  const tokens = tokenize(file, src);
  const imports = []; // { spec, default, namespace, named: [[imported, local]], reexport? }
  const exports = []; // { name, local } | { name, from, imported } | { name, from, namespace } | { star, from }
  const edits = [];
  const warnings = [];

  const isPunct = (t, ch) => Boolean(t) && t.type === 'punct' && t.text === ch;
  const isWord = (t, word) => Boolean(t) && t.type === 'word' && (word === undefined || t.text === word);
  const at = (j) => tokens[Math.min(j, tokens.length - 1)].start;
  const blank = (start, end) => ({ start, end, text: src.slice(start, end).replace(/[^\n]/g, '') });
  const stringValue = (t) => {
    const inner = t.text.slice(1, -1);
    if (inner.includes('\\')) failAt(file, src, t.start, 'module specifiers with escapes are not supported');
    return inner;
  };
  const matchingClose = (open) => {
    const want = { '(': ')', '[': ']', '{': '}' }[tokens[open].text];
    for (let j = open + 1; j < tokens.length; j++) {
      if (tokens[j].depth === tokens[open].depth && isPunct(tokens[j], want)) return j;
    }
    return failAt(file, src, tokens[open].start, `no matching "${want}"`);
  };
  /** Parse `a, b as c` between braces. Returns [[first, second]] and the index after the closing brace. */
  const specifierList = (open, what) => {
    const close = matchingClose(open);
    const list = [];
    let j = open + 1;
    while (j < close) {
      if (!isWord(tokens[j])) failAt(file, src, at(j), `unsupported ${what} specifier (string names are not supported)`);
      const first = tokens[j++].text;
      let second = first;
      if (isWord(tokens[j], 'as')) {
        if (!isWord(tokens[j + 1])) failAt(file, src, at(j), `unsupported ${what} specifier`);
        second = tokens[j + 1].text;
        j += 2;
      }
      list.push([first, second]);
      if (isPunct(tokens[j], ',')) j++;
      else if (j !== close) failAt(file, src, at(j), `unsupported ${what} specifier list`);
    }
    return [list, close + 1];
  };
  const fromClause = (j, start) => {
    if (!isWord(tokens[j], 'from') || tokens[j + 1]?.type !== 'string') failAt(file, src, start, 'expected: from "./module.js"');
    return [stringValue(tokens[j + 1]), j + 2];
  };
  const finishStatement = (j, start) => {
    if ((isWord(tokens[j], 'with') || isWord(tokens[j], 'assert')) && isPunct(tokens[j + 1], '{')) {
      failAt(file, src, start, 'import attributes (with { ... }) are not supported');
    }
    return isPunct(tokens[j], ';') ? j + 1 : j;
  };

  const parseImport = (k) => {
    const start = tokens[k].start;
    const record = { spec: null, default: null, namespace: null, named: [] };
    let j = k + 1;
    if (tokens[j]?.type === 'string') {
      record.spec = stringValue(tokens[j++]);
    } else {
      if (isWord(tokens[j])) {
        record.default = tokens[j++].text;
        if (isPunct(tokens[j], ',')) j++;
        else if (!isWord(tokens[j], 'from')) failAt(file, src, start, 'unsupported import form');
      }
      if (isPunct(tokens[j], '*')) {
        if (!isWord(tokens[j + 1], 'as') || !isWord(tokens[j + 2])) failAt(file, src, start, 'unsupported import form');
        record.namespace = tokens[j + 2].text;
        j += 3;
      } else if (isPunct(tokens[j], '{')) {
        [record.named, j] = specifierList(j, 'import');
      }
      [record.spec, j] = fromClause(j, start);
    }
    j = finishStatement(j, start);
    imports.push(record);
    edits.push(blank(start, tokens[j - 1].end));
    return j - 1;
  };

  /** Names declared by `const a = ..., b = ...` starting at token j. */
  const declaredNames = (j, start) => {
    const names = [];
    for (;;) {
      if (!isWord(tokens[j])) {
        failAt(file, src, start, 'destructuring in an export declaration is not supported; declare first, then export { a, b }');
      }
      names.push(tokens[j++].text);
      let another = false;
      for (; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.depth !== 0) continue;
        if (isPunct(t, ';')) break;
        if (isPunct(t, ',')) {
          another = true;
          j++;
          break;
        }
        if (t.newlineBefore && endsStatement(tokens[j - 1], t)) break;
      }
      if (!another) return names;
    }
  };

  const parseExport = (k) => {
    const start = tokens[k].start;
    const j = k + 1;
    const t = tokens[j];
    const declarationName = (from) => {
      let d = from;
      if (isWord(tokens[d], 'async') && isWord(tokens[d + 1], 'function')) d++;
      if (!isWord(tokens[d], 'function') && !isWord(tokens[d], 'class')) return undefined;
      const nameAt = isPunct(tokens[d + 1], '*') ? d + 2 : d + 1;
      const named = isWord(tokens[nameAt]) && !(tokens[d].text === 'class' && tokens[nameAt].text === 'extends');
      return named ? tokens[nameAt].text : null; // null: an anonymous function or class
    };
    if (isWord(t, 'default')) {
      const name = declarationName(j + 1);
      if (name) {
        exports.push({ name: 'default', local: name });
        edits.push({ start, end: tokens[j + 1].start, text: '' });
      } else {
        exports.push({ name: 'default', local: '__wf_default' });
        edits.push({ start, end: tokens[j + 1].start, text: 'const __wf_default = ' });
      }
      return j;
    }
    const name = declarationName(j);
    if (name === null) failAt(file, src, start, 'an exported function or class needs a name');
    if (name) {
      exports.push({ name, local: name });
      edits.push({ start, end: t.start, text: '' });
      return k;
    }
    if (isWord(t, 'const') || isWord(t, 'let') || isWord(t, 'var')) {
      for (const declared of declaredNames(j + 1, start)) exports.push({ name: declared, local: declared });
      if (t.text !== 'const') {
        warnings.push(`${file}: "export ${t.text}" is read when a module imports it; later reassignment is not seen`);
      }
      edits.push({ start, end: t.start, text: '' });
      return k;
    }
    if (isPunct(t, '{')) {
      let [list, m] = specifierList(j, 'export');
      let from = null;
      if (isWord(tokens[m], 'from')) [from, m] = fromClause(m, start);
      m = finishStatement(m, start);
      for (const [local, exported] of list) {
        exports.push(from ? { name: exported, from, imported: local } : { name: exported, local });
      }
      if (from) imports.push({ spec: from, default: null, namespace: null, named: [], reexport: true });
      edits.push(blank(start, tokens[m - 1].end));
      return m - 1;
    }
    if (isPunct(t, '*')) {
      let m = j + 1;
      let namespace = null;
      if (isWord(tokens[m], 'as')) {
        if (!isWord(tokens[m + 1])) failAt(file, src, start, 'unsupported export form');
        namespace = tokens[m + 1].text;
        m += 2;
      }
      let from;
      [from, m] = fromClause(m, start);
      m = finishStatement(m, start);
      exports.push(namespace ? { name: namespace, from, namespace: true } : { star: true, from });
      imports.push({ spec: from, default: null, namespace: null, named: [], reexport: true });
      edits.push(blank(start, tokens[m - 1].end));
      return m - 1;
    }
    return failAt(file, src, start, 'unsupported export form');
  };

  let topLevelAwait = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'word' || isPunct(tokens[k - 1], '.')) continue;
    if (t.text === 'import') {
      const next = tokens[k + 1];
      if (isPunct(next, '.')) continue; // import.meta
      if (isPunct(next, '(')) {
        if (isPunct(tokens[matchingClose(k + 1) + 1], '{')) continue; // a method named import() { }
        failAt(file, src, t.start, 'dynamic import() cannot be bundled into the offline file; use a static import');
      }
      if (t.depth === 0) k = parseImport(k);
    } else if (t.text === 'export' && t.depth === 0) {
      k = parseExport(k);
    } else if (t.text === 'await' && t.depth === 0) {
      topLevelAwait = true;
    }
  }

  let code = '';
  let pos = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    code += src.slice(pos, edit.start) + edit.text;
    pos = edit.end;
  }
  code += src.slice(pos);
  return { file, code, imports, exports, warnings, topLevelAwait };
}

// ---------- bundler ----------

function resolveSpecifier(importer, spec) {
  const clean = spec.replace(/[?#].*$/, '');
  if (!/^\.\.?\//.test(clean)) {
    throw new BuildError(`${importer}: cannot bundle the import of "${spec}". Only relative imports of local modules `
      + 'are supported (MapLibre is the global `maplibregl`, loaded by a classic script).');
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(importer), clean));
}

/** Bundle the modules reachable from entryIds. readModule(id, importer) returns source text. */
function bundleModules(entryIds, readModule) {
  const modules = new Map();
  const order = [];
  const exportNames = (id) => {
    const names = new Set();
    for (const ex of modules.get(id).exports) {
      if (!ex.star) names.add(ex.name);
      else for (const name of exportNames(modules.get(id).deps.get(ex.from))) if (name !== 'default') names.add(name);
    }
    return names;
  };
  const requireExport = (id, spec, name) => {
    const dep = modules.get(id).deps.get(spec);
    const available = exportNames(dep);
    if (!available.has(name)) {
      throw new BuildError(`${id} imports "${name}" from "${spec}", but ${dep} only exports: ${[...available].join(', ') || '(nothing)'}`);
    }
  };
  const visit = (id, chain) => {
    if (modules.has(id)) return;
    if (chain.includes(id)) throw new BuildError(`circular import cannot be bundled: ${[...chain, id].join(' -> ')}`);
    const mod = transformModule(id, readModule(id, chain[chain.length - 1]));
    mod.deps = new Map();
    for (const imp of mod.imports) {
      mod.deps.set(imp.spec, resolveSpecifier(id, imp.spec));
      visit(mod.deps.get(imp.spec), [...chain, id]);
    }
    modules.set(id, mod);
    for (const imp of mod.imports) {
      for (const [name] of imp.named) requireExport(id, imp.spec, name);
      if (imp.default) requireExport(id, imp.spec, 'default');
    }
    for (const ex of mod.exports) if (ex.from && ex.imported) requireExport(id, ex.from, ex.imported);
    order.push(id);
  };
  for (const id of entryIds) visit(id, []);

  const ref = (id) => `__wf_m${order.indexOf(id)}`;
  const isIdentifier = (name) => /^[A-Za-z_$][\w$]*$/.test(name);
  const key = (name) => (isIdentifier(name) ? name : JSON.stringify(name));
  const member = (name) => (isIdentifier(name) ? `.${name}` : `[${JSON.stringify(name)}]`);
  const warnings = [];
  let code = '';
  for (const id of order) {
    const mod = modules.get(id);
    warnings.push(...mod.warnings);
    const head = [];
    for (const imp of mod.imports) {
      if (imp.reexport) continue;
      const dep = ref(mod.deps.get(imp.spec));
      if (imp.default) head.push(`const ${imp.default} = ${dep}.default;`);
      if (imp.namespace) head.push(`const ${imp.namespace} = ${dep};`);
      if (imp.named.length) {
        head.push(`const { ${imp.named.map(([from, to]) => (from === to ? from : `${key(from)}: ${to}`)).join(', ')} } = ${dep};`);
      }
    }
    const getters = new Map();
    const add = (name, expression) => {
      if (getters.has(name)) throw new BuildError(`${id}: "${name}" is exported more than once`);
      getters.set(name, `get ${key(name)}() { return ${expression}; }`);
    };
    for (const ex of mod.exports) {
      const dep = ex.from ? mod.deps.get(ex.from) : null;
      if (ex.star) {
        for (const name of exportNames(dep)) if (name !== 'default' && !getters.has(name)) add(name, ref(dep) + member(name));
      } else if (ex.from) {
        add(ex.name, ex.namespace ? ref(dep) : ref(dep) + member(ex.imported));
      } else {
        add(ex.name, ex.local);
      }
    }
    const [open, close] = mod.topLevelAwait ? ['await (async () => {', '})();'] : ['(() => {', '})();'];
    code += `// ---- ${id} ----\nconst ${ref(id)} = ${open}\n${head.join('\n')}\n${mod.code}\n`
      + `return Object.freeze({ __proto__: null, ${[...getters.values()].join(', ')} });\n${close}\n`;
  }
  return { code, order, warnings };
}

// ---------- inlining into HTML ----------

/** Make script text safe inside a <script> element without changing what it means. */
function escapeInlineScript(code) {
  const closed = code.replace(/<\/(script)/gi, '<\\/$1');
  return closed.includes('<!--') ? closed.replace(/<!--/g, '<\\!--') : closed;
}

/** JSON only has "<" inside strings, so a blanket escape is safe; U+2028/2029 are escaped for old parsers. */
function escapeJsonForHtml(json) {
  return json.replace(/</g, '\\u003C').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function checkClassicSyntax(code, label) {
  try {
    new vm.Script(code, { filename: label });
  } catch (error) {
    throw new BuildError(`${label} does not parse after inlining: ${error.message}`);
  }
}

function checkModuleSyntax(code, label) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wayfound-check-'));
  try {
    const file = path.join(dir, 'bundle.mjs');
    writeFileSync(file, code);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new BuildError(`${label} does not parse:\n${result.stderr.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Evaluate a bundled module with no dependencies in Node and hand back its exports. */
async function evaluateBundle(code, exportRef) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wayfound-run-'));
  try {
    const file = path.join(dir, 'bundle.mjs');
    writeFileSync(file, exportRef ? `${code}\nexport default ${exportRef};\n` : code);
    return (await import(pathToFileURL(file).href)).default;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function buildOffline({ root = ROOT, out = 'Wayfound.html', data = 'data', smoke = true } = {}) {
  const warnings = [];
  const absolute = (rel) => path.join(root, rel);
  const readText = (rel, wantedBy = 'index.html') => {
    if (!existsSync(absolute(rel))) throw new BuildError(`${wantedBy} needs ${rel}, which does not exist`);
    return readFileSync(absolute(rel), 'utf8');
  };
  const attr = (tag, name) => {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return match ? match[1] ?? match[2] ?? match[3] : null;
  };
  const isExternal = (url) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url);
  const local = (url) => url.replace(/[?#].*$/, '').replace(/^\.?\//, '');
  const dataUri = (rel, wantedBy) => {
    const mime = MIME[path.extname(rel).toLowerCase()];
    if (!mime) throw new BuildError(`${wantedBy} references ${rel}; add its type to MIME in tools/build_offline.mjs`);
    if (!existsSync(absolute(rel))) throw new BuildError(`${wantedBy} references ${rel}, which does not exist`);
    return `data:${mime};base64,${readFileSync(absolute(rel)).toString('base64')}`;
  };
  const inlineCss = (rel) => {
    const css = readText(rel);
    if (/@import\b/.test(css)) throw new BuildError(`${rel} uses @import, which the offline build does not follow`);
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote, url) => {
      if (/^(data:|#|about:)/i.test(url)) return whole;
      if (isExternal(url)) {
        warnings.push(`${rel} references ${url}, which will not load offline`);
        return whole;
      }
      return `url("${dataUri(path.posix.normalize(path.posix.join(path.posix.dirname(rel), local(url))), rel)}")`;
    }).replace(/<\/(style)/gi, '<\\/$1');
  };

  let html = readText('index.html', 'the offline build');
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href || href.startsWith('data:')) return tag;
    if (isExternal(href)) {
      if (!/stylesheet|preconnect|dns-prefetch|preload|prefetch/.test(rel)) return tag;
      warnings.push(`dropped <link rel="${rel}" href="${href}">: the offline file makes no network requests`);
      return '';
    }
    if (rel.split(/\s+/).includes('stylesheet')) return `<style data-source="${href}">\n${inlineCss(local(href))}\n</style>`;
    if (rel.includes('icon')) return tag.replace(href, () => dataUri(local(href), 'index.html'));
    return /preload|prefetch|manifest/.test(rel) ? '' : tag;
  });

  const entries = [];
  const inlineModules = new Map();
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (whole, attrs, body) => {
    const tag = `<script${attrs}>`;
    const type = (attr(tag, 'type') || '').toLowerCase();
    const src = attr(tag, 'src');
    if (type === 'importmap') throw new BuildError('index.html uses an import map, which the offline bundler does not support');
    if (src && isExternal(src)) {
      throw new BuildError(`index.html loads ${src}; the offline file cannot fetch scripts. Vendor it under vendor/.`);
    }
    if (type === 'module') {
      const id = src ? local(src) : `index.html#module-${entries.length + 1}`;
      if (!src) inlineModules.set(id, body);
      entries.push(id);
      return entries.length === 1 ? MODULE_SLOT : '';
    }
    if (!src || (type && !/^(text|application)\/(java|ecma)script$/.test(type))) return whole;
    const code = escapeInlineScript(readText(local(src)));
    checkClassicSyntax(code, src);
    return `<script data-source="${src}">\n${code}\n</script>`;
  });
  if (!entries.length) throw new BuildError('index.html has no <script type="module">, so there is nothing to bundle');

  // Every campus in the data folder is embedded, keyed by file name: data/waterloo.json -> "waterloo".
  const dataFiles = existsSync(absolute(data)) ? readdirSync(absolute(data)).filter((name) => name.endsWith('.json')).sort() : [];
  if (!dataFiles.length) throw new BuildError(`${data}/ holds no campus datasets (*.json)`);
  const datasets = {};
  for (const name of dataFiles) {
    const rel = `${data}/${name}`;
    let dataset;
    try {
      dataset = JSON.parse(readText(rel, 'the offline build'));
    } catch (error) {
      if (error instanceof BuildError) throw error;
      throw new BuildError(`${rel} is not valid JSON: ${error.message}`);
    }
    if (!dataset?.net || !Array.isArray(dataset.places)) {
      throw new BuildError(`${rel} does not look like a Wayfound dataset (expected "net" and "places")`);
    }
    datasets[path.basename(name, '.json')] = dataset;
  }

  const readModule = (id, importer) => inlineModules.get(id) ?? readText(id, importer || 'index.html');
  const bundle = bundleModules(entries, readModule);
  warnings.push(...bundle.warnings);
  const moduleCode = escapeInlineScript(bundle.code);
  checkModuleSyntax(moduleCode, 'the module bundle');

  // The engine has no DOM dependencies, so the bundled copy can be run here against the real datasets.
  const engineId = bundle.order.find((id) => /(^|\/)engine\.js$/.test(id));
  if (smoke && engineId) {
    const engineBundle = bundleModules([engineId], readModule);
    const engine = await evaluateBundle(engineBundle.code, `__wf_m${engineBundle.order.indexOf(engineId)}`);
    if (typeof engine.createCampus !== 'function') {
      warnings.push(`${engineId} does not export createCampus, so the bundled engine was not exercised`);
    } else {
      for (const [id, dataset] of Object.entries(datasets)) {
        try {
          const campus = engine.createCampus(dataset);
          if (!campus || typeof campus !== 'object') throw new Error('createCampus did not return a campus object');
        } catch (error) {
          throw new BuildError(`the bundled ${engineId} failed on ${data}/${id}.json: ${error.stack || error.message}`);
        }
      }
    }
  }

  const dataBlock = `<script type="application/json" id="wayfound-data">${escapeJsonForHtml(JSON.stringify(datasets))}</script>\n`
    + '<script>window.WAYFOUND_DATA = JSON.parse(document.getElementById("wayfound-data").textContent);</script>';
  html = html.replace(MODULE_SLOT, () => `${dataBlock}\n<script type="module">\n${moduleCode}\n</script>`);
  const stamp = `<!-- Wayfound offline build. Generated by tools/build_offline.mjs from index.html; edit the sources, not this file. -->`;
  html = /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^\s*<!doctype[^>]*>/i, (doctype) => `${doctype}\n${stamp}`) : `${stamp}\n${html}`;

  const leftover = /<script\b[^>]*\bsrc\s*=|<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.exec(html);
  if (leftover) throw new BuildError(`the offline file still loads an external resource: ${leftover[0]}`);
  writeFileSync(absolute(out), html);
  return { out: absolute(out), bytes: Buffer.byteLength(html), modules: bundle.order, campuses: Object.keys(datasets), warnings, html };
}

// ---------- self-test ----------

const FIXTURES = {
  'src/engine.js': [
    'export const KIND = { steps: 5 }, FLAG = { ramp: 64 };',
    '// export const fake = 1;',
    "/* import { nope } from './nope.js'; */",
    'const hidden = 3;',
    "const KINDS = 'engine-private';",
    'export function createCampus(data) {',
    '  const text = `import x from \'y\'; ${data.places.length > 0 ? "export { a }" : \'}\'} done`;',
    '  return { places: data.places.length, text, kinds: KINDS };',
    '}',
    "export async function later() { return 'later'; }",
    'export class Graph { size() { return /[{}\'"`]/.test(\'}\') ? 1 : 0; } }',
    'export { hidden as visible };',
    "export default function named() { return 'default-named'; }",
  ].join('\n'),
  'src/map3d.js': [
    "import { KIND, visible as v } from './engine.js';",
    "import * as engine from './engine.js';",
    "import named from './engine.js';",
    "const KINDS = 'map-private';",
    'export const createMap3D = async () => ({',
    "  steps: KIND.steps, v, def: named(), ns: Object.keys(engine).sort().join(','), kinds: KINDS,",
    '});',
    'export let counter = 0',
    'counter += 1',
    "export { later } from './engine.js';",
  ].join('\n'),
  'src/util/extra.js': "export * from '../engine.js';\nexport default 42;\n",
  'src/app.js': [
    'import {',
    '  createCampus,',
    '  FLAG as F,',
    "} from './engine.js'",
    "import { createMap3D, later, counter } from './map3d.js';",
    "import answer, { Graph } from './util/extra.js';",
    "const KINDS = 'app-private';",
    'const map = await createMap3D();',
    'globalThis.__wfSelfTest = {',
    '  campus: createCampus(globalThis.WAYFOUND_DATA?.uoft || { places: [1, 2] }),',
    '  ramp: F.ramp, map, later: await later(), counter, answer,',
    '  graph: new Graph().size(), meta: typeof import.meta.url, kinds: KINDS,',
    '};',
  ].join('\n'),
};

const EXPECTED = {
  campus: { places: 2, text: "import x from 'y'; export { a } done", kinds: 'engine-private' },
  ramp: 64,
  map: { steps: 5, v: 3, def: 'default-named', ns: 'FLAG,Graph,KIND,createCampus,default,later,visible', kinds: 'map-private' },
  later: 'later', counter: 1, answer: 42, graph: 1, meta: 'string', kinds: 'app-private',
};

const REJECTED = [
  ['dynamic import', { 'a.js': "const m = await import('./b.js');", 'b.js': 'export const x = 1;' }, /dynamic import/],
  ['bare specifier', { 'a.js': "import maplibregl from 'maplibre-gl';" }, /cannot bundle the import of "maplibre-gl"/],
  ['missing export', { 'a.js': "import { nope } from './b.js';", 'b.js': 'export const x = 1;' }, /imports "nope".*only exports: x/],
  ['missing default', { 'a.js': "import b from './b.js';", 'b.js': 'export const x = 1;' }, /imports "default"/],
  ['destructuring export', { 'a.js': 'const o = { p: 1 };\nexport const { p } = o;' }, /destructuring/],
  ['circular import', { 'a.js': "import { y } from './b.js';\nexport const x = 1;", 'b.js': "import { x } from './a.js';\nexport const y = 2;" }, /circular import/],
  ['import attributes', { 'a.js': "import data from './b.js' with { type: 'json' };", 'b.js': 'export default 1;' }, /import attributes/],
  ['duplicate export', { 'a.js': 'export const x = 1;\nconst y = 2;\nexport { y as x };' }, /exported more than once/],
  ['missing module', { 'a.js': "import { x } from './gone.js';" }, /does not exist/],
];

async function selfTest() {
  let checks = 0;
  const ok = (condition, label) => {
    assert.ok(condition, label);
    checks++;
  };
  const memory = (files) => (id) => {
    if (!(id in files)) throw new BuildError(`${id} does not exist`);
    return files[id];
  };

  // 1. The bundle behaves like the original modules.
  const bundle = bundleModules(['src/app.js'], memory(FIXTURES));
  assert.deepEqual(bundle.order, ['src/engine.js', 'src/map3d.js', 'src/util/extra.js', 'src/app.js']);
  checks++;
  ok(bundle.warnings.some((w) => w.includes('export let')), 'export let is reported');
  ok(!/^\s*(import|export)\s/m.test(bundle.code.replace(/`[^`]*`/g, '').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), 'no module syntax is left in code');
  checkModuleSyntax(bundle.code, 'fixture bundle');
  delete globalThis.__wfSelfTest;
  await evaluateBundle(bundle.code);
  assert.deepEqual(globalThis.__wfSelfTest, EXPECTED);
  checks++;

  // 2. Forms the bundler cannot handle stop the build with a specific message.
  for (const [label, files, pattern] of REJECTED) {
    assert.throws(() => bundleModules(['a.js'], memory(files)), (error) => error instanceof BuildError && pattern.test(error.message), label);
    checks++;
  }

  // 3. Escaping keeps hostile text inside its element and round-trips.
  const hostile = 'x = "</script><!-- </SCRIPT>";';
  const escaped = escapeInlineScript(hostile);
  ok(!/<\/script/i.test(escaped) && !escaped.includes('<!--'), 'script text cannot close its element');
  ok(vm.runInNewContext(`${escaped} x`) === '</script><!-- </SCRIPT>', 'escaped script keeps its meaning');
  const tricky = { name: '</script><!-- \u2028\u2029 & "quoted"' };
  const json = escapeJsonForHtml(JSON.stringify(tricky));
  ok(!json.includes('<') && !/[\u2028\u2029]/.test(json), 'embedded JSON has no raw <, U+2028 or U+2029');
  assert.deepEqual(JSON.parse(json), tricky);
  checks++;

  // 4. A whole project builds into one file with nothing left to fetch.
  const root = mkdtempSync(path.join(tmpdir(), 'wayfound-selftest-'));
  try {
    const dataset = { net: { nodes: [] }, places: [{ name: '</script><!-- \u2028 first' }, { name: 'second' }] };
    const project = {
      ...FIXTURES,
      'index.html': [
        '<!doctype html>', '<html lang="en"><head><meta charset="utf-8"><title>Fixture</title>',
        '<link rel="preconnect" href="https://fonts.example.com">',
        '<link rel="icon" href="src/dot.svg">',
        '<link rel="stylesheet" href="vendor/maplibre-gl.css">', '<link rel="stylesheet" href="./src/styles.css?v=2">',
        '</head><body><div id="app"></div>',
        '<script src="vendor/maplibre-gl.js"></script>', '<script type="module" src="src/app.js"></script>',
        '</body></html>',
      ].join('\n'),
      'src/styles.css': 'body { background: url("./dot.svg"); }\n.a::after { content: "</style>"; }\n',
      'src/dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      'vendor/maplibre-gl.css': '.maplibregl-map { position: relative; }\n',
      'vendor/maplibre-gl.js': 'window.maplibregl = { version: "stub", note: "</script><!-- stays in a string" };\n',
      'data/uoft.json': JSON.stringify(dataset),
    };
    for (const [rel, text] of Object.entries(project)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    const built = await buildOffline({ root, out: 'Wayfound.html' });
    const { html } = built;
    ok(existsSync(built.out) && built.bytes === Buffer.byteLength(readFileSync(built.out)), 'output file is written');
    ok(!/<script\b[^>]*\bsrc=/i.test(html) && !/<link\b[^>]*stylesheet/i.test(html), 'no external scripts or stylesheets remain');
    ok(!html.includes('fonts.example.com') && built.warnings.some((w) => w.includes('fonts.example.com')), 'network link is dropped and reported');
    ok((html.match(/<script\b/gi) || []).length === (html.match(/<\/script>/gi) || []).length, 'script elements are balanced');
    ok((html.match(/<!--/g) || []).length === 1, 'only the build stamp is an HTML comment');
    ok((html.match(/data:image\/svg\+xml;base64,/g) || []).length === 2, 'icon and CSS image are inlined');
    ok(html.includes('content: "<\\/style>"'), 'CSS cannot close its element');
    const embedded = /<script type="application\/json" id="wayfound-data">([\s\S]*?)<\/script>/.exec(html)[1];
    assert.deepEqual(JSON.parse(embedded), { uoft: dataset });
    checks++;
    const moduleScript = /<script type="module">\n([\s\S]*?)\n<\/script>/.exec(html)[1];
    delete globalThis.__wfSelfTest;
    globalThis.WAYFOUND_DATA = JSON.parse(embedded);
    await evaluateBundle(moduleScript);
    assert.deepEqual(globalThis.__wfSelfTest, EXPECTED);
    checks++;
    delete globalThis.WAYFOUND_DATA;

    writeFileSync(path.join(root, 'data/uoft.json'), '{"places":[]}');
    await assert.rejects(buildOffline({ root }), /does not look like a Wayfound dataset/);
    checks++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`build_offline self-test passed (${checks} checks)`);
}

// ---------- command line ----------

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
try {
  if (args.includes('--self-test')) {
    await selfTest();
  } else {
    const built = await buildOffline({
      out: option('--out', 'Wayfound.html'), data: option('--data', 'data'), smoke: !args.includes('--skip-smoke'),
    });
    for (const warning of built.warnings) console.warn(`warning: ${warning}`);
    console.log(`bundled modules: ${built.modules.join(' -> ')}`);
    console.log(`embedded campuses: ${built.campuses.join(', ')}`);
    console.log(`wrote ${path.relative(process.cwd(), built.out)} (${(built.bytes / 1e6).toFixed(2)} MB). Open it by double-click; it needs no server or network.`);
  }
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  console.error(`build_offline: ${error.message}`);
  process.exit(1);
}
