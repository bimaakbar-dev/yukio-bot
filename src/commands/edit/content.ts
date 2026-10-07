// src/commands/edit/content.ts

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pisah markdown jadi frontmatter + body */
export function splitContent(content: string): {
  frontmatter: string;
  body: string;
} {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: '', body: content };
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}

/** Rebuild markdown dari frontmatter + body */
export function joinContent(frontmatter: string, body: string): string {
  const fm = frontmatter.replace(/^\n+|\n+$/g, '');
  const b = body.replace(/^\n+|\n+$/g, '');
  return `---\n${fm}\n---\n\n${b}\n`;
}

/** Set field di frontmatter. Support dotted (stats.score). */
function setFrontmatterField(
  frontmatter: string,
  field: string,
  value: string
): string {
  const lines = frontmatter.split('\n');

  // Nested: stats.score
  if (field.includes('.')) {
    const [parent, child] = field.split('.');
    if (!parent || !child) return frontmatter;

    const parentRe = new RegExp(`^${escapeRegex(parent)}:\\s*$`);
    let parentIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (parentRe.test(lines[i] ?? '')) {
        parentIdx = i;
        break;
      }
    }

    if (parentIdx === -1) {
      lines.push(`${parent}:`);
      lines.push(`  ${child}: ${value}`);
      return lines.join('\n');
    }

    for (let i = parentIdx + 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!/^\s+/.test(line)) break;
      const childRe = new RegExp(`^(\\s+)${escapeRegex(child)}:\\s*.*$`);
      if (childRe.test(line)) {
        const m = line.match(childRe);
        lines[i] = `${m?.[1] ?? '  '}${child}: ${value}`;
        return lines.join('\n');
      }
    }

    let insertIdx = parentIdx + 1;
    while (insertIdx < lines.length && /^\s+/.test(lines[insertIdx] ?? '')) {
      insertIdx++;
    }
    lines.splice(insertIdx, 0, `  ${child}: ${value}`);
    return lines.join('\n');
  }

  // Top-level
  const re = new RegExp(`^${escapeRegex(field)}:\\s*.*$`, 'm');
  if (re.test(frontmatter)) {
    return frontmatter.replace(re, `${field}: ${value}`);
  }
  return frontmatter + '\n' + `${field}: ${value}`;
}

/** Extract nilai field dari frontmatter (buat preview current). */
export function getFrontmatterField(
  frontmatter: string,
  field: string
): string | null {
  if (field === 'body') return null;

  if (field.includes('.')) {
    const [parent, child] = field.split('.');
    if (!parent || !child) return null;
    const lines = frontmatter.split('\n');
    let inParent = false;
    for (const line of lines) {
      if (new RegExp(`^${escapeRegex(parent)}:\\s*$`).test(line)) {
        inParent = true;
        continue;
      }
      if (inParent) {
        if (!/^\s+/.test(line)) break;
        const m = line.match(
          new RegExp(`^\\s+${escapeRegex(child)}:\\s*(.*)$`)
        );
        if (m) return m[1] ?? '';
      }
    }
    return null;
  }

  const re = new RegExp(`^${escapeRegex(field)}:\\s*(.*)$`, 'm');
  const m = frontmatter.match(re);
  return m ? (m[1] ?? '') : null;
}

/** Strip quotes dari value YAML. */
export function stripYamlQuotes(v: string): string {
  const t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Wrap value YAML kalau perlu quotes. */
export function yamlSafeString(v: string): string {
  const t = v.replace(/\n/g, ' ').trim();
  if (t === '') return '""';
  if (/[:#&*!|>'"%@`{}\[\],]/.test(t) || /^\d/.test(t)) {
    return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return t;
}

/** Apply semua edits ke content. */
export function applyEdits(
  content: string,
  edits: Record<string, string>
): string {
  const { frontmatter, body } = splitContent(content);
  let fm = frontmatter;
  let bd = body;

  for (const [field, rawValue] of Object.entries(edits)) {
    if (field === 'body') {
      bd = rawValue;
      continue;
    }

    // genre (qimochi) → inline array
    if (field === 'genre') {
      const arr = rawValue
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      fm = setFrontmatterField(fm, field, `[${arr.join(', ')}]`);
      continue;
    }

    // genres (yukionime) → bullets
    if (field === 'genres') {
      const arr = rawValue
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const lines = fm.split('\n');
      const out: string[] = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i] ?? '';
        if (/^genres:\s*$/.test(line)) {
          i++;
          while (i < lines.length && /^\s+-/.test(lines[i] ?? '')) i++;
          continue;
        }
        if (/^genres:\s*\[\s*\]\s*$/.test(line)) {
          i++;
          continue;
        }
        out.push(line);
        i++;
      }
      if (arr.length > 0) {
        out.push('genres:');
        for (const g of arr) out.push(`  - ${g}`);
      } else {
        out.push('genres: []');
      }
      fm = out.join('\n');
      continue;
    }

    // Normal field
    const value = yamlSafeString(rawValue);
    fm = setFrontmatterField(fm, field, value);
  }

  return joinContent(fm, bd);
}