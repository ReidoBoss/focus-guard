// Minimal reader/writer for Valve's KeyValues (.vdf) files.
// Entries are kept as ordered [key, value] pairs and strings keep their escapes,
// so parse() followed by stringify() reproduces Steam's own formatting.

function parse(text) {
  const root = [];
  const stack = [root];
  let key = null;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "{") {
      const obj = [];
      stack[stack.length - 1].push([key, obj]);
      stack.push(obj);
      key = null;
      i++;
    } else if (c === "}") {
      if (stack.length > 1) stack.pop();
      i++;
    } else {
      let token = "";
      if (c === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') {
          if (text[j] === "\\" && j + 1 < text.length) {
            token += text[j] + text[j + 1];
            j += 2;
          } else {
            token += text[j++];
          }
        }
        i = j + 1;
      } else {
        let j = i;
        while (j < text.length && !/[\s{}"]/.test(text[j])) j++;
        token = text.slice(i, j);
        i = j;
      }
      if (key === null) {
        key = token;
      } else {
        stack[stack.length - 1].push([key, token]);
        key = null;
      }
    }
  }
  return root;
}

function stringify(entries, depth = 0) {
  const tab = "\t".repeat(depth);
  return entries
    .map(([k, v]) =>
      Array.isArray(v) ? `${tab}"${k}"\n${tab}{\n${stringify(v, depth + 1)}${tab}}\n` : `${tab}"${k}"\t\t"${v}"\n`
    )
    .join("");
}

// Case-insensitive lookup, since Steam is inconsistent ("apps" vs "Apps").
function find(entries, key) {
  return entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
}

function ensureObject(entries, key) {
  const hit = find(entries, key);
  if (hit && Array.isArray(hit[1])) return hit[1];
  const obj = [];
  entries.push([key, obj]);
  return obj;
}

module.exports = { parse, stringify, find, ensureObject };
