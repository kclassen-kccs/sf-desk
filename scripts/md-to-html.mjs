// Turns one of SF Desk's Markdown docs into a standalone HTML page, for the Mac disk image.
// Covers what the docs use: headings, paragraphs, nested lists, fenced code, tables, bold, italics,
// inline code and links. No dependencies.
//   node scripts/md-to-html.mjs <in.md> <out.html> [title] [links.json]
// links.json maps Markdown files to the pages they become, e.g. {"OUTLOOK.md": "Outlook Add-in.html"};
// links to other files point at GitHub.

import fs from 'node:fs';
import path from 'node:path';

const [input, output, titleArg, linksFile] = process.argv.slice(2);
const links = linksFile ? JSON.parse(fs.readFileSync(linksFile, 'utf8')) : {};
const REPO = 'https://github.com/kclassen-kccs/sf-desk/blob/main/';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/ /g, '-');

function href(url) {
  if (/^(https?:|mailto:|#)/.test(url)) return url;
  const [file, anchor] = url.split('#');
  const page = links[path.basename(file)];
  return page ? encodeURI(page) + (anchor ? '#' + anchor : '') : REPO + url;
}

function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${href(u.replace(/&amp;/g, '&'))}">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:])/g, '$1<a href="$2">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const lines = fs.readFileSync(input, 'utf8').replace(/\r/g, '').split('\n');
const out = [];
let para = [];
const lists = []; // open lists: { indent, tag }
let title = titleArg;

const flushPara = () => {
  if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
  para = [];
};
const closeLists = (indent = -1) => {
  while (lists.length && lists.at(-1).indent > indent) out.push(`</li></${lists.pop().tag}>`);
};
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const fence = line.match(/^(\s*)```/);
  if (fence) {
    flushPara();
    const code = [];
    while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i].slice(fence[1].length));
    out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    continue;
  }
  const h = line.match(/^(#{1,4})\s+(.*)/);
  if (h) {
    flushPara(); closeLists();
    const text = inline(h[2]);
    title ||= h[2];
    out.push(`<h${h[1].length} id="${slug(h[2])}">${text}</h${h[1].length}>`);
    continue;
  }
  if (/^\|/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
    flushPara(); closeLists();
    const head = cells(line);
    const rows = [];
    for (i += 2; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
    i--;
    out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
    continue;
  }
  const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
  if (li) {
    flushPara();
    const indent = li[1].length, tag = /\d/.test(li[2]) ? 'ol' : 'ul';
    closeLists(indent);
    if (lists.length && lists.at(-1).indent === indent) {
      out.push('</li><li>');
    } else {
      out.push(`<${tag}><li>`);
      lists.push({ indent, tag });
    }
    para.push(li[3]);
    continue;
  }
  if (!line.trim()) {
    flushPara();
    // A list ends at a blank line unless the next text is indented under it.
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (lists.length && (!next || !/^\s+\S/.test(next))) closeLists();
    continue;
  }
  if (lists.length && /^\s+\S/.test(line) && !para.length) out.push('<br>');
  para.push(line.trim());
}
flushPara();
closeLists();

fs.writeFileSync(output, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || 'SF Desk')}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff; --code: #f2f2f5; --line: #d2d2d7; --link: #0071ce; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #1c1c1e; --code: #2c2c2e; --line: #3a3a3c; --link: #4da3ff; } }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; color: var(--fg); background: var(--bg);
         max-width: 780px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 30px; margin: 0 0 16px; } h2 { font-size: 22px; margin: 36px 0 10px; padding-top: 12px; border-top: 1px solid var(--line); }
  h3 { font-size: 18px; margin: 28px 0 8px; } h4 { font-size: 16px; margin: 20px 0 6px; }
  a { color: var(--link); } code { font: 13px ui-monospace, Menlo, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--code); padding: 12px 14px; border-radius: 8px; overflow-x: auto; } pre code { padding: 0; background: none; }
  li { margin: 4px 0; } table { border-collapse: collapse; margin: 12px 0; font-size: 14px; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
</style></head><body>
${out.join('\n')}
</body></html>
`);
